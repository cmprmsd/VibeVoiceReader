"""Tiny CLI client: sends text to /tts, prints events, writes a WAV.

    python -m vibevoice_reader_server.tools.ws_client --text "Hello there." --out out.wav
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import wave

import websockets

DEFAULT_TEXT = (
    "The upcoming Ghostwriter release brings a major UI refresh to nearly every part of the "
    "application. The new design is easier on the eyes, more accessible, and better organized."
)


async def run(args: argparse.Namespace) -> int:
    text = args.text
    if args.file:
        text = open(args.file, encoding="utf-8").read()
    req = {"text": text, "voice": args.voice, "cfg_scale": args.cfg, "inference_steps": args.steps, "model": args.model}
    frames = bytearray()
    sample_rate = 24000
    t0 = time.time()
    first_audio = None
    async with websockets.connect(args.url, max_size=None) as ws:
        await ws.send(json.dumps(req))
        async for msg in ws:
            now = time.time() - t0
            if isinstance(msg, (bytes, bytearray)):
                if first_audio is None:
                    first_audio = now
                    print(f"[{now:6.2f}s] first audio chunk ({len(msg)} bytes)")
                frames += msg
                continue
            ev = json.loads(msg)
            kind = ev.get("event")
            if kind == "meta":
                sample_rate = ev["sample_rate"]
                print(f"[{now:6.2f}s] meta: voice={ev['voice']} tokens={ev['tokens']} offsets={len(ev['offsets'])} steps={ev['inference_steps']}")
            elif kind == "progress":
                if args.verbose:
                    print(f"[{now:6.2f}s] progress: window={ev['window']} tokens={ev['tokens']} char={ev['char']} at sample {ev['samples']} ({ev['samples']/sample_rate:.2f}s)")
            elif kind == "done":
                print(f"[{now:6.2f}s] done: {ev['seconds']}s audio, rtf={ev['rtf']}, elapsed={ev['elapsed_ms']}ms")
            else:
                print(f"[{now:6.2f}s] {kind}: {ev}")
    if args.out and frames:
        with wave.open(args.out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(bytes(frames))
        print(f"wrote {args.out} ({len(frames)//2/sample_rate:.2f}s)")
    return 0 if frames else 1


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="ws://127.0.0.1:8877/tts")
    p.add_argument("--text", default=DEFAULT_TEXT)
    p.add_argument("--file")
    p.add_argument("--voice", default=None)
    p.add_argument("--model", default=None)
    p.add_argument("--cfg", type=float, default=1.5)
    p.add_argument("--steps", type=int, default=None)
    p.add_argument("--out", default=None)
    p.add_argument("-v", "--verbose", action="store_true")
    sys.exit(asyncio.run(run(p.parse_args())))


if __name__ == "__main__":
    main()
