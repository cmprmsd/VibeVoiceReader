"""Test the framed HTTP streaming endpoint (what the extension uses).

    python -m vibevoice_reader_server.tools.http_client --text "Hello." --out out.wav [--stop-after 3]
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
import time
import uuid
import wave

import httpx

from .ws_client import DEFAULT_TEXT


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--server", default="http://127.0.0.1:8877")
    p.add_argument("--text", default=DEFAULT_TEXT)
    p.add_argument("--voice", default=None)
    p.add_argument("--model", default=None, help="realtime | 1.5b | 7b | kokoro | qwen | moss")
    p.add_argument("--lang", default=None, help="page language tag, e.g. de")
    p.add_argument("--out", default=None)
    p.add_argument("--stop-after", type=int, default=0, help="send /tts/stop after N audio frames")
    p.add_argument("--candidates", type=int, default=1, help="best-of-N generation (server picks the cleanest take)")
    a = p.parse_args()

    req_id = str(uuid.uuid4())
    frames = bytearray()
    audio_frames = 0
    t0 = time.time()
    first = None
    buf = bytearray()
    with httpx.Client(timeout=None) as client:
        with client.stream("POST", a.server + "/tts/stream", json={"id": req_id, "text": a.text, "voice": a.voice, "candidates": a.candidates, "model": a.model, "lang": a.lang}) as r:
            print(f"http {r.status_code}, request id {r.headers.get('x-request-id')}")
            for chunk in r.iter_bytes():
                buf += chunk
                while len(buf) >= 5:
                    kind, length = struct.unpack_from("<BI", buf, 0)
                    if len(buf) < 5 + length:
                        break
                    payload = bytes(buf[5 : 5 + length])
                    del buf[: 5 + length]
                    now = time.time() - t0
                    if kind == 2:
                        audio_frames += 1
                        frames += payload
                        if first is None:
                            first = now
                            print(f"[{now:6.2f}s] first audio frame")
                        if a.stop_after and audio_frames == a.stop_after:
                            res = client.post(f"{a.server}/tts/stop/{req_id}")
                            print(f"[{now:6.2f}s] sent stop -> {res.json()}")
                    else:
                        ev = json.loads(payload)
                        if ev.get("event") in ("accepted", "queued", "done", "error", "quality", "loading", "meta"):
                            print(f"[{now:6.2f}s] {ev}")
    if a.out and frames:
        with wave.open(a.out, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(bytes(frames))
        print(f"wrote {a.out} ({len(frames)//2/24000:.2f}s)")
    sys.exit(0 if frames else 1)


if __name__ == "__main__":
    main()
