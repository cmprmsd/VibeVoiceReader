"""Score a fixed set of sentences with the server's artifact metric.

Run once per configuration (e.g. SDPA vs flash-attention, or different cfg /
steps) and compare the means.  Generation is stochastic, so use --repeat.

    python -m vibevoice_reader_server.tools.quality_bench --repeat 3 --label sdpa
"""
from __future__ import annotations

import argparse
import json
import struct
import time

import httpx

from ..quality import score_pcm16

SENTENCES = [
    "Synthesized speech can be created by concatenating pieces of recorded speech that are stored in a database.",
    "Systems differ in the size of the stored speech units; a system that stores phones or diphones provides the largest output range, but may lack clarity.",
    "The front-end has two major tasks. First, it converts raw text containing symbols like numbers and abbreviations into the equivalent of written-out words.",
    "In 2000, Microsoft Sam was the default text-to-speech voice synthesizer used by the narrator accessibility feature.",
    "The quality of a speech synthesizer is judged by its similarity to the human voice and by its ability to be understood clearly.",
]


def synth(client: httpx.Client, server: str, text: str, cfg: float, steps: int, a=None) -> tuple[bytes, float]:
    audio = bytearray()
    buf = bytearray()
    t0 = time.time()
    with client.stream("POST", server + "/tts/stream", json={"text": text, "cfg_scale": cfg, "inference_steps": steps, "model": a.model}) as r:
        for chunk in r.iter_bytes():
            buf += chunk
            while len(buf) >= 5:
                kind, length = struct.unpack_from("<BI", buf, 0)
                if len(buf) < 5 + length:
                    break
                payload = bytes(buf[5 : 5 + length])
                del buf[: 5 + length]
                if kind == 2:
                    audio += payload
    return bytes(audio), time.time() - t0


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--server", default="http://127.0.0.1:8877")
    p.add_argument("--repeat", type=int, default=2)
    p.add_argument("--cfg", type=float, default=1.25)
    p.add_argument("--steps", type=int, default=5)
    p.add_argument("--label", default="")
    p.add_argument("--model", default=None)
    a = p.parse_args()
    health = httpx.get(a.server + "/health").json()
    print(f"{a.label or 'run'}: attn={health['attn']} device={health['device']} cfg={a.cfg} steps={a.steps} repeat={a.repeat}")
    rows = []
    for text in SENTENCES:
        for _ in range(a.repeat):
            audio, elapsed = synth(httpx.Client(timeout=None), a.server, text, a.cfg, a.steps, a)
            q = score_pcm16(audio, 24000)
            rows.append((q, elapsed))
            print(f"  score {q.score:5.2f}  bursts/s {q.bursts_per_s:4.2f}  clicks/s {q.clicks_per_s:5.2f}  drop/s {q.dropouts_per_s:4.2f}  peak {q.peak:.2f}  rtf {elapsed / q.seconds:.2f}  | {text[:40]}…")
    n = len(rows)
    mean = lambda f: sum(f(r) for r in rows) / n
    print(f"MEAN {a.label}: score {mean(lambda r: r[0].score):.3f}  bursts/s {mean(lambda r: r[0].bursts_per_s):.3f}  clicks/s {mean(lambda r: r[0].clicks_per_s):.2f}  dropouts/s {mean(lambda r: r[0].dropouts_per_s):.3f}  peak {mean(lambda r: r[0].peak):.2f}  rtf {mean(lambda r: r[1] / r[0].seconds):.2f}")
    print(json.dumps({"label": a.label, "attn": health["attn"], "score": mean(lambda r: r[0].score), "bursts": mean(lambda r: r[0].bursts_per_s), "clicks": mean(lambda r: r[0].clicks_per_s), "rtf": mean(lambda r: r[1] / r[0].seconds)}))


if __name__ == "__main__":
    main()
