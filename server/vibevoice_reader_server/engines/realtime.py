"""VibeVoice-Realtime-0.5B: window-streaming model with text-progress events."""
from __future__ import annotations

import copy
import threading
import time
import traceback
from typing import Any, Dict, Iterator, List, Optional, Tuple

import numpy as np
import torch
from transformers.cache_utils import DynamicCache
from transformers.modeling_outputs import BaseModelOutputWithPast

from vibevoice.modular.modeling_vibevoice_streaming_inference import (
    TTS_SPEECH_WINDOW_SIZE,
    TTS_TEXT_WINDOW_SIZE,
    VibeVoiceStreamingForConditionalGenerationInference,
)
from vibevoice.modular.streamer import AudioStreamer
from vibevoice.processor.vibevoice_streaming_processor import VibeVoiceStreamingProcessor

from ..config import Settings
from ..voices import VoiceInfo, discover_voices
from .base import BaseEngine, Event, attn_candidates, normalize_text, release_gpu, resolve_device


class RealtimeEngine(BaseEngine):
    id = "realtime"
    label = "VibeVoice-Realtime 0.5B"
    description = "Streaming, ~60 ms first audio. Single speaker, English-first."
    vram_gb = 3.0
    default_cfg_scale = 1.25
    default_steps = 5

    def __init__(self, settings: Settings) -> None:
        super().__init__()
        self.settings = settings
        self.model_path = settings.model_path
        self.inference_steps = settings.inference_steps
        self.device = resolve_device(settings.device)
        self._torch_device = torch.device(self.device)
        self.processor: Optional[VibeVoiceStreamingProcessor] = None
        self.model: Optional[VibeVoiceStreamingForConditionalGenerationInference] = None
        self._voices: Dict[str, VoiceInfo] = {}
        self._default_voice: Optional[str] = None
        self._voice_cache: Dict[str, Any] = {}

    @property
    def voices(self) -> Dict[str, VoiceInfo]:
        if not self._voices and self.settings.voices_dir:
            self._voices = discover_voices(self.settings.voices_dir)
        return self._voices

    @property
    def default_voice(self) -> Optional[str]:
        return self._default_voice or next(iter(self.voices), None)

    def unload(self) -> None:
        with self._model_lock:
            self.model = None
            self.processor = None
            self._voice_cache.clear()
            self.loaded = False
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            print(f"[engine:{self.id}] unloaded")

    # ------------------------------------------------------------------ load
    def load(self) -> None:
        t0 = time.time()
        if self.settings.voices_dir is None:
            raise RuntimeError(
                "No voices directory found. Pass --voices_dir or set VIBEVOICE_VOICES_DIR "
                "to <VibeVoice checkout>/demo/voices/streaming_model"
            )
        self._voices = discover_voices(self.settings.voices_dir)
        print(f"[engine:{self.id}] {len(self._voices)} voice presets from {self.settings.voices_dir}")

        print(f"[engine:{self.id}] loading processor from {self.model_path}")
        self.processor = VibeVoiceStreamingProcessor.from_pretrained(self.model_path)

        if self.device == "cuda":
            dtype, device_map = torch.bfloat16, "cuda"
        else:
            dtype, device_map = torch.float32, None if self.device == "mps" else "cpu"

        last_err = ""
        for impl in attn_candidates(self.settings.attn, self.device):
            try:
                print(f"[engine:{self.id}] loading model on {self.device} ({dtype}, attn={impl})")
                self.model = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
                    self.model_path, torch_dtype=dtype, device_map=device_map, attn_implementation=impl
                )
                self.attn_impl = impl
                break
            except Exception as exc:  # noqa: BLE001
                last_err = f"{type(exc).__name__}: {exc}"
                print(f"[engine:{self.id}] attn={impl} failed: {last_err}")
            release_gpu()  # after the except block: a partially built model must not keep VRAM
        if self.model is None:
            raise RuntimeError(f"Could not load model: {last_err}")
        if self.device == "mps":
            self.model.to("mps")
        self.model.eval()
        self.model.model.noise_scheduler = self.model.model.noise_scheduler.from_config(
            self.model.model.noise_scheduler.config,
            algorithm_type="sde-dpmsolver++",
            beta_schedule="squaredcos_cap_v2",
        )
        self.model.set_ddpm_inference_steps(num_steps=self.inference_steps)

        wanted = self.settings.default_voice
        if wanted and wanted in self.voices:
            self._default_voice = wanted
        elif "en-Carter_man" in self.voices:
            self._default_voice = "en-Carter_man"
        else:
            self._default_voice = next(iter(self.voices))
        self._voice_prompt(self._default_voice)
        self.loaded = True
        print(f"[engine:{self.id}] ready in {time.time() - t0:.1f}s, default voice {self.default_voice}")

    # ---------------------------------------------------------------- voices
    def _voice_prompt(self, voice_id: str) -> Any:
        if voice_id not in self._voice_cache:
            info = self.voices[voice_id]
            try:
                with torch.serialization.safe_globals([BaseModelOutputWithPast, DynamicCache]):
                    prompt = torch.load(info.path, map_location=self._torch_device, weights_only=True)
            except Exception as exc:  # noqa: BLE001 - newer torch rejects ModelOutput pickles
                print(f"[engine:{self.id}] safe load of {info.path.name} failed ({type(exc).__name__}); "
                      "falling back to weights_only=False (presets come from your VibeVoice checkout)")
                prompt = torch.load(info.path, map_location=self._torch_device, weights_only=False)
            self._voice_cache[voice_id] = prompt
            print(f"[engine:{self.id}] cached voice prompt {voice_id}")
        return self._voice_cache[voice_id]

    # ------------------------------------------------------------- alignment
    def token_offsets(self, text: str) -> Tuple[List[int], List[Tuple[int, int]]]:
        """Token ids and (char_start, char_end) for the exact sequence the model sees."""
        assert self.processor is not None
        tok = self.processor.tokenizer
        enc = tok(text.strip() + "\n", add_special_tokens=False, return_offsets_mapping=True)
        return list(enc["input_ids"]), [tuple(o) for o in enc["offset_mapping"]]

    # ------------------------------------------------------------- generate
    def _run_generation(self, inputs, streamer, errors, cfg_scale, prompt, stop_check, steps) -> None:
        try:
            with self._model_lock:
                if stop_check():
                    streamer.end()
                    return
                self.model.set_ddpm_inference_steps(num_steps=steps)
                self._generate_locked(inputs, streamer, cfg_scale, prompt, stop_check)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)
            traceback.print_exc()
            streamer.end()

    def _generate_locked(self, inputs, streamer, cfg_scale, prompt, stop_check) -> None:
        if True:
            self.model.generate(
                **inputs,
                max_new_tokens=None,
                cfg_scale=cfg_scale,
                tokenizer=self.processor.tokenizer,
                generation_config={"do_sample": False, "temperature": 1.0, "top_p": 1.0},
                audio_streamer=streamer,
                stop_check_fn=stop_check,
                verbose=False,
                refresh_negative=True,
                all_prefilled_outputs=copy.deepcopy(prompt),
            )

    def synthesize(
        self,
        text: str,
        voice_id: Optional[str] = None,
        cfg_scale: Optional[float] = None,
        inference_steps: Optional[int] = None,
        stop_event: Optional[threading.Event] = None,
        lang: Optional[str] = None,
    ) -> Iterator[Event]:
        """Yield meta, then interleaved audio/progress events, then done."""
        if cfg_scale is None:
            cfg_scale = self.default_cfg_scale
        if not self.loaded or self.model is None or self.processor is None:
            raise RuntimeError("engine not loaded")
        text = normalize_text(text).strip()
        if not text:
            yield Event("done", {"samples": 0, "seconds": 0.0})
            return
        voice = self.resolve_voice(voice_id)
        prompt = self._voice_prompt(voice)

        steps = self.inference_steps
        if inference_steps and inference_steps > 0:
            steps = int(inference_steps)

        token_ids, offsets = self.token_offsets(text)
        processed = self.processor.process_input_with_cached_prompt(
            text=text, cached_prompt=prompt, padding=True, return_tensors="pt", return_attention_mask=True
        )
        inputs = {k: (v.to(self._torch_device) if hasattr(v, "to") else v) for k, v in processed.items()}
        model_tokens = int(inputs["tts_text_ids"].shape[1])
        aligned = model_tokens == len(token_ids)
        if not aligned:
            print(f"[engine:{self.id}] offset mismatch: tokenizer {len(token_ids)} vs model {model_tokens}")

        yield Event(
            "meta",
            {
                "text": text,
                "voice": voice,
                "sample_rate": self.sample_rate,
                "tokens": model_tokens,
                "offsets": offsets if aligned else [],
                "text_window": TTS_TEXT_WINDOW_SIZE,
                "speech_window": TTS_SPEECH_WINDOW_SIZE,
                "cfg_scale": cfg_scale,
                "inference_steps": steps,
            },
        )

        streamer = AudioStreamer(batch_size=1, stop_signal=None, timeout=None)
        errors: list = []
        stop = stop_event or threading.Event()  # the caller's: never set by us
        internal = threading.Event()  # ours: ends the worker when the consumer goes away
        thread = threading.Thread(
            target=self._run_generation,
            args=(inputs, streamer, errors, cfg_scale, prompt, lambda: internal.is_set() or stop.is_set(), steps),
            daemon=True,
        )
        t0 = time.time()
        thread.start()

        samples = 0
        chunk_index = 0
        last_window = -1
        user_stopped = True  # overwritten when the loop completes
        try:
            for chunk in streamer.get_stream(0):
                if torch.is_tensor(chunk):
                    chunk = chunk.detach().cpu().to(torch.float32).numpy()
                else:
                    chunk = np.asarray(chunk, dtype=np.float32)
                chunk = chunk.reshape(-1)
                peak = float(np.max(np.abs(chunk))) if chunk.size else 0.0
                if peak > 1.0:
                    chunk = chunk / peak

                window = chunk_index // TTS_SPEECH_WINDOW_SIZE
                if window != last_window:
                    last_window = window
                    consumed = min((window + 1) * TTS_TEXT_WINDOW_SIZE, model_tokens)
                    yield Event(
                        "progress",
                        {
                            "window": window,
                            "tokens": consumed,
                            "samples": samples,
                            "char": offsets[consumed - 1][1] if aligned and consumed > 0 else None,
                        },
                    )
                pcm = (np.clip(chunk, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()
                samples += int(chunk.size)
                chunk_index += 1
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
        yield Event(
            "done",
            {
                "samples": samples,
                "seconds": round(seconds, 3),
                "elapsed_ms": int(elapsed * 1000),
                "rtf": round(elapsed / seconds, 3) if seconds else None,
                "stopped": user_stopped,
            },
        )


