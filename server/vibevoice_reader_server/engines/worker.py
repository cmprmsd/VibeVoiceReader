"""An engine that runs in a separate process and virtual environment.

The registry treats it like any other engine; load() starts the process and
unload() kills it, which is also how VRAM is guaranteed to be released.
"""
from __future__ import annotations

import json
import os
import select
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional

from ..config import REPO_ROOT
from ..voices import VoiceInfo
from ..workers.protocol import FRAME_AUDIO, FRAME_JSON, read_frame
from .base import BaseEngine, Event, normalize_text


class WorkerEngine(BaseEngine):
    def __init__(
        self,
        engine_id: str,
        label: str,
        description: str,
        module: str,
        python: Path,
        vram_gb: float,
        env: Optional[Dict[str, str]] = None,
        default_cfg_scale: float = 1.0,
        default_steps: int = 0,
        stochastic: bool = True,
        static_voices: Optional[Callable[[], List[VoiceInfo]]] = None,
    ) -> None:
        super().__init__()
        self.id = engine_id
        self.label = label
        self.description = description
        self.module = module
        self.python = python
        self.vram_gb = vram_gb
        self.env = env or {}
        self.default_cfg_scale = default_cfg_scale
        self.default_steps = default_steps
        self.stochastic = stochastic
        self._static_voices = static_voices
        self.proc: Optional[subprocess.Popen] = None
        self._voices: Dict[str, VoiceInfo] = {}
        self._default_voice: Optional[str] = None
        self._io_lock = threading.Lock()

    @property
    def available(self) -> bool:
        return self.python.exists()

    @property
    def voices(self) -> Dict[str, VoiceInfo]:
        """The worker's list once loaded; before that a static list so the picker is usable."""
        if not self.loaded and self._static_voices:
            try:
                self._voices = {v.id: v for v in self._static_voices()}
            except Exception:  # noqa: BLE001
                pass
        return self._voices

    @property
    def default_voice(self) -> Optional[str]:
        return self._default_voice or next(iter(self.voices), None)

    def info(self) -> Dict[str, Any]:
        d = super().info()
        d["available"] = self.available
        if not self.available:
            d["description"] += f" (not installed: run `make engine-{self.id}`)"
        return d

    # ---------------------------------------------------------------- process
    def load(self) -> None:
        if not self.available:
            raise RuntimeError(f"engine {self.id} is not installed (missing {self.python}); run `make engine-{self.id}`")
        t0 = time.time()
        env = {**os.environ, "PYTHONPATH": str(REPO_ROOT / "server"), "PYTHONUNBUFFERED": "1", **self.env}
        self.proc = subprocess.Popen(
            [str(self.python), "-m", self.module],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,  # worker logs go to the server's stderr
            env=env,
            cwd=str(REPO_ROOT),
        )
        reply = self._request({"cmd": "load"})
        if not reply.get("ok"):
            self.unload()
            raise RuntimeError(f"{self.id} worker failed to load: {reply.get('error')}")
        self.sample_rate = int(reply.get("sample_rate", 24000))
        self._voices = {}
        for v in reply.get("voices", []):
            info = VoiceInfo(v["id"], v["name"], v.get("lang", "en"), v.get("lang_label", "English"), v.get("gender", "unknown"), bool(v.get("experimental")), Path())
            self._voices[info.id] = info
        self._default_voice = reply.get("default")
        self.loaded = True
        self.device = reply.get("device", "?")
        self.attn_impl = reply.get("attn", "n/a")
        print(f"[engine:{self.id}] worker ready in {time.time() - t0:.1f}s, {len(self._voices)} voices")

    def unload(self) -> None:
        p = self.proc
        self.proc = None
        self.loaded = False
        if p is None:
            return
        try:
            if p.stdin:
                p.stdin.write(b'{"cmd": "quit"}\n')
                p.stdin.flush()
            p.wait(timeout=5)
        except Exception:  # noqa: BLE001
            p.kill()
        print(f"[engine:{self.id}] worker stopped")

    def _send(self, obj: Dict[str, Any]) -> None:
        assert self.proc and self.proc.stdin
        self.proc.stdin.write((json.dumps(obj) + "\n").encode())
        self.proc.stdin.flush()

    def _wait_readable(self, timeout: float) -> bool:
        """False if the worker produced nothing for `timeout` seconds (hung or prompting)."""
        assert self.proc and self.proc.stdout
        ready, _, _ = select.select([self.proc.stdout], [], [], timeout)
        return bool(ready)

    def _request(self, obj: Dict[str, Any], timeout: float = 900.0) -> Dict[str, Any]:
        """Send a command and read one JSON frame."""
        with self._io_lock:
            self._send(obj)
            assert self.proc and self.proc.stdout
            while True:
                if not self._wait_readable(timeout):
                    return {"ok": False, "error": f"worker did not answer within {int(timeout)} s"}
                fr = read_frame(self.proc.stdout)
                if fr is None:
                    return {"ok": False, "error": "worker exited"}
                kind, payload = fr
                if kind == FRAME_JSON:
                    return json.loads(payload)

    # ------------------------------------------------------------- synthesis
    def synthesize(
        self,
        text: str,
        voice_id: Optional[str] = None,
        cfg_scale: Optional[float] = None,
        inference_steps: Optional[int] = None,
        stop_event: Optional[threading.Event] = None,
        lang: Optional[str] = None,
    ) -> Iterator[Event]:
        if not self.loaded or not self.proc or not self.proc.stdout:
            raise RuntimeError("engine not loaded")
        text = normalize_text(text).strip()
        if not text:
            yield Event("done", {"samples": 0, "seconds": 0.0})
            return
        req_id = f"{time.time_ns()}"
        stop = stop_event or threading.Event()
        req = {"cmd": "synth", "id": req_id, "text": text, "voice": self.resolve_voice(voice_id), "cfg_scale": cfg_scale, "inference_steps": inference_steps, "lang": lang}
        with self._io_lock:
            self._send(req)
            t0 = time.time()
            samples = 0
            stop_sent = False
            while True:
                if stop.is_set() and not stop_sent:
                    self._send({"cmd": "stop", "id": req_id})
                    stop_sent = True
                if not self._wait_readable(300.0):
                    yield Event("error", {"message": f"{self.id} worker produced no audio for 5 minutes"})
                    self.unload()
                    return
                fr = read_frame(self.proc.stdout)
                if fr is None:
                    yield Event("error", {"message": f"{self.id} worker exited"})
                    self.unload()
                    return
                kind, payload = fr
                if kind == FRAME_AUDIO:
                    if not stop.is_set():
                        samples += len(payload) // 2
                        yield Event("audio", {"samples": samples}, audio=payload)
                    continue
                ev = json.loads(payload)
                name = ev.pop("event", "")
                if name == "done":
                    seconds = samples / self.sample_rate
                    elapsed = time.time() - t0
                    yield Event("done", {"samples": samples, "seconds": round(seconds, 3), "elapsed_ms": int(elapsed * 1000), "rtf": round(elapsed / seconds, 3) if seconds else None, "stopped": stop.is_set(), **ev})
                    return
                if name == "error":
                    yield Event("error", ev)
                    return
                yield Event(name, ev)
