#!/bin/sh
# Maps environment variables onto server options; any extra arguments are passed through.
set -e
args="--host 0.0.0.0 --port ${PORT:-8877}"
[ -n "$DEVICE" ]           && args="$args --device $DEVICE"
[ -n "$ATTN" ]             && args="$args --attn $ATTN"
[ -n "$MODELS" ]           && args="$args --models $MODELS"
[ -n "$DEFAULT_MODEL" ]    && args="$args --default_model $DEFAULT_MODEL"
[ -n "$MAX_LOADED" ]       && args="$args --max_loaded $MAX_LOADED"
[ -n "$IDLE_UNLOAD_MIN" ]  && args="$args --idle_unload_min $IDLE_UNLOAD_MIN"
[ -n "$QWEN_MODEL" ]       && args="$args --qwen_model $QWEN_MODEL"
[ -n "$MOSS_MODEL" ]       && args="$args --moss_model $MOSS_MODEL"
# worker engines built into the image (ENGINE_QWEN=1 / ENGINE_MOSS=1 build arguments)
[ -x /opt/venv-qwen/bin/python ] && args="$args --qwen_python /opt/venv-qwen/bin/python"
[ -x /opt/venv-moss/bin/python ] && args="$args --moss_python /opt/venv-moss/bin/python --moss_src /opt/moss-tts"
[ -n "$QUANT_15B" ]        && args="$args --quant_15b $QUANT_15B"
[ -n "$QUANT_7B" ]         && args="$args --quant_7b $QUANT_7B"
[ -n "$INFERENCE_STEPS" ]  && args="$args --inference_steps $INFERENCE_STEPS"
[ -n "$DEFAULT_VOICE" ]    && args="$args --default_voice $DEFAULT_VOICE"
# built-in clips first, then the (optionally mounted) user folder; user clips win on equal names
args="$args --voice_samples_dir ${VOICE_SAMPLES_DIR:-/opt/voices:/data/cache/vibevoice-reader/voices} --cache_dir /data/cache/vibevoice-reader"
exec python -m vibevoice_reader_server $args "$@"
