from __future__ import annotations

import asyncio
import json
import struct
import threading
import time
import uuid
import wave
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Dict, Optional

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from starlette.websockets import WebSocketDisconnect, WebSocketState

from . import __version__
from .config import Settings
from .engines.base import BaseEngine, Event
from .engines.registry import EngineRegistry


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI(title="VibeVoice Reader server", version=__version__)
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )
    registry = EngineRegistry(settings)
    app.state.settings = settings
    app.state.registry = registry
    app.state.gpu_lock = asyncio.Lock()
    app.state.waiting = 0
    app.state.started = time.time()
    app.state.stops: Dict[str, threading.Event] = {}

    @app.on_event("startup")
    async def _startup() -> None:
        for model_id in [m.strip() for m in settings.models.split(",") if m.strip()]:
            await asyncio.to_thread(registry.ensure_loaded, registry.get(model_id))

    async def _engine_for(model_id: Optional[str]) -> BaseEngine:
        """Resolve and load an engine; the caller must hold the GPU lock when loading."""
        engine = registry.get(model_id)
        if not engine.loaded:
            await asyncio.to_thread(registry.ensure_loaded, engine)
        return engine

    # ------------------------------------------------------------ HTTP
    @app.get("/health")
    async def health() -> Dict[str, Any]:
        engine = registry.get(None)
        loaded = registry.loaded()
        return {
            "ok": bool(loaded),
            "version": __version__,
            "model": engine.model_path if hasattr(engine, "model_path") else engine.id,
            "models": loaded,
            "default_model": engine.id,
            "device": engine.device,
            "attn": engine.attn_impl,
            "sample_rate": engine.sample_rate,
            "voices": len(engine.voices),
            "default_voice": engine.default_voice,
            "busy": app.state.gpu_lock.locked(),
            "waiting": app.state.waiting,
            "uptime_s": int(time.time() - app.state.started),
        }

    @app.get("/models")
    async def models() -> Dict[str, Any]:
        return {"default": registry.get(None).id, "max_loaded": registry.max_loaded, "models": registry.info()}

    @app.post("/models/{model_id}/load")
    async def load_model(model_id: str) -> Dict[str, Any]:
        """Load an engine now (queued behind running requests) and report the outcome."""
        try:
            engine = registry.get(model_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc))
        if getattr(engine, "available", True) is False:
            raise HTTPException(503, f"{engine.label} is not installed on the server (run `make engine-{engine.id}`)")
        if not engine.loaded:
            async with _gpu(app):
                try:
                    await asyncio.to_thread(registry.ensure_loaded, engine)
                except Exception as exc:  # noqa: BLE001
                    raise HTTPException(503, f"{engine.label} could not be loaded: {exc}")
        return {**engine.info(), "default_voice": engine.default_voice, "voice_list": [v.to_public() for v in engine.voices.values()]}

    @app.get("/voices")
    async def voices(model: Optional[str] = None) -> Dict[str, Any]:
        try:
            engine = registry.get(model)
        except KeyError as exc:
            raise HTTPException(404, str(exc))
        return {
            "model": engine.id,
            "default": engine.default_voice,
            "voices": [v.to_public() for v in engine.voices.values()],
        }

    @app.get("/preview/{voice_id}")
    async def preview(voice_id: str, model: Optional[str] = None):
        engine = registry.get(model)
        if voice_id not in engine.voices:
            raise HTTPException(404, f"unknown voice {voice_id}")
        info = engine.voices[voice_id]
        out_dir = settings.cache_dir / "previews" / engine.id
        out_dir.mkdir(parents=True, exist_ok=True)
        wav_path = out_dir / f"{voice_id}.wav"
        if not wav_path.exists():
            async with _gpu(app):
                engine = await _engine_for(model)
                await asyncio.to_thread(_render_wav, engine, info.preview_text(), voice_id, wav_path)
        return FileResponse(wav_path, media_type="audio/wav", filename=wav_path.name)

    # ------------------------------------------------- HTTP streaming
    # Same events as the WebSocket, framed as: 1 byte type (1=JSON, 2=PCM16),
    # 4 byte little-endian length, payload.  Browsers' extension contexts block
    # plain ws:// but allow http://127.0.0.1, so this is the extension's path.
    @app.post("/tts/stream")
    async def tts_stream(request: Request):
        try:
            req = await request.json()
        except json.JSONDecodeError as exc:
            raise HTTPException(400, f"expected JSON body: {exc}")
        text = str(req.get("text", ""))
        if not text.strip():
            raise HTTPException(400, "empty text")
        voice = req.get("voice")
        cfg = _float(req.get("cfg_scale"), 0.0) or None  # None -> engine default
        steps = req.get("inference_steps")
        steps = int(steps) if isinstance(steps, (int, float)) and steps > 0 else None
        try:
            engine = registry.get(req.get("model"))
        except KeyError as exc:
            raise HTTPException(400, str(exc))
        req_id = str(req.get("id") or uuid.uuid4())
        lang = req.get("lang") if isinstance(req.get("lang"), str) else None
        candidates = req.get("candidates")
        candidates = max(1, min(4, int(candidates))) if isinstance(candidates, (int, float)) else 1
        stop_event = threading.Event()
        app.state.stops[req_id] = stop_event

        async def gen():
            try:
                yield _frame_json({"event": "accepted", "id": req_id})
                if app.state.gpu_lock.locked():
                    yield _frame_json({"event": "queued", "position": app.state.waiting + 1})
                await _acquire(app)
                run: Optional[SynthRun] = None
                try:
                    if stop_event.is_set():
                        yield _frame_json({"event": "done", "samples": 0, "seconds": 0, "stopped": True})
                        return
                    if not engine.loaded:
                        yield _frame_json({"event": "loading", "model": engine.id, "label": engine.label})
                        await asyncio.to_thread(registry.ensure_loaded, engine)
                    run = SynthRun(engine, text, voice, cfg, steps, stop_event, candidates, may_continue=lambda: app.state.waiting == 0, lang=lang)
                    async for ev in run.events():
                        if ev.kind == "audio":
                            if not stop_event.is_set():
                                yield _frame_audio(ev.audio or b"")
                        else:
                            yield _frame_json({"event": ev.kind, **ev.data})
                finally:
                    stop_event.set()
                    asyncio.get_running_loop().create_task(_release_after(app, run))
            except Exception as exc:  # noqa: BLE001
                yield _frame_json({"event": "error", "message": str(exc)})
            finally:
                stop_event.set()
                app.state.stops.pop(req_id, None)

        return StreamingResponse(
            gen(),
            media_type="application/octet-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Request-Id": req_id},
        )

    @app.post("/tts/stop/{req_id}")
    async def tts_stop(req_id: str) -> Dict[str, Any]:
        ev = app.state.stops.get(req_id)
        if ev:
            ev.set()
        return {"ok": True, "found": ev is not None}

    # ------------------------------------------------------- WebSocket
    @app.websocket("/tts")
    async def tts(ws: WebSocket) -> None:
        await ws.accept()
        try:
            first = await ws.receive_text()
            req = json.loads(first)
        except (WebSocketDisconnect, json.JSONDecodeError) as exc:
            await _safe_close(ws, 1003, f"expected JSON request: {exc}")
            return
        text = str(req.get("text", ""))
        if not text.strip():
            await _safe_close(ws, 1003, "empty text")
            return
        voice = req.get("voice")
        cfg = _float(req.get("cfg_scale"), 0.0) or None
        steps = req.get("inference_steps")
        steps = int(steps) if isinstance(steps, (int, float)) and steps > 0 else None
        try:
            engine = registry.get(req.get("model"))
        except KeyError as exc:
            await _safe_close(ws, 1003, str(exc))
            return
        stop_event = threading.Event()

        async def watch_client() -> None:
            # Any further message from the client means "stop"; disconnect too.
            try:
                while True:
                    msg = await ws.receive()
                    if msg.get("type") == "websocket.disconnect":
                        break
                    data = msg.get("text") or ""
                    if "stop" in data.lower() or msg.get("bytes") is not None:
                        break
            except Exception:  # noqa: BLE001
                pass
            stop_event.set()

        watcher = asyncio.create_task(watch_client())
        try:
            if app.state.gpu_lock.locked():
                await _send_json(ws, {"event": "queued", "position": app.state.waiting + 1})
            await _acquire(app)
            run: Optional[SynthRun] = None
            try:
                if stop_event.is_set():
                    return
                if not engine.loaded:
                    await _send_json(ws, {"event": "loading", "model": engine.id, "label": engine.label})
                    await asyncio.to_thread(registry.ensure_loaded, engine)
                run = SynthRun(engine, text, voice, cfg, steps, stop_event)
                async for ev in run.events():
                    if ws.client_state != WebSocketState.CONNECTED:
                        stop_event.set()
                        continue  # keep draining so the worker winds down
                    if ev.kind == "audio":
                        if not stop_event.is_set():
                            await ws.send_bytes(ev.audio or b"")
                    else:
                        await _send_json(ws, {"event": ev.kind, **ev.data})
            finally:
                stop_event.set()
                asyncio.get_running_loop().create_task(_release_after(app, run))
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # noqa: BLE001
            await _send_json(ws, {"event": "error", "message": str(exc)})
        finally:
            stop_event.set()
            watcher.cancel()
            await _safe_close(ws, 1000, "done")

    return app


# ------------------------------------------------------------- helpers
class SynthRun:
    """engine.synthesize() in a worker thread, consumed as an async iterator."""

    def __init__(self, engine: BaseEngine, text: str, voice: Optional[str], cfg: Optional[float], steps: Optional[int], stop_event: threading.Event, candidates: int = 1, may_continue: Optional[Callable[[], bool]] = None, lang: Optional[str] = None):
        self.stop_event = stop_event
        self.loop = asyncio.get_running_loop()
        self.q: "asyncio.Queue[Any]" = asyncio.Queue()
        self._end = object()

        def worker() -> None:
            try:
                it = (
                    engine.synthesize_best(text, voice, cfg, steps, stop_event, candidates=candidates, may_continue=may_continue, lang=lang)
                    if candidates > 1
                    else engine.synthesize(text, voice, cfg, steps, stop_event, lang=lang)
                )
                for ev in it:
                    self.loop.call_soon_threadsafe(self.q.put_nowait, ev)
            except Exception as exc:  # noqa: BLE001
                self.loop.call_soon_threadsafe(self.q.put_nowait, Event("error", {"message": str(exc)}))
            finally:
                self.loop.call_soon_threadsafe(self.q.put_nowait, self._end)

        self.thread = threading.Thread(target=worker, daemon=True)
        self.thread.start()

    async def events(self) -> AsyncIterator[Event]:
        while True:
            ev = await self.q.get()
            if ev is self._end:
                return
            yield ev


async def _release_after(app: FastAPI, run: Optional[SynthRun]) -> None:
    """Release the GPU lock once the generation thread has really finished.

    Runs as its own task so that a cancelled request (client went away) still
    waits for the model instead of letting the next request overlap with it.
    """
    try:
        if run is not None and run.thread.is_alive():
            await asyncio.to_thread(run.thread.join)
    finally:
        app.state.gpu_lock.release()


async def _acquire(app: FastAPI) -> None:
    app.state.waiting += 1
    try:
        await app.state.gpu_lock.acquire()
    finally:
        app.state.waiting -= 1


class _gpu:
    """Serialise GPU use; callers queue instead of being rejected."""

    def __init__(self, app: FastAPI) -> None:
        self.app = app

    async def __aenter__(self):
        self.app.state.waiting += 1
        try:
            await self.app.state.gpu_lock.acquire()
        finally:
            self.app.state.waiting -= 1

    async def __aexit__(self, *exc):
        self.app.state.gpu_lock.release()


def _frame_json(payload: Dict[str, Any]) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    return struct.pack("<BI", 1, len(body)) + body


def _frame_audio(pcm: bytes) -> bytes:
    return struct.pack("<BI", 2, len(pcm)) + pcm


def _float(value: Any, default: float) -> float:
    try:
        f = float(value)
        return f if f > 0 else default
    except (TypeError, ValueError):
        return default


async def _send_json(ws: WebSocket, payload: Dict[str, Any]) -> None:
    if ws.client_state == WebSocketState.CONNECTED:
        try:
            await ws.send_text(json.dumps(payload))
        except Exception:  # noqa: BLE001
            pass


async def _safe_close(ws: WebSocket, code: int, reason: str) -> None:
    try:
        if ws.client_state == WebSocketState.CONNECTED:
            await ws.close(code=code, reason=reason[:120])
    except Exception:  # noqa: BLE001
        pass


def _render_wav(engine: BaseEngine, text: str, voice_id: str, out: Path) -> None:
    frames = bytearray()
    for ev in engine.synthesize(text, voice_id):
        if ev.kind == "audio" and ev.audio:
            frames += ev.audio
        elif ev.kind == "error":
            raise RuntimeError(ev.data.get("message"))
    tmp = out.with_suffix(".tmp.wav")
    with wave.open(str(tmp), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(engine.sample_rate)
        w.writeframes(bytes(frames))
    tmp.replace(out)
