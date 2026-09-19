from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from .config import Settings, default_voices_dir


def parse_args(argv=None) -> Settings:
    d = Settings()
    p = argparse.ArgumentParser(prog="vibevoice-reader-server", description="Local VibeVoice TTS server")
    p.add_argument("--model_path", default=d.model_path)
    p.add_argument("--device", default=d.device, choices=["auto", "cuda", "mps", "cpu"])
    p.add_argument("--attn", default=d.attn, choices=["auto", "flash_attention_2", "sdpa"])
    p.add_argument("--inference_steps", type=int, default=d.inference_steps)
    p.add_argument("--host", default=d.host)
    p.add_argument("--port", type=int, default=d.port)
    p.add_argument("--voices_dir", type=Path, default=default_voices_dir())
    p.add_argument("--cache_dir", type=Path, default=d.cache_dir)
    p.add_argument("--default_voice", default=None)
    p.add_argument("--log_level", default=d.log_level)
    p.add_argument("--models", default=d.models, help="engines to load at startup, comma-separated: realtime,1.5b,7b (others load on first use)")
    p.add_argument("--default_model", default=d.default_model, choices=["realtime", "1.5b", "7b", "kokoro", "qwen", "moss"])
    p.add_argument("--max_loaded", type=int, default=d.max_loaded, help="engines kept in VRAM at once")
    p.add_argument("--idle_unload_min", type=float, default=d.idle_unload_min, help="free VRAM after this many idle minutes (0: never)")
    p.add_argument("--voice_samples_dir", default=d.voice_samples_dir, help="folder(s) of *.wav reference clips, separated by ':' (later folders win on equal names)")
    p.add_argument("--model_path_15b", default=None)
    p.add_argument("--model_path_7b", default=None)
    p.add_argument("--quant_15b", default=d.quant_15b, choices=["none", "int8", "nf4"])
    p.add_argument("--quant_7b", default=d.quant_7b, choices=["none", "int8", "nf4"])
    p.add_argument("--qwen_python", type=Path, default=d.qwen_python)
    p.add_argument("--qwen_model", default=d.qwen_model, help="Qwen3-TTS checkpoint (…-0.6B-CustomVoice, …-1.7B-CustomVoice)")
    p.add_argument("--moss_python", type=Path, default=d.moss_python)
    p.add_argument("--moss_model", default=d.moss_model)
    p.add_argument("--moss_src", type=Path, default=d.moss_src, help="MOSS-TTS checkout (provides the realtime model code)")
    a = p.parse_args(argv)
    return Settings(**vars(a))


def main(argv=None) -> None:
    settings = parse_args(argv)
    from .app import create_app

    app = create_app(settings)
    print(f"[server] http://{settings.host}:{settings.port}  (ws://{settings.host}:{settings.port}/tts)")
    uvicorn.run(app, host=settings.host, port=settings.port, log_level=settings.log_level, ws_max_size=16 * 1024 * 1024)


if __name__ == "__main__":
    main()
