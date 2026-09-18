"""Reproduce a voice switch: abort a stream mid-way and immediately start another.

Exits non-zero if any of the follow-up requests reports an error.
"""
from __future__ import annotations

import json
import struct
import sys
import time
import uuid

import httpx

TEXT = "This is a long enough paragraph to be interrupted part way through, so that we can check that a request which starts right after an aborted one does not collide with the model."
SERVER = "http://127.0.0.1:8877"


def frames(resp):
    buf = bytearray()
    for chunk in resp.iter_bytes():
        buf += chunk
        while len(buf) >= 5:
            kind, length = struct.unpack_from("<BI", buf, 0)
            if len(buf) < 5 + length:
                break
            payload = bytes(buf[5 : 5 + length])
            del buf[: 5 + length]
            yield kind, payload


def main() -> int:
    failures = 0
    with httpx.Client(timeout=None) as client:
        for i in range(4):
            t0 = time.time()
            # 1) start and abort after two audio frames (like closing the port on a voice switch)
            with client.stream("POST", SERVER + "/tts/stream", json={"id": str(uuid.uuid4()), "text": TEXT, "voice": "en-Carter_man"}) as r:
                n = 0
                for kind, _ in frames(r):
                    if kind == 2:
                        n += 1
                        if n == 2:
                            break  # leaving the with-block closes the connection
            # 2) immediately start another request with a different voice and read it fully
            events = []
            with client.stream("POST", SERVER + "/tts/stream", json={"id": str(uuid.uuid4()), "text": TEXT, "voice": "en-Emma_woman"}) as r:
                audio = 0
                for kind, payload in frames(r):
                    if kind == 2:
                        audio += 1
                    else:
                        ev = json.loads(payload)
                        if ev["event"] in ("error", "done", "queued"):
                            events.append(ev)
            errs = [e for e in events if e["event"] == "error"]
            done = [e for e in events if e["event"] == "done"]
            ok = not errs and done and not done[0].get("stopped")
            failures += 0 if ok else 1
            print(f"round {i}: {'OK ' if ok else 'FAIL'} audio_frames={audio} done={done[0] if done else None} errors={errs} in {time.time()-t0:.1f}s")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
