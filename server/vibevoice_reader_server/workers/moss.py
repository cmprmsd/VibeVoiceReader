"""MOSS-TTS-Realtime worker (code from the MOSS-TTS checkout, its own virtual environment).

Uses the batch `generate` API per request; the model's streaming session is
a later refinement.  Reference clips become voices; "default" uses no clip.
"""
from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from typing import Any, Dict, Iterator, Union

import numpy as np

from vibevoice_reader_server.workers.protocol import SAMPLE_RATE, serve

LANG_NAMES = {"en": "English", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian", "pt": "Portuguese", "ru": "Russian", "ja": "Japanese", "ko": "Korean", "zh": "Chinese", "in": "English"}


def _log(*a: Any) -> None:
    print("[worker:moss]", *a, file=sys.stderr, flush=True)


class MossWorker:
    sample_rate = SAMPLE_RATE

    def __init__(self) -> None:
        self.model_id = os.environ.get("MOSS_TTS_MODEL", "OpenMOSS-Team/MOSS-TTS-Realtime")
        self.codec_id = os.environ.get("MOSS_CODEC_MODEL", "OpenMOSS-Team/MOSS-Audio-Tokenizer")
        self.src = Path(os.environ.get("MOSS_TTS_SRC") or "build/moss-tts")
        self.sample_dirs = [Path(p) for p in (os.environ.get("VOICE_SAMPLES_DIR") or "").split(os.pathsep) if p.strip()]
        self.voices: Dict[str, Dict[str, Any]] = {}

    def load(self) -> Dict[str, Any]:
        import torch

        rt = self.src / "moss_tts_realtime"
        if not rt.is_dir():
            raise RuntimeError(f"MOSS-TTS checkout not found at {self.src}; run `make engine-moss`")
        sys.path.insert(0, str(rt))
        from transformers import AutoModel, AutoTokenizer
        from inferencer import MossTTSRealtimeInference  # type: ignore
        from mossttsrealtime.modeling_mossttsrealtime import MossTTSRealtime  # type: ignore

        device = os.environ.get("TTS_DEVICE", "auto")
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.bfloat16 if device == "cuda" else torch.float32
        attn = os.environ.get("TTS_ATTN", "auto")
        candidates = ["flash_attention_2", "sdpa"] if attn == "auto" else [attn, "sdpa"]
        model = None
        last = None
        for impl in candidates:
            try:
                model = MossTTSRealtime.from_pretrained(self.model_id, attn_implementation=impl, torch_dtype=dtype, trust_remote_code=True).to(device)
                self.attn = impl
                break
            except Exception as exc:  # noqa: BLE001
                last = exc
                _log(f"attn={impl} failed: {exc}")
        if model is None:
            raise RuntimeError(f"could not load {self.model_id}: {last}")
        # trust_remote_code everywhere: a confirmation prompt would block on the
        # worker's stdin, which is the command channel.
        tokenizer = AutoTokenizer.from_pretrained(self.model_id, trust_remote_code=True)
        self.codec = AutoModel.from_pretrained(self.codec_id, trust_remote_code=True, torch_dtype=dtype).eval().to(device)
        self.inferencer = MossTTSRealtimeInference(model, tokenizer, max_length=5000, codec=self.codec, codec_sample_rate=self.sample_rate, codec_encode_kwargs={"chunk_duration": 8})
        self.device = device
        self.torch = torch

        self.voices["default"] = {"id": "default", "name": "Default (no reference)", "lang": "en", "lang_label": "Multilingual", "gender": "unknown", "experimental": False}
        if True:
            for p in [q for d in self.sample_dirs if d.is_dir() for q in sorted(d.rglob("*.wav"))]:
                stem = p.stem
                parts = stem.split("-", 1)
                lang = parts[0] if len(parts) == 2 and len(parts[0]) == 2 else "en"
                name = (parts[1] if len(parts) == 2 else stem).split("_")[0]
                gender = "woman" if stem.endswith("_woman") else "man" if stem.endswith("_man") else "unknown"
                self.voices[stem] = {"id": stem, "name": name, "lang": lang, "lang_label": LANG_NAMES.get(lang, lang), "gender": gender, "experimental": False, "path": str(p)}
        default = "en-Carter_man" if "en-Carter_man" in self.voices else "default"
        _log(f"loaded {self.model_id} + codec on {device} ({self.attn}), {len(self.voices)} voices")
        return {"voices": list(self.voices.values()), "default": default, "device": device, "attn": self.attn}

    def synthesize(self, req: Dict[str, Any], stop: threading.Event) -> Iterator[Union[Dict[str, Any], bytes]]:
        text = req["text"]
        vid = req.get("voice") or "default"
        voice = self.voices.get(vid) or self.voices["default"]
        yield {"event": "meta", "text": text, "voice": voice["id"], "sample_rate": self.sample_rate, "tokens": 0, "offsets": [], "text_window": 0, "speech_window": 0, "model": "moss"}
        ref = voice.get("path")
        result = self.inferencer.generate(text=[text], reference_audio_path=[ref] if ref else None, temperature=0.8, top_p=0.6, top_k=30, repetition_penalty=1.1, repetition_window=50)
        if stop.is_set():
            yield {"event": "done", "stopped": True}
            return
        for generated_tokens in result:
            output = self.torch.tensor(generated_tokens).to(self.device)
            decoded = self.codec.decode(output.permute(1, 0), chunk_duration=8)
            wav = decoded["audio"][0].detach().float().cpu().numpy().reshape(-1)
            pcm = (np.clip(wav, -1, 1) * 32767).astype(np.int16).tobytes()
            for i in range(0, len(pcm), 6400):
                if stop.is_set():
                    break
                yield pcm[i : i + 6400]
            break  # one text per request
        yield {"event": "done"}


if __name__ == "__main__":
    serve(MossWorker())
