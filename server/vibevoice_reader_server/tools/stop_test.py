"""Verify that sending a message mid-stream stops generation quickly."""
import asyncio, json, sys, time
import websockets

async def main(url="ws://127.0.0.1:8877/tts"):
    t0 = time.time(); chunks = 0
    async with websockets.connect(url, max_size=None) as ws:
        await ws.send(json.dumps({"text": "This is a fairly long paragraph that should take several seconds to synthesize, so that we can interrupt it well before it finishes and confirm the server honours the stop request promptly."}))
        async for msg in ws:
            if isinstance(msg, (bytes, bytearray)):
                chunks += 1
                if chunks == 3:
                    await ws.send("stop"); t_stop = time.time()
                continue
            ev = json.loads(msg)
            if ev.get("event") == "done":
                print(f"stopped={ev['stopped']} audio={ev['seconds']}s chunks={chunks} stop->done {time.time()-t_stop:.2f}s total {time.time()-t0:.2f}s")
    return 0

sys.exit(asyncio.run(main(*sys.argv[1:])))
