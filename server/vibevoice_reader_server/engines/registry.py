"""Holds all engines; loads on demand and keeps VRAM use within `max_loaded`."""
from __future__ import annotations

import threading
import traceback
from collections import OrderedDict
from typing import Dict, List, Optional

from pathlib import Path

from ..config import Settings
from ..voices import VoiceInfo, clip_voices, split_dirs
from .base import BaseEngine, release_gpu
from .kokoro import KokoroEngine
from .longform import SPECS, LongformEngine
from .realtime import RealtimeEngine
from .worker import WorkerEngine


QWEN_PRESETS = [
    VoiceInfo("ryan", "Ryan", "en", "English", "man", False, Path()),
    VoiceInfo("aiden", "Aiden", "en", "English", "man", False, Path()),
    VoiceInfo("vivian", "Vivian", "zh", "Chinese", "woman", False, Path()),
    VoiceInfo("serena", "Serena", "zh", "Chinese", "woman", False, Path()),
    VoiceInfo("uncle_fu", "Uncle Fu", "zh", "Chinese", "man", False, Path()),
    VoiceInfo("dylan", "Dylan", "zh", "Chinese", "man", False, Path()),
    VoiceInfo("eric", "Eric", "zh", "Chinese", "man", False, Path()),
    VoiceInfo("ono_anna", "Ono Anna", "ja", "Japanese", "woman", False, Path()),
    VoiceInfo("sohee", "Sohee", "ko", "Korean", "woman", False, Path()),
]


class EngineRegistry:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.engines: "OrderedDict[str, BaseEngine]" = OrderedDict()
        self.engines["realtime"] = RealtimeEngine(settings)
        self.engines["1.5b"] = LongformEngine(SPECS["1.5b"], settings.device, settings.attn, settings.voice_samples_dir, settings.quant_15b, settings.model_path_15b)
        self.engines["7b"] = LongformEngine(SPECS["7b"], settings.device, settings.attn, settings.voice_samples_dir, settings.quant_7b, settings.model_path_7b)
        self.engines["kokoro"] = KokoroEngine(settings.device)
        self.engines["qwen"] = WorkerEngine(
            "qwen", "Qwen3-TTS", "10 languages incl. German, preset speakers and voice cloning from a clip. 0.6B: ~3 GB, 1.7B: ~6 GB VRAM.",
            "vibevoice_reader_server.workers.qwen", settings.qwen_python, 3.0,
            env={"QWEN_TTS_MODEL": settings.qwen_model, "VOICE_SAMPLES_DIR": str(settings.voice_samples_dir or ""), "TTS_DEVICE": settings.device, "TTS_ATTN": settings.attn},
            static_voices=(lambda: list(QWEN_PRESETS)) if "CustomVoice" in settings.qwen_model else (lambda: clip_voices(split_dirs(settings.voice_samples_dir))),
        )
        self.engines["moss"] = WorkerEngine(
            "moss", "MOSS-TTS Realtime", "20 languages incl. German, voice cloning from a clip, streaming. 1.7B + codec, ~8 GB VRAM.",
            "vibevoice_reader_server.workers.moss", settings.moss_python, 8.0,
            env={"MOSS_TTS_MODEL": settings.moss_model, "MOSS_TTS_SRC": str(settings.moss_src), "VOICE_SAMPLES_DIR": str(settings.voice_samples_dir or ""), "TTS_DEVICE": settings.device, "TTS_ATTN": settings.attn},
            static_voices=lambda: clip_voices(split_dirs(settings.voice_samples_dir), [VoiceInfo("default", "Default (no reference)", "en", "Multilingual", "unknown", False, Path())]),
        )
        self.max_loaded = max(1, settings.max_loaded)
        self._recent: List[str] = []  # most recently used last
        self._lock = threading.Lock()

    def get(self, model_id: Optional[str]) -> BaseEngine:
        key = (model_id or self.settings.default_model or "realtime").lower()
        if key not in self.engines:
            raise KeyError(f"unknown model {model_id!r}; available: {', '.join(self.engines)}")
        return self.engines[key]

    def loaded(self) -> List[str]:
        return [k for k, e in self.engines.items() if e.loaded]

    def ensure_loaded(self, engine: BaseEngine) -> None:
        """Load `engine` (blocking); unload least recently used ones beyond max_loaded."""
        with self._lock:
            if engine.id in self._recent:
                self._recent.remove(engine.id)
            self._recent.append(engine.id)
            if engine.loaded:
                return
            while len(self.loaded()) >= self.max_loaded:
                victim = next((k for k in self._recent if k != engine.id and self.engines[k].loaded), None)
                if victim is None:
                    break
                self.engines[victim].unload()
                self._recent.remove(victim)
            error: Optional[str] = None
            try:
                engine.load()
            except Exception as exc:  # noqa: BLE001
                error = f"{type(exc).__name__}: {exc}"
                traceback.print_exc()
            if error is None:
                return
            # Leave nothing behind, so the next request can load another engine.  This runs
            # outside the except block: the traceback would keep the half-built model alive.
            self._recent.remove(engine.id)
            try:
                engine.unload()
            except Exception:  # noqa: BLE001
                pass
            release_gpu()
            raise RuntimeError(error)

    def unload_all(self) -> List[str]:
        with self._lock:
            done = [k for k in self.loaded()]
            for k in done:
                self.engines[k].unload()
            self._recent.clear()
            release_gpu()
            return done

    def info(self) -> List[dict]:
        return [e.info() for e in self.engines.values()]
