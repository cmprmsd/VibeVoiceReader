"""VibeVoice-1.5B / 7B: long-form multi-speaker models with voice cloning from
a reference clip.  Audio streams while generating, but there is no text
progress signal, so sentence alignment relies on pause detection.
"""
from __future__ import annotations

import threading
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

import numpy as np
import torch

from vibevoice.modular.streamer import AudioStreamer
from vibevoice.processor.vibevoice_processor import VibeVoiceProcessor

from ..voices import VoiceInfo, clip_voices, dirs_signature, split_dirs
from .base import BaseEngine, Event, attn_candidates, normalize_text, pcm16_bytes, release_gpu, resolve_device
from .longform_model import VibeVoiceForConditionalGenerationInference


@dataclass
class LongformSpec:
    id: str
    label: str
    model_path: str
    vram_gb: float
    description: str


SPECS = {
    "1.5b": LongformSpec("1.5b", "VibeVoice 1.5B", "vibevoice/VibeVoice-1.5B", 6.0, "Higher quality, voice cloning from a clip. Needs ~6 GB VRAM."),
    "7b": LongformSpec("7b", "VibeVoice 7B", "vibevoice/VibeVoice-7B", 10.0, "Best quality, voice cloning. 8-bit: ~10 GB VRAM, 4-bit: ~6 GB."),
}


class LongformEngine(BaseEngine):
    default_cfg_scale = 1.3
    default_steps = 10

    def __init__(self, spec: LongformSpec, device: str, attn: str, samples_dir, quant: str = "none", model_path: Optional[str] = None):
        super().__init__()
        self.spec = spec
        self.id = spec.id
        self.label = spec.label
        self.description = spec.description + (f" (loaded {quant})" if quant != "none" else "")
        self.vram_gb = spec.vram_gb if quant != "nf4" else 6.0
        self.model_path = model_path or spec.model_path
        self.quant = quant
        self.requested_device = device
        self.requested_attn = attn
        self.sample_dirs = split_dirs(samples_dir)
        self._voices_sig: tuple = ()
        self.processor: Optional[VibeVoiceProcessor] = None
        self.model: Optional[VibeVoiceForConditionalGenerationInference] = None
        self._voices: Dict[str, VoiceInfo] = {}
        self._sample_cache: Dict[str, np.ndarray] = {}

    # ---------------------------------------------------------------- voices
    @property
    def voices(self) -> Dict[str, VoiceInfo]:
        """Rescans the clip folders whenever a file was added, removed or replaced."""
        sig = dirs_signature(self.sample_dirs)
        if sig != self._voices_sig:
            self._voices = {v.id: v for v in clip_voices(self.sample_dirs)}
            self._voices_sig = sig
            self._sample_cache.clear()
        return self._voices

    @property
    def default_voice(self) -> Optional[str]:
        v = self.voices
        return "en-Carter_man" if "en-Carter_man" in v else next(iter(v), None)

    def _sample(self, voice_id: str) -> np.ndarray:
        if voice_id not in self._sample_cache:
            import librosa
            import soundfile as sf

            wav, sr = sf.read(str(self.voices[voice_id].path))
            if wav.ndim > 1:
                wav = wav.mean(axis=1)
            if sr != self.sample_rate:
                wav = librosa.resample(wav, orig_sr=sr, target_sr=self.sample_rate)
            self._sample_cache[voice_id] = wav.astype(np.float32)
        return self._sample_cache[voice_id]

    # ------------------------------------------------------------- lifecycle
    def load(self) -> None:
        t0 = time.time()
        if not self.voices:
            raise RuntimeError(f"No voice samples (*.wav) in {':'.join(map(str, self.sample_dirs)) or 'the clip folders'}; run `make voices` or add your own clips")
        self.device = resolve_device(self.requested_device)
        self._torch_device = torch.device(self.device)
        print(f"[engine:{self.id}] loading processor from {self.model_path}")
        self.processor = VibeVoiceProcessor.from_pretrained(self.model_path)

        kwargs: Dict[str, Any] = {}
        if self.device == "cuda":
            kwargs["torch_dtype"] = torch.bfloat16
            kwargs["device_map"] = "cuda"
            if self.quant in ("int8", "nf4"):
                from transformers import BitsAndBytesConfig

                # Only the language model is quantized; the diffusion head, the
                # audio tokenizers and the connectors must stay in bf16 (int8
                # on them produces noise).
                skip = ["prediction_head", "acoustic_tokenizer", "semantic_tokenizer", "acoustic_connector", "semantic_connector", "lm_head"]
                kwargs["quantization_config"] = (
                    BitsAndBytesConfig(load_in_8bit=True, llm_int8_skip_modules=skip)
                    if self.quant == "int8"
                    else BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_quant_type="nf4", llm_int8_skip_modules=skip)
                )
        else:
            kwargs["torch_dtype"] = torch.float32
            kwargs["device_map"] = None if self.device == "mps" else "cpu"
            if self.quant != "none":
                print(f"[engine:{self.id}] quantisation needs CUDA, loading unquantised")

        last_err = ""
        for impl in attn_candidates(self.requested_attn, self.device):
            try:
                print(f"[engine:{self.id}] loading model on {self.device} (quant={self.quant}, attn={impl})")
                self.model = VibeVoiceForConditionalGenerationInference.from_pretrained(self.model_path, attn_implementation=impl, **kwargs)
                self.attn_impl = impl
                break
            except Exception as exc:  # noqa: BLE001
                last_err = f"{type(exc).__name__}: {exc}"
                print(f"[engine:{self.id}] attn={impl} failed: {last_err}")
            release_gpu()  # after the except block: a partially built model must not keep VRAM
        if self.model is None:
            raise RuntimeError(f"Could not load {self.model_path}: {last_err}")
        if self.device == "mps":
            self.model.to("mps")
        self.model.eval()
        self.model.model.noise_scheduler = self.model.model.noise_scheduler.from_config(
            self.model.model.noise_scheduler.config, algorithm_type="sde-dpmsolver++", beta_schedule="squaredcos_cap_v2"
        )
        self.model.set_ddpm_inference_steps(num_steps=self.default_steps)
        self.loaded = True
        print(f"[engine:{self.id}] ready in {time.time() - t0:.1f}s, {len(self.voices)} voice samples")

    def unload(self) -> None:
        with self._model_lock:
            self.model = None
            self.processor = None
            self._sample_cache.clear()
            self.loaded = False
            release_gpu()
            print(f"[engine:{self.id}] unloaded")

    # --------------------------------------------------------------- synth
    def _run(self, inputs, streamer, errors, cfg_scale, steps, stop_check) -> None:
        try:
            with self._model_lock:
                if stop_check():
                    streamer.end()
                    return
                self.model.set_ddpm_inference_steps(num_steps=steps)
                self.model.generate(
                    **inputs,
                    max_new_tokens=None,
                    cfg_scale=cfg_scale,
                    tokenizer=self.processor.tokenizer,
                    generation_config={"do_sample": False},
                    audio_streamer=streamer,
                    stop_check_fn=stop_check,
                    verbose=False,
                    refresh_negative=True,
                    is_prefill=True,
                    show_progress_bar=False,
                )
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)
            traceback.print_exc()
            streamer.end()

    def synthesize(
        self,
        text: str,
        voice_id: Optional[str] = None,
        cfg_scale: Optional[float] = None,
        inference_steps: Optional[int] = None,
        stop_event: Optional[threading.Event] = None,
        lang: Optional[str] = None,
    ) -> Iterator[Event]:
        if not self.loaded or self.model is None or self.processor is None:
            raise RuntimeError("engine not loaded")
        text = normalize_text(text).strip()
        if not text:
            yield Event("done", {"samples": 0, "seconds": 0.0})
            return
        voice = self.resolve_voice(voice_id)
        cfg = float(cfg_scale) if cfg_scale else self.default_cfg_scale
        steps = int(inference_steps) if inference_steps and inference_steps > 0 else self.default_steps
        script = f"Speaker 1: {text}"
        processed = self.processor(text=[script], voice_samples=[[self._sample(voice)]], padding=True, return_tensors="pt", return_attention_mask=True)
        inputs = {k: (v.to(self._torch_device) if torch.is_tensor(v) else v) for k, v in processed.items()}

        yield Event(
            "meta",
            {"text": text, "voice": voice, "sample_rate": self.sample_rate, "tokens": 0, "offsets": [], "text_window": 0, "speech_window": 0, "cfg_scale": cfg, "inference_steps": steps, "model": self.id},
        )
        streamer = AudioStreamer(batch_size=1, stop_signal=None, timeout=None)
        errors: list = []
        stop = stop_event or threading.Event()
        internal = threading.Event()
        thread = threading.Thread(target=self._run, args=(inputs, streamer, errors, cfg, steps, lambda: internal.is_set() or stop.is_set()), daemon=True)
        t0 = time.time()
        thread.start()
        samples = 0
        user_stopped = True
        try:
            for chunk in streamer.get_stream(0):
                pcm = pcm16_bytes(chunk)
                samples += len(pcm) // 2
                yield Event("audio", {"samples": samples}, audio=pcm)
            user_stopped = stop.is_set()
        finally:
            internal.set()
            streamer.end()
            thread.join()
        elapsed = time.time() - t0
        seconds = samples / self.sample_rate
        if errors:
            yield Event("error", {"message": str(errors[0])})
            return
        yield Event("done", {"samples": samples, "seconds": round(seconds, 3), "elapsed_ms": int(elapsed * 1000), "rtf": round(elapsed / seconds, 3) if seconds else None, "stopped": user_stopped})
