"""Framing shared by the server and its worker processes.

Server -> worker (stdin): one JSON object per line.
    {"cmd": "load"}                       -> reply {"ok": true, "voices": [...], "default": id, "sample_rate": n}
    {"cmd": "synth", "id": s, "text": t, "voice": v, "cfg_scale": f, "inference_steps": n}
                                          -> stream of frames, ending with a "done" or "error" event
    {"cmd": "stop", "id": s}              -> best-effort stop of a running synth
    {"cmd": "quit"}

Worker -> server (stdout): binary frames, 1 byte type (1 = JSON, 2 = PCM16 mono
24 kHz), uint32 little-endian length, payload — the same framing the extension
receives from the HTTP endpoint.
"""
from __future__ import annotations

import json
import struct
import sys
import threading
from queue import Queue
from typing import Any, Dict, Iterator, Optional, Protocol, Union

FRAME_JSON = 1
FRAME_AUDIO = 2
SAMPLE_RATE = 24000


def frame(kind: int, payload: bytes) -> bytes:
    return struct.pack("<BI", kind, len(payload)) + payload


def frame_json(obj: Dict[str, Any]) -> bytes:
    return frame(FRAME_JSON, json.dumps(obj).encode("utf-8"))


def read_frame(stream) -> Optional[tuple[int, bytes]]:
    head = stream.read(5)
    if len(head) < 5:
        return None
    kind, length = struct.unpack("<BI", head)
    payload = stream.read(length) if length else b""
    if len(payload) < length:
        return None
    return kind, payload


class WorkerImpl(Protocol):
    """What a worker module provides."""

    sample_rate: int

    def load(self) -> Dict[str, Any]:
        """Load the model; return {"voices": [voice dicts], "default": id}."""

    def synthesize(self, req: Dict[str, Any], stop: threading.Event) -> Iterator[Union[Dict[str, Any], bytes]]:
        """Yield JSON events (dicts) and PCM16 chunks (bytes); end with a done/error event."""


def serve(impl: WorkerImpl) -> None:
    """Run the worker loop on stdin/stdout.

    Frames go to the original stdout file descriptor; everything else that the
    model libraries print (they do, e.g. sox's missing-binary banner) is sent to
    stderr by re-pointing fd 1 and sys.stdout, so it can never corrupt frames.
    """
    import os

    real_stdout = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    out = os.fdopen(real_stdout, "wb", buffering=0)
    lock = threading.Lock()

    def send(kind: int, payload: bytes) -> None:
        with lock:
            out.write(frame(kind, payload))
            out.flush()

    commands: "Queue[Dict[str, Any]]" = Queue()
    stops: Dict[str, threading.Event] = {}

    def reader() -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except json.JSONDecodeError:
                continue
            if cmd.get("cmd") == "stop":
                ev = stops.get(str(cmd.get("id")))
                if ev:
                    ev.set()
                continue
            commands.put(cmd)
        commands.put({"cmd": "quit"})

    threading.Thread(target=reader, daemon=True).start()

    while True:
        cmd = commands.get()
        kind = cmd.get("cmd")
        if kind == "quit":
            break
        if kind == "load":
            try:
                info = impl.load()
                send(FRAME_JSON, json.dumps({"ok": True, "sample_rate": impl.sample_rate, **info}).encode())
            except Exception as exc:  # noqa: BLE001
                send(FRAME_JSON, json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}).encode())
            continue
        if kind == "synth":
            req_id = str(cmd.get("id"))
            stop = threading.Event()
            stops[req_id] = stop
            try:
                for item in impl.synthesize(cmd, stop):
                    if isinstance(item, (bytes, bytearray)):
                        send(FRAME_AUDIO, bytes(item))
                    else:
                        send(FRAME_JSON, json.dumps(item).encode())
            except Exception as exc:  # noqa: BLE001
                send(FRAME_JSON, json.dumps({"event": "error", "message": f"{type(exc).__name__}: {exc}"}).encode())
            finally:
                stops.pop(req_id, None)
            continue
