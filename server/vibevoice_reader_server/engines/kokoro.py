"""Kokoro-82M: tiny, fast, stable; no cloning.  Runs in-process."""
from __future__ import annotations

import importlib.util
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterator, Optional

import numpy as np
import torch

from ..voices import VoiceInfo
from .base import BaseEngine, Event, normalize_text, pcm16_bytes, release_gpu, resolve_device

# voice id -> (name, language tag, label, gender).  Prefix letter = Kokoro lang code.
LANGS = {"a": ("en-US", "English (US)"), "b": ("en-GB", "English (UK)"), "e": ("es", "Spanish"), "f": ("fr", "French"), "h": ("hi", "Hindi"), "i": ("it", "Italian"), "j": ("ja", "Japanese"), "p": ("pt-BR", "Portuguese (Brazil)"), "z": ("zh", "Mandarin")}
VOICE_IDS = [
    "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
    "ef_dora", "em_alex", "em_santa", "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola",
    "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo", "pf_dora", "pm_alex", "pm_santa",
    "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
]


class KokoroEngine(BaseEngine):
    id = "kokoro"
    label = "Kokoro 82M"
    description = "Very fast and stable, 9 languages, preset voices only (no German). ~0.5 GB VRAM or CPU."
    vram_gb = 0.5
    default_cfg_scale = 1.0
    default_steps = 0
    stochastic = False

    def __init__(self, device: str) -> None:
        super().__init__()
        self.requested_device = device
        self.available = importlib.util.find_spec("kokoro") is not None
        self._pipelines: Dict[str, Any] = {}
        self._voices: Dict[str, VoiceInfo] = {}
        for vid in VOICE_IDS:
            lang, label = LANGS[vid[0]]
            gender = "woman" if vid[1] == "f" else "man"
            self._voices[vid] = VoiceInfo(vid, vid.split("_", 1)[1].capitalize(), lang, label, gender, False, Path())

    @property
    def voices(self) -> Dict[str, VoiceInfo]:
        return self._voices

    @property
    def default_voice(self) -> Optional[str]:
        return "af_heart"

    def _pipeline(self, lang_code: str):
        if lang_code not in self._pipelines:
            from kokoro import KPipeline

            self._pipelines[lang_code] = KPipeline(lang_code=lang_code, device=self.device)
        return self._pipelines[lang_code]

    def info(self) -> Dict[str, Any]:
        d = super().info()
        if not self.available:
            d["description"] += " (not installed: run `make engine-kokoro`)"
        return d

    def load(self) -> None:
        if not self.available:
            raise RuntimeError("Kokoro is not installed on the server (run `make engine-kokoro`, which also needs espeak-ng)")
        t0 = time.time()
        self.device = resolve_device(self.requested_device)
        self._pipeline("a")  # downloads the model on first use
        self.attn_impl = "n/a"
        self.loaded = True
        print(f"[engine:{self.id}] ready in {time.time() - t0:.1f}s on {self.device}")

    def unload(self) -> None:
        with self._model_lock:
            self._pipelines.clear()
            self.loaded = False
            release_gpu()

    def synthesize(
        self,
        text: str,
        voice_id: Optional[str] = None,
        cfg_scale: Optional[float] = None,
        inference_steps: Optional[int] = None,
        stop_event: Optional[threading.Event] = None,
        lang: Optional[str] = None,
    ) -> Iterator[Event]:
        if not self.loaded:
            raise RuntimeError("engine not loaded")
        text = normalize_text(text).strip()
        if not text:
            yield Event("done", {"samples": 0, "seconds": 0.0})
            return
        voice = self.resolve_voice(voice_id)
        yield Event("meta", {"text": text, "voice": voice, "sample_rate": self.sample_rate, "tokens": 0, "offsets": [], "text_window": 0, "speech_window": 0, "model": self.id})
        stop = stop_event or threading.Event()
        t0 = time.time()
        samples = 0
        with self._model_lock:
            pipeline = self._pipeline(voice[0])
            # Split on sentence ends so audio streams per sentence instead of per paragraph.
            for result in pipeline(text, voice=voice, speed=1.0, split_pattern=r"(?<=[.!?…])\s+"):
                if stop.is_set():
                    break
                audio = result.audio
                if audio is None:
                    continue
                pcm = pcm16_bytes(audio if torch.is_tensor(audio) else np.asarray(audio))
                # stream in ~0.13 s frames like the other engines
                for i in range(0, len(pcm), 6400):
                    piece = pcm[i : i + 6400]
                    samples += len(piece) // 2
                    yield Event("audio", {"samples": samples}, audio=piece)
        seconds = samples / self.sample_rate
        elapsed = time.time() - t0
        yield Event("done", {"samples": samples, "seconds": round(seconds, 3), "elapsed_ms": int(elapsed * 1000), "rtf": round(elapsed / seconds, 3) if seconds else None, "stopped": stop.is_set()})
