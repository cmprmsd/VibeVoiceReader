"""Compatibility re-exports; engines live in vibevoice_reader_server.engines."""
from .engines.base import SAMPLE_RATE, Event, normalize_text, resolve_device  # noqa: F401
from .engines.realtime import RealtimeEngine as TTSEngine  # noqa: F401
