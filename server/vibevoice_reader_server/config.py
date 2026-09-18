from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[2]


def default_voices_dir() -> Optional[Path]:
    env = os.environ.get("VIBEVOICE_VOICES_DIR")
    if env:
        return Path(env).expanduser()
    for candidate in (
        REPO_ROOT.parent / "VibeVoice" / "demo" / "voices" / "streaming_model",
        Path.home() / "VibeVoice" / "demo" / "voices" / "streaming_model",
    ):
        if candidate.is_dir():
            return candidate
    return None


def default_cache_dir() -> Path:
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "vibevoice-reader"


@dataclass
class Settings:
    model_path: str = "microsoft/VibeVoice-Realtime-0.5B"
    device: str = "auto"
    attn: str = "auto"  # auto | flash_attention_2 | sdpa
    inference_steps: int = 5
    host: str = "127.0.0.1"
    port: int = 8877
    voices_dir: Optional[Path] = field(default_factory=default_voices_dir)
    cache_dir: Path = field(default_factory=default_cache_dir)
    default_voice: Optional[str] = None
    log_level: str = "info"
    # engines
    default_model: str = "realtime"
    models: str = "realtime"  # comma-separated engines to load at startup; others load on first use
    max_loaded: int = 1  # engines kept in VRAM at once
    # one or more folders of reference clips (PATH-like, e.g. "/opt/voices:~/.cache/vibevoice-reader/voices")
    voice_samples_dir: Optional[str] = field(default_factory=lambda: str(default_cache_dir() / "voices"))
    model_path_15b: Optional[str] = None
    model_path_7b: Optional[str] = None
    quant_15b: str = "none"  # none | int8 | nf4
    quant_7b: str = "nf4"
    # out-of-process engines (each has its own virtual environment, see `make engine-*`)
    qwen_python: Path = field(default_factory=lambda: REPO_ROOT / ".venv-qwen" / "bin" / "python")
    qwen_model: str = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
    moss_python: Path = field(default_factory=lambda: REPO_ROOT / ".venv-moss" / "bin" / "python")
    moss_model: str = "OpenMOSS-Team/MOSS-TTS-Realtime"
    moss_src: Path = field(default_factory=lambda: REPO_ROOT / "build" / "moss-tts")
