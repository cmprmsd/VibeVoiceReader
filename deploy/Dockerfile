# VibeVoice Reader server image.
# Runtime CUDA libraries come with the PyTorch wheels; the host only needs the
# NVIDIA driver and the NVIDIA Container Toolkit.
FROM python:3.12-slim AS base

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/data/huggingface \
    XDG_CACHE_HOME=/data/cache \
    VIBEVOICE_VOICES_DIR=/opt/VibeVoice/demo/voices/streaming_model

RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# VibeVoice (model code + streaming voice presets) at a pinned revision.
ARG VIBEVOICE_REPO=https://github.com/microsoft/VibeVoice.git
ARG VIBEVOICE_REV=main
RUN git clone --depth 1 --branch "${VIBEVOICE_REV}" "${VIBEVOICE_REPO}" /opt/VibeVoice

# CUDA build of PyTorch, then VibeVoice and the server.
ARG TORCH_INDEX=https://download.pytorch.org/whl/cu130
RUN pip install --index-url "${TORCH_INDEX}" torch \
    && pip install -e "/opt/VibeVoice[streamingtts]" bitsandbytes

COPY server /opt/server
RUN pip install -e /opt/server kokoro

# gcc: Triton (used by the model's kernels) compiles a small C launcher at runtime; espeak-ng: Kokoro's
# phonemizer; wget: the experimental voices script.
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev espeak-ng wget && rm -rf /var/lib/apt/lists/*

# Extra experimental voices (German, French, Japanese, ...) for the realtime model; compose.yml sets it.
ARG EXPERIMENTAL_VOICES=1
RUN if [ "${EXPERIMENTAL_VOICES}" = "1" ]; then bash /opt/VibeVoice/demo/download_experimental_voices.sh; fi

# Reference clips for the cloning engines (1.5B, 7B, Qwen Base, MOSS), built in
# read-only at /opt/voices; a folder mounted at /data/cache/vibevoice-reader/voices adds to them.
RUN mkdir -p /opt/voices && cd /opt/voices && for v in en-Alice_woman en-Carter_man en-Frank_man en-Maya_woman in-Samuel_man zh-Bowen_man zh-Xinran_woman; do \
      curl -sfL -o "$v.wav" "https://raw.githubusercontent.com/vibevoice-community/VibeVoice/main/demo/voices/$v.wav"; done

COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /data/huggingface /data/cache/vibevoice-reader/voices

EXPOSE 8877
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD curl -sf http://127.0.0.1:8877/health || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
