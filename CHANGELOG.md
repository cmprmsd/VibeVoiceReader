# Changelog

## 0.4.6 — 2026-09-20

- Qwen3-TTS and MOSS-TTS streams no longer stall at the end of a sentence when
  the last frames arrive together (the worker pipe is now read by a thread)
- The keepalive that protects long exports also covers a model load that a
  request triggers, so a first use of a large model no longer drops the
  connection

## 0.4.5 — 2026-09-20

- A failed model load (e.g. 1.5B without flash-attention) no longer leaves the
  engine unusable or its half-loaded weights in VRAM; flash-attention is only
  tried when installed
- Engines missing on the server are marked "not installed" in the model list
- Docker image ships Kokoro and the experimental realtime voices; Qwen3-TTS and
  MOSS-TTS are build arguments (`ENGINE_QWEN`, `ENGINE_MOSS`)
- Models are unloaded after idle time (`--idle_unload_min`, default 10)
- The player shows the server's generation speed (RTF) while reading; the
  server logs it a few seconds into each request and at the end
- Switching models shows the new voice list at once
- Cancel in the export dialog stops the export
- Exports no longer end with an empty file: the server sends keepalive events
  while it is still choosing a take, so Firefox keeps the extension's
  background page (and with it the connection) alive; a dropped connection is
  reported and retried once instead of being saved as silence
- The realtime model no longer prints its progress bar into the server log

## 0.4.3 — 2026-09-19

- Servers on other machines work again: the extension's default content
  security policy upgraded plain `http://` requests to HTTPS for every host
  except localhost, which the server answered as invalid requests

## 0.4.2 — 2026-09-19

- Choosing a model loads it immediately and reports success or the reason it
  cannot be used; worker engines list their voices before loading
- Player bar wraps on narrow screens
- Readability's innerHTML uses are rewritten at build time (add-on linter is clean)

## 0.4.0 — 2026-09-19

- Kokoro 82M, Qwen3-TTS and MOSS-TTS Realtime as additional engines; the two
  latter run as worker processes in their own environments (`make engine-*`)
- Deterministic engines skip the glitch filter's extra takes
- The page language is sent with each request for engines that need it
- Sentence tracking keeps working in background tabs

## 0.3.1 — 2026-09-19

- Docker image and `compose.yml` for the server
- Player icons are built in the SVG namespace directly; the parsed-and-adopted
  variant from 0.2.2 rendered empty in Firefox content scripts

## 0.3.0 — 2026-09-18

- VibeVoice 1.5B and 7B as additional engines (voice cloning from reference
  clips, optional 8-bit/4-bit loading); model picker in the settings panel;
  engines load on demand and are evicted to respect VRAM

## 0.2.2 — 2026-09-18

- Minimum Firefox version raised to 140 (required by the Custom Highlight API
  and the data-collection manifest key); icons built without innerHTML

## 0.2.1 — 2026-09-18

- Settings moved into a floating panel in the player, with a colour picker and
  live preview for the highlight
- Vector icons for the transport controls and the drag handle

## 0.2.0 — 2026-09-18

First public release.

- Firefox extension (Manifest V3) with a floating player injected on demand
- Article, selection and click-to-pick reading with sentence highlighting
- Paragraph and sentence chunking; sentence boundaries inside a paragraph are
  located from pauses in the audio
- Voice switching while reading; voices grouped by language
- Pitch-preserving playback speed
- Glitch filter: best-of-N generation for prefetched chunks with server-side scoring
- MP3 (128/256 kbit/s) and WAV export with start/end trimming
- Local FastAPI server for VibeVoice-Realtime-0.5B with a framed HTTP stream,
  WebSocket endpoint, voice previews and a flash-attention build target
