# VibeVoice Reader

Read any web page aloud with a voice model that runs on your own machine.
A Firefox extension adds a floating player to the page, highlights the sentence
being spoken, and talks to a local server that runs Microsoft's open
[VibeVoice](https://github.com/microsoft/VibeVoice) models. Nothing leaves your
computer.

- Reads the article on a page, a selection, or any block you click on
- Follow-along sentence highlighting, next/previous sentence, position kept across pause and stop
- Six engines: VibeVoice realtime 0.5B, 1.5B and 7B, Kokoro 82M, Qwen3-TTS and MOSS-TTS Realtime, with preset voices or cloning from a reference clip
- Voice and model switchable while reading; speed 0.75× to 2× without changing pitch
- Optional glitch filter: chunks generated ahead of playback are synthesized more than once and the cleanest take is used
- Export the page or a sentence range as MP3 (up to 256 kbit/s) or WAV

## Requirements

| | |
|---|---|
| GPU | NVIDIA with 4 GB free VRAM for the realtime model, 8 GB for the 1.5B, 12 GB+ for the 7B. Apple Silicon and CPU work but are slower than real time |
| Server | Python 3.10–3.12 with [uv](https://docs.astral.sh/uv/), or Docker with the NVIDIA Container Toolkit |
| Extension | Firefox 140 or newer; Node.js 18+ only when building from source |

## Quick start

### Server, native

```bash
git clone https://github.com/cmprmsd/VibeVoiceReader.git vibevoice-reader
cd vibevoice-reader

make setup       # Python environment; clones microsoft/VibeVoice next to this repo for the model code and presets
make voices      # reference clips for the cloning engines (optional)
make server      # http://127.0.0.1:8877 — downloads the model on first start
```

The realtime voice presets come with the VibeVoice checkout. For its additional
experimental voices run `bash ../VibeVoice/demo/download_experimental_voices.sh`
once and restart the server.

### Server, Docker

```bash
docker compose up -d --build     # http://127.0.0.1:8877
```

Needs the NVIDIA Container Toolkit for GPU access (`DEVICE: cpu` in
`compose.yml` runs without one). The image clones VibeVoice itself and ships
the realtime presets including the experimental voices, a set of reference
clips and Kokoro. Models download on first start into the `data` volume.
Engines, quantization and the default model are environment variables in
`compose.yml`. Qwen3-TTS and MOSS-TTS are built into the image with the
`ENGINE_QWEN` / `ENGINE_MOSS` build arguments; until then they show as "not
installed" in the model list. Models are unloaded after ten idle minutes
(`IDLE_UNLOAD_MIN`) and load again on the next request.

### Extension

- **From a release**: open the signed `.xpi` from the
  [releases page](https://github.com/cmprmsd/VibeVoiceReader/releases) with
  Firefox (File → Open) and confirm.
- **From source**: `make ext-setup ext-build`, then load
  `extension/dist/manifest.json` via `about:debugging#/runtime/this-firefox` →
  *Load Temporary Add-on*. Temporary add-ons disappear when Firefox restarts;
  a permanent install needs a build signed by Mozilla, which `make ext-sign`
  produces with your own add-on developer credentials.

Click the toolbar icon on any page. Firefox asks once for permission to reach
the local server.

## Using the player

| Control | Action |
|---|---|
| Voice | Change the voice, also while reading; the current sentence restarts in the new voice |
| ⏮ ▶ ⏭ ⏹ | Previous sentence, play/pause, next sentence, stop (position is remembered) |
| Speed | 0.75×–2×, pitch preserved |
| Paragraph / Sentence / Auto | How much text the model gets per request. Paragraph flows better; Sentence gives exact highlighting |
| Selection | Read the selected text (also `Alt+Shift+S` or the context menu). Selections under four words are widened to their sentence |
| Page | Read the main text of the page |
| Pick | Click a block on the page and read from there — for chats, editors and other app-like pages |
| ⤓ | Export as MP3 or WAV, with sliders to trim the start and end |
| ⚙ | Settings panel: model, server URL, glitch filter, diffusion steps, guidance scale, highlight colour with live preview |

`Alt+Shift+V` toggles the player.

## Models

| Model | VRAM | Character |
|---|---|---|
| VibeVoice-Realtime 0.5B (default) | ~3 GB | Streams from the first word, about 60 ms to first audio. Single speaker, English-first, 60+ preset voices |
| VibeVoice 1.5B | ~6 GB | More natural; clones any voice from a short reference clip. Streams while generating: first audio in about 0.3 s once loaded, generation about 2× faster than playback on an 8 GB card |
| VibeVoice 7B | 12 GB+ card (4-bit peaks above 8 GB while loading; 8-bit ~11 GB) | Best quality; same interface as 1.5B. Loaded in 4-bit by default |
| Kokoro 82M | ~0.5 GB, CPU works | Very fast and stable, 54 preset voices in 9 languages (no German), no cloning. Deterministic, so the glitch filter is skipped |
| Qwen3-TTS 0.6B / 1.7B | ~3 GB / ~6 GB | 10 languages including German; the page language is sent with each request. `*-CustomVoice` checkpoints ship 9 preset speakers; `*-Base` checkpoints clone your reference clips. Streams through `faster-qwen3-tts` |
| MOSS-TTS Realtime | 12 GB+ card (1.7B model plus a large codec; does not fit in 8 GB) | 20 languages including German, voice cloning from a clip |

VibeVoice and Kokoro run inside the server. Qwen3-TTS and MOSS-TTS pin
dependencies that conflict with VibeVoice, so each runs as a worker process in
its own environment that the server starts on demand:

```bash
make engine-kokoro    # kokoro into the main environment; needs espeak-ng from your distribution
make engine-qwen      # .venv-qwen with qwen-tts
make engine-moss      # .venv-moss with the MOSS-TTS checkout in build/
```

Engines that are not installed are listed greyed out in the model picker.

Pick the model in the player settings. Weights download from Hugging Face on
first use. One model is kept in VRAM at a time (`--max_loaded`), so switching
unloads the previous one; `--models realtime,1.5b` preloads several.

### Adding voices

The cloning engines (1.5B, 7B, Qwen `*-Base`, MOSS) take any 24 kHz mono
`.wav` clip of a few seconds as a voice. Name it `xx-Name_gender.wav`
(`de-Anna_woman.wav`) and drop it into a clip folder: natively
`~/.cache/vibevoice-reader/voices`, in Docker a folder mounted at
`/data/cache/vibevoice-reader/voices`. Folders are rescanned whenever a file
changes, so new clips appear on the next model load or switch; nothing needs a
rebuild, and the built-in clips and the realtime presets are never touched.
`--voice_samples_dir a:b` reads several folders, later ones winning on equal names.

Quantization (`--quant_15b`, `--quant_7b`: `none`, `nf4`, `int8`) applies to
the language model only. 4-bit costs about a third of the speed compared to
bf16; 8-bit through bitsandbytes is markedly slower and only worth it on a
fast GPU. Playback needs generation to stay faster than real time: the player
prefetches ahead, but a model that generates slower than it plays will pause
to buffer.

## Settings that affect audio quality

The models' samplers are stochastic, so an occasional glitch is normal and the
same text usually comes out clean on the next try.

- **Glitch filter** (default: 2 takes) — chunks generated ahead of playback are
  synthesized up to N times, scored for crackle, clicks and dropouts, and the
  best take is used. Extra takes are only spent while enough audio is buffered
  and no other client is waiting for the GPU. Exports always use it.
- **Guidance scale** (default 1.25 realtime, 1.3 long-form) — lower is cleaner, higher is more expressive.
- **Diffusion steps** (default 5 realtime, 10 long-form) — more steps cost speed.

## Server

```
GET  /health              loaded engines, device, attention backend, queue state
GET  /models              engines, VRAM hints, which are loaded
GET  /voices?model=       voice list with language, gender and preview URL
GET  /preview/{voice}     cached WAV sample
POST /tts/stream          {text, voice, model, cfg_scale, inference_steps, candidates}
                          → framed stream: 1 byte type (1 JSON, 2 PCM16), uint32 length, payload
POST /tts/stop/{id}       stop a running request
WS   /tts                 same events over a WebSocket (used by the CLI tools)
```

Audio is mono PCM16 at 24 kHz. Requests are served one at a time; additional
clients queue. Options (`make server ARGS="…"`):

| Option | Purpose |
|---|---|
| `--models realtime,1.5b` | engines loaded at start; others load on first request |
| `--default_model`, `--max_loaded` | engine used when the client sends none; engines kept in VRAM |
| `--idle_unload_min` | free VRAM after this many idle minutes (default 10; 0 never) |
| `--quant_15b`, `--quant_7b` | `none`, `nf4` or `int8` |
| `--qwen_model`, `--moss_model` | checkpoints for the worker engines; `--qwen_python`, `--moss_python` point at their environments |
| `--voices_dir`, `--voice_samples_dir` | realtime presets (`*.pt`); reference clips (`*.wav`) |
| `--device`, `--attn`, `--port`, `--host` | `auto`/`cuda`/`mps`/`cpu`; `auto`/`flash_attention_2`/`sdpa` |

`make flash-attn` builds flash-attention 2 for the environment (the attention
implementation the models were trained with); the server uses it automatically
when present.

## Troubleshooting

- **"Server unreachable"** — start the server, and check the URL in the settings
  panel. Access to a server outside localhost must be granted on the extension's
  settings page in `about:addons`.
- **"CUDA out of memory"** when switching models — the model does not fit next
  to whatever else uses the GPU. Pick a smaller model or a quantized variant;
  the server falls back cleanly after a failed load.
- **First request after idle is slow** — the GPU clocks down; the second
  request is fast again.
- **Crackle** — lower the guidance scale, keep the glitch filter on, or jump back
  one sentence to regenerate it.
- **Docker: "failed to fulfil mount request: … libnvidia-….so: no such file"**
  — the NVIDIA runtime's device spec is older than the installed driver
  libraries. Regenerate it: `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`.

## Development

```bash
make ext-watch                       # rebuild on change
cd extension && npm run selftest     # Firefox with an automated read of a test page
make tts-test                        # synthesize a sentence from the command line
```

`server/vibevoice_reader_server/tools/` contains CLI clients, a stop/abort
regression test and a quality benchmark. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## License

MIT. VibeVoice and its model weights are licensed separately by Microsoft.
