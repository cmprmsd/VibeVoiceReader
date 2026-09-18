"""Common engine interface: load/unload, voices, streaming synthesis, best-of-N."""
from __future__ import annotations

import gc
import importlib.util
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

import torch

from ..quality import score_pcm16
from ..voices import VoiceInfo

SAMPLE_RATE = 24000


@dataclass
class Event:
    kind: str  # meta | audio | progress | quality | done | error
    data: Dict[str, Any] = field(default_factory=dict)
    audio: Optional[bytes] = None


def normalize_text(text: str) -> str:
    """Length-preserving normalisation so client character offsets stay valid."""
    return text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')


def resolve_device(requested: str) -> str:
    if requested in ("auto", None):
        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
        return "cpu"
    if requested == "mpx":
        requested = "mps"
    if requested == "mps" and not torch.backends.mps.is_available():
        print("[engine] MPS not available, falling back to CPU")
        return "cpu"
    if requested == "cuda" and not torch.cuda.is_available():
        print("[engine] CUDA not available, falling back to CPU")
        return "cpu"
    return requested


def release_gpu() -> None:
    """Drop dangling tensors and return cached CUDA memory after a failed load.

    Call it outside any `except` block: a live exception keeps the frames of the
    failed loader, and with them the half-built model, alive.
    """
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def attn_candidates(requested: str, device: str) -> List[str]:
    """Attention implementations to try, in order. flash_attention_2 only when installed."""
    attn = requested
    if attn == "auto":
        attn = "flash_attention_2" if device == "cuda" else "sdpa"
    if attn == "flash_attention_2" and importlib.util.find_spec("flash_attn") is None:
        print("[engine] flash_attn is not installed, using sdpa")
        attn = "sdpa"
    return [attn] + (["sdpa"] if attn != "sdpa" else [])


class BaseEngine:
    """A TTS backend.  Subclasses implement load/unload/voices/synthesize."""
    available = True  # False when a dependency is missing; info() and load() say what

    id: str = ""
    label: str = ""
    description: str = ""
    #: approximate VRAM in GB, for the model picker
    vram_gb: float = 0.0
    #: default sampling parameters for this model
    default_cfg_scale: float = 1.3
    default_steps: int = 10
    #: False for deterministic engines: a second take would be identical, so best-of-N is skipped
    stochastic: bool = True
    sample_rate = SAMPLE_RATE

    def __init__(self) -> None:
        self.loaded = False
        self.attn_impl = "unknown"
        self.device = "cpu"
        # The diffusion scheduler keeps a step counter on the model, so two
        # generations must never overlap even for a moment.
        self._model_lock = threading.Lock()

    # ---- lifecycle
    def load(self) -> None:
        raise NotImplementedError

    def unload(self) -> None:
        raise NotImplementedError

    # ---- voices
    @property
    def voices(self) -> Dict[str, VoiceInfo]:
        raise NotImplementedError

    @property
    def default_voice(self) -> Optional[str]:
        return next(iter(self.voices), None)

    def resolve_voice(self, voice_id: Optional[str]) -> str:
        if voice_id and voice_id in self.voices:
            return voice_id
        return self.default_voice or next(iter(self.voices))

    def preview_text(self, voice_id: str) -> str:
        return self.voices[voice_id].preview_text()

    # ---- synthesis
    def synthesize(
        self,
        text: str,
        voice_id: Optional[str] = None,
        cfg_scale: Optional[float] = None,
        inference_steps: Optional[int] = None,
        stop_event: Optional[threading.Event] = None,
        lang: Optional[str] = None,
    ) -> Iterator[Event]:
        raise NotImplementedError

    def info(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "loaded": self.loaded,
            "available": self.available,
            "vram_gb": self.vram_gb,
            "device": self.device if self.loaded else None,
            "attn": self.attn_impl if self.loaded else None,
            "default_cfg_scale": self.default_cfg_scale,
            "default_steps": self.default_steps,
            "stochastic": self.stochastic,
            "voices": len(self.voices),
        }

    # ------------------------------------------------------ best-of-N
    def synthesize_best(
        self,
        text: str,
        voice_id: Optional[str] = None,
        cfg_scale: Optional[float] = None,
        inference_steps: Optional[int] = None,
        stop_event: Optional[threading.Event] = None,
        candidates: int = 2,
        accept_score: float = 0.6,
        may_continue: Optional[Callable[[], bool]] = None,
        lang: Optional[str] = None,
    ) -> Iterator[Event]:
        """Generate up to `candidates` takes, score each, and replay the best.

        Stops early once a take scores at or below `accept_score` or when
        `may_continue()` says another client is waiting.  Nothing is streamed
        until the choice is made, so callers use this for prefetched chunks.
        """
        stop = stop_event or threading.Event()
        if not self.stochastic:
            candidates = 1
        best: Optional[Tuple[float, list, bytes, Dict[str, Any]]] = None
        tried = 0
        scores: List[float] = []
        for _attempt in range(max(1, candidates)):
            if stop.is_set():
                break
            events: list = []
            audio = bytearray()
            done: Dict[str, Any] = {}
            for ev in self.synthesize(text, voice_id, cfg_scale, inference_steps, stop, lang=lang):
                if ev.kind == "audio":
                    audio += ev.audio or b""
                elif ev.kind == "done":
                    done = ev.data
                elif ev.kind == "error":
                    yield ev
                    return
                else:
                    events.append(ev)
            tried += 1
            if done.get("stopped"):
                break
            q = score_pcm16(bytes(audio), self.sample_rate)
            scores.append(q.score)
            if best is None or q.score < best[0]:
                best = (q.score, events, bytes(audio), {**done, "quality": q.to_dict()})
            if q.score <= accept_score:
                break
            if may_continue is not None and not may_continue():
                break
        if best is None:
            yield Event("done", {"samples": 0, "seconds": 0.0, "stopped": True})
            return
        score, events, audio, done = best
        for ev in events:
            yield ev
        yield Event("quality", {"score": round(score, 3), "candidates": tried, "scores": [round(x, 3) for x in scores]})
        step = 6400  # 0.13 s frames, like live streaming
        samples = 0
        for i in range(0, len(audio), step):
            piece = audio[i : i + step]
            samples += len(piece) // 2
            yield Event("audio", {"samples": samples}, audio=piece)
        yield Event("done", {**done, "candidates": tried})


def pcm16_bytes(chunk) -> bytes:
    """torch/numpy float chunk -> PCM16 bytes, peak-limited."""
    import numpy as np

    if torch.is_tensor(chunk):
        chunk = chunk.detach().cpu().to(torch.float32).numpy()
    else:
        chunk = np.asarray(chunk, dtype=np.float32)
    chunk = chunk.reshape(-1)
    peak = float(np.max(np.abs(chunk))) if chunk.size else 0.0
    if peak > 1.0:
        chunk = chunk / peak
    return (np.clip(chunk, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()
