# Architecture

```
Firefox                                          localhost
┌──────────────────────────────────┐   HTTP     ┌──────────────────────────────┐
│ content script (per page)        │◄──────────►│ server (FastAPI)             │
│  extract → segment → chunks      │            │  /voices /preview /health    │
│  session: prefetch, playback,    │            │  /tts/stream  /tts/stop      │
│  alignment, highlight            │            │  engine: VibeVoice-Realtime  │
│ background: relay, downloads     │            │  quality: best-of-N scoring  │
└──────────────────────────────────┘            └──────────────────────────────┘
```

## Server (`server/`)

- `tts.py` wraps the streaming model. `synthesize()` yields `meta` (text,
  token→character offsets), `progress` (tokens consumed vs. samples produced),
  PCM16 audio frames and `done`. Generation runs in a worker thread behind a
  mutex; the diffusion scheduler keeps state on the model, so requests never overlap.
- `synthesize_best()` generates up to N takes, scores each with `quality.py`
  (high-frequency bursts, sharp transients, dropouts) and replays the best.
  It stops early when a take scores clean or when another client is waiting.
- `app.py` exposes the framed HTTP stream the extension uses (plain `ws://`
  is blocked from Firefox extension contexts), a WebSocket for CLI tools, and
  serializes GPU access with a lock that is released only after the worker
  thread has ended, even if the client disconnects mid-stream.

## Engines

`engines/registry.py` holds every engine and loads them on demand, evicting
the least recently used ones beyond `--max_loaded`.  In-process engines:
VibeVoice realtime, the vendored VibeVoice 1.5B/7B long-form model, and
Kokoro.  `engines/worker.py` runs an engine in a separate process and virtual
environment (Qwen3-TTS, MOSS-TTS) because those packages pin conflicting
dependencies; the worker speaks the same framed protocol over stdin/stdout
(`workers/protocol.py`), redirects everything else it prints to stderr, and is
killed on unload, which guarantees that VRAM is released.  Requests carry the
page language for engines that need it; deterministic engines opt out of the
best-of-N glitch filter.

## Extension (`extension/src/`)

- `text-index.ts` builds a whitespace-normalized view of the visible text with
  a per-character map back to DOM nodes, so any text slice becomes a `Range`.
- `extract.ts` finds the article with Readability on a clone and maps it back
  onto the live DOM; drops captions, tables and infoboxes; falls back to the
  page's main region for app-like pages; clips selections at block boundaries;
  `extractFromElement` reads from a user-picked block.
- `segment.ts` splits sentences (`Intl.Segmenter`), keeps citations attached,
  merges fragments under four words, caps long sentences and builds chunks
  according to the chunking mode.
- `session.ts` fetches chunks ahead of playback, decides how many takes each
  may use from the buffered lead, tracks the active sentence and drives the
  highlighter. Restarts (voice or mode change, jumps) re-chunk from the current
  sentence so it opens a chunk.
- `alignment.ts` estimates sentence boundaries inside a paragraph chunk: pauses
  detected from audio energy are assigned to boundaries by a monotone dynamic
  program that balances pause length against a proportional prior floored by
  the server's progress events.
- `audio.ts` plays streamed PCM gaplessly with Web Audio; `stretch.ts` is a
  WSOLA time-stretcher for pitch-preserving speed. On underrun the player
  pauses and rebuffers rather than stitching gaps.
- `highlight.ts` uses the CSS Custom Highlight API with a `<mark>` fallback.
- `export.ts` synthesizes a sentence range with best-of-N, trims silence,
  inserts pauses, encodes MP3 (lamejs, upsampled to 48 kHz for 256 kbit/s) or
  WAV, and saves through the background's downloads API.
- `background.ts` injects the content script on demand (activeTab), requests
  the server origin permission on first use, relays the audio stream to the
  page over a port and handles downloads.

## Self-test

Builds with `VV_SELFTEST=1` (`npm run selftest`) inject into a page whose URL
contains `vv-selftest=1` and read it without user interaction, logging to
stdout. Query parameters select the scenario: `vv-paras=N`, `vv-mode=sentence`,
`vv-select=1`, `vv-selectword=1`, `vv-pickfirst=1`, `vv-switch=<voice>,<sec>`,
`vv-rate=<rate>,<sec>`, `vv-pause=<sec>,<sec>`, `vv-export=N`. Production
builds contain none of this code.
