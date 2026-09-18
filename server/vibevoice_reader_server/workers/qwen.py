"""Qwen3-TTS worker using `faster-qwen3-tts` (CUDA-graph inference with
streaming), in its own virtual environment.

`*-CustomVoice` checkpoints ship preset speakers; `*-Base` checkpoints clone a
voice from a reference clip.  The language comes from the request (page
language), falling back to English.
"""
from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from typing import Any, Dict, Iterator, Union

import numpy as np

from vibevoice_reader_server.workers.protocol import SAMPLE_RATE, serve

PRESET_SPEAKERS = {
    "ryan": ("Ryan", "en", "English", "man"),
    "aiden": ("Aiden", "en", "English", "man"),
    "vivian": ("Vivian", "zh", "Chinese", "woman"),
    "serena": ("Serena", "zh", "Chinese", "woman"),
    "uncle_fu": ("Uncle Fu", "zh", "Chinese", "man"),
    "dylan": ("Dylan", "zh", "Chinese", "man"),
    "eric": ("Eric", "zh", "Chinese", "man"),
    "ono_anna": ("Ono Anna", "ja", "Japanese", "woman"),
    "sohee": ("Sohee", "ko", "Korean", "woman"),
}
LANG_NAMES = {"en": "English", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian", "pt": "Portuguese", "ru": "Russian", "ja": "Japanese", "ko": "Korean", "zh": "Chinese"}


def _log(*a: Any) -> None:
    print("[worker:qwen]", *a, file=sys.stderr, flush=True)


def _lang_name(tag: str | None) -> str:
    if not tag:
        return "English"
    return LANG_NAMES.get(tag.lower().split("-")[0], "English")


class QwenWorker:
    sample_rate = SAMPLE_RATE

    def __init__(self) -> None:
        self.model_id = os.environ.get("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
        self.sample_dirs = [Path(p) for p in (os.environ.get("VOICE_SAMPLES_DIR") or "").split(os.pathsep) if p.strip()]
        self.model = None
        self.voices: Dict[str, Dict[str, Any]] = {}
        self.is_custom = "CustomVoice" in self.model_id

    def load(self) -> Dict[str, Any]:
        import torch
        from faster_qwen3_tts import FasterQwen3TTS

        device = os.environ.get("TTS_DEVICE", "auto")
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        attn = os.environ.get("TTS_ATTN", "auto")
        attn = "sdpa" if attn in ("auto", "flash_attention_2") else attn
        self.model = FasterQwen3TTS.from_pretrained(self.model_id, device=device, dtype=torch.bfloat16 if device == "cuda" else torch.float32, attn_implementation=attn)
        try:
            self.model.warmup()
        except Exception as exc:  # noqa: BLE001
            _log("warmup skipped:", exc)
        self.device = device
        self.attn = attn

        if self.is_custom:
            for vid, (name, lang, label, gender) in PRESET_SPEAKERS.items():
                self.voices[vid] = {"id": vid, "name": name, "lang": lang, "lang_label": label, "gender": gender, "experimental": False}
            default = "ryan"
        else:
            for p in [q for d in self.sample_dirs if d.is_dir() for q in sorted(d.rglob("*.wav"))]:
                stem = p.stem
                parts = stem.split("-", 1)
                lang = parts[0] if len(parts) == 2 and len(parts[0]) == 2 else "en"
                name = (parts[1] if len(parts) == 2 else stem).split("_")[0]
                gender = "woman" if stem.endswith("_woman") else "man" if stem.endswith("_man") else "unknown"
                self.voices[stem] = {"id": stem, "name": name, "lang": lang, "lang_label": LANG_NAMES.get(lang, lang), "gender": gender, "experimental": False, "path": str(p)}
            if not self.voices:
                raise RuntimeError(f"no reference clips (*.wav) in {self.sample_dirs}; run `make voices`")
            default = "en-Carter_man" if "en-Carter_man" in self.voices else next(iter(self.voices))
        _log(f"loaded {self.model_id} on {device} ({attn}), {len(self.voices)} voices")
        return {"voices": list(self.voices.values()), "default": default, "device": device, "attn": attn}

    def synthesize(self, req: Dict[str, Any], stop: threading.Event) -> Iterator[Union[Dict[str, Any], bytes]]:
        import librosa

        text = req["text"]
        vid = req.get("voice") or next(iter(self.voices))
        voice = self.voices.get(vid) or self.voices.get(str(vid).lower()) or next(iter(self.voices.values()))
        language = os.environ.get("QWEN_TTS_LANGUAGE") or _lang_name(req.get("lang"))
        yield {"event": "meta", "text": text, "voice": voice["id"], "sample_rate": self.sample_rate, "tokens": 0, "offsets": [], "text_window": 0, "speech_window": 0, "model": "qwen", "language": language}
        if self.is_custom:
            stream = self.model.generate_custom_voice_streaming(text=text, speaker=voice["id"], language=language)
        else:
            stream = self.model.generate_voice_clone_streaming(text=text, language=language, ref_audio=voice["path"], ref_text="")
        carry = b""
        for chunk, sr, _timing in stream:
            if stop.is_set():
                break
            wav = np.asarray(chunk, dtype=np.float32).reshape(-1)
            if sr != self.sample_rate:
                wav = librosa.resample(wav, orig_sr=sr, target_sr=self.sample_rate)
            pcm = carry + (np.clip(wav, -1, 1) * 32767).astype(np.int16).tobytes()
            cut = len(pcm) - len(pcm) % 6400
            for i in range(0, cut, 6400):
                yield pcm[i : i + 6400]
            carry = pcm[cut:]
        if carry and not stop.is_set():
            yield carry
        yield {"event": "done"}


if __name__ == "__main__":
    serve(QwenWorker())
