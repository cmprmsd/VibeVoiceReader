.DEFAULT_GOAL := help

help:             ## list targets
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | sort | awk -F':.*## ' '{printf "  \033[1m%-18s\033[0m %s\n", $$1, $$2}'

VENV ?= .venv
PY   := $(VENV)/bin/python
VIBEVOICE ?= ../VibeVoice
ARGS ?=

.PHONY: setup server tts-test voices health version

setup:            ## create venv and install VibeVoice + server (clones VibeVoice next to this repo if missing)
	@test -d "$(VIBEVOICE)" || git clone --depth 1 https://github.com/microsoft/VibeVoice.git "$(VIBEVOICE)"
	uv venv --python 3.12 $(VENV)
	uv pip install --python $(PY) -e "$(VIBEVOICE)[streamingtts]" -e server kokoro

server:           ## run the TTS server (ARGS="--device cpu" etc.)
	$(PY) -m vibevoice_reader_server $(ARGS)

tts-test:         ## synthesize a test sentence to /tmp/vv-test.wav
	$(PY) -m vibevoice_reader_server.tools.ws_client --out /tmp/vv-test.wav $(ARGS)

VOICE_SAMPLES_DIR ?= $(HOME)/.cache/vibevoice-reader/voices
VOICE_SAMPLES := en-Alice_woman en-Carter_man en-Frank_man en-Maya_woman in-Samuel_man zh-Bowen_man zh-Xinran_woman

voices:           ## download reference clips for the 1.5B/7B models (any 24 kHz mono .wav works too)
	@mkdir -p $(VOICE_SAMPLES_DIR)
	@for v in $(VOICE_SAMPLES); do \
	  test -f $(VOICE_SAMPLES_DIR)/$$v.wav || curl -sfL -o $(VOICE_SAMPLES_DIR)/$$v.wav \
	    https://raw.githubusercontent.com/vibevoice-community/VibeVoice/main/demo/voices/$$v.wav && echo "  $$v.wav"; \
	done
	@echo "voice samples in $(VOICE_SAMPLES_DIR)"

list-voices:      ## voices the running server offers
	curl -s http://127.0.0.1:8877/voices | $(PY) -m json.tool | head -40

health:           ## server health
	curl -s http://127.0.0.1:8877/health

# ---------------------------------------------------------------- extra engines
# Kokoro lives in the main environment (`make setup` installs it; it needs
# espeak-ng from your distribution).  Qwen3-TTS and MOSS-TTS pin dependencies
# that conflict with VibeVoice, so each gets its own environment and runs as a
# worker process started by the server on demand.
.PHONY: engine-kokoro engine-qwen engine-moss

engine-kokoro:    ## install kokoro into the main environment (needs espeak-ng)
	uv pip install --python $(PY) kokoro
	@which espeak-ng >/dev/null || echo "install espeak-ng with your package manager (e.g. pacman -S espeak-ng / apt install espeak-ng)"

engine-qwen:      ## separate environment with faster-qwen3-tts (CUDA-graph streaming inference)
	uv venv --python 3.12 .venv-qwen
	uv pip install --python .venv-qwen/bin/python torch --index-url https://download.pytorch.org/whl/cu130
	uv pip install --python .venv-qwen/bin/python faster-qwen3-tts "transformers==5.16.1" librosa
	@which sox >/dev/null || echo "note: install sox with your package manager if the worker complains about it"

MOSS_REV ?= main
engine-moss:      ## separate environment with the MOSS-TTS checkout
	@mkdir -p build
	@test -d build/moss-tts || git clone -q --depth 1 --branch $(MOSS_REV) https://github.com/OpenMOSS/MOSS-TTS.git build/moss-tts
	uv venv --python 3.12 .venv-moss
	uv pip install --python .venv-moss/bin/python --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/cu128 -e "build/moss-tts[torch-runtime]"

# ---------------------------------------------------------------- extension
.PHONY: ext-setup ext-build ext-watch ext-run ext-lint ext-package

ext-setup:        ## npm install
	cd extension && npm install --no-audit --no-fund

ext-build:        ## bundle to extension/dist
	cd extension && npm run build

ext-watch:        ## rebuild on change
	cd extension && npm run watch

ext-run:          ## launch a temporary Firefox profile with the extension loaded
	cd extension && npm run start

ext-lint:         ## add-on linter on the built extension
	cd extension && npm run lint

version:          ## set a new version everywhere: make version V=0.5.0 (adds a CHANGELOG heading)
	@test -n "$(V)" || { echo "usage: make version V=X.Y.Z"; exit 1; }
	@cur=$$(node -p "require('./extension/static/manifest.json').version"); \
	  sed -i "s/\"version\": \"$$cur\"/\"version\": \"$(V)\"/" extension/static/manifest.json extension/package.json extension/package-lock.json; \
	  sed -i "s/^version = \"$$cur\"/version = \"$(V)\"/" server/pyproject.toml; \
	  sed -i "s/^__version__ = \"$$cur\"/__version__ = \"$(V)\"/" server/vibevoice_reader_server/__init__.py; \
	  grep -q "^## $(V) " CHANGELOG.md || sed -i "0,/^## /s//## $(V) — $$(date +%F)\n\n- \n\n## /" CHANGELOG.md; \
	  echo "$$cur -> $(V)"; git grep -n "\"$(V)\"\|^## $(V) " -- extension/static/manifest.json extension/package.json extension/package-lock.json server CHANGELOG.md

ext-package:      ## build extension/web-ext-artifacts/vibevoice_reader-<version>.zip and .xpi
	cd extension && npm run package && v=$$(node -p "require('./static/manifest.json').version") && \
	  cp "web-ext-artifacts/vibevoice_reader-$$v.zip" "web-ext-artifacts/vibevoice_reader-$$v.xpi"

# KEY=value lines: AMO_JWT_ISSUER, AMO_JWT_SECRET
SIGNING_ENV ?= $(HOME)/.mozilla-signing

ext-publish-public: ## submit a PUBLIC (listed) version to addons.mozilla.org for review; visible in search after approval
ext-publish: ext-publish-public  ## alias of ext-publish-public
ext-publish-public:
	@test -f "$(SIGNING_ENV)" || { echo "missing $(SIGNING_ENV)"; exit 1; }
	git archive --format=zip -o extension/web-ext-artifacts/source-$$(node -p "require('./extension/static/manifest.json').version").zip HEAD
	cd extension && npm run build && set -a && . "$(SIGNING_ENV)" && set +a && \
	  WEB_EXT_API_KEY="$$AMO_JWT_ISSUER" WEB_EXT_API_SECRET="$$AMO_JWT_SECRET" \
	  npx web-ext sign --source-dir dist --channel listed --amo-metadata amo-metadata.json \
	    --upload-source-code web-ext-artifacts/source-$$(node -p "require('./static/manifest.json').version").zip

ext-sign:         ## sign an UNLISTED build for install from a file; SIGN_VERSION=0.4.6.1 signs under another version (a listed version cannot be reused)
	@test -f "$(SIGNING_ENV)" || { echo "missing $(SIGNING_ENV) (AMO_JWT_ISSUER=… / AMO_JWT_SECRET=…)"; exit 1; }
	@cur=$$(node -p "require('./extension/static/manifest.json').version"); v="$${SIGN_VERSION:-$$cur}"; \
	  trap 'sed -i "s/\"version\": \"$$v\"/\"version\": \"$$cur\"/" extension/static/manifest.json' EXIT; \
	  sed -i "s/\"version\": \"$$cur\"/\"version\": \"$$v\"/" extension/static/manifest.json; \
	  cd extension && npm run build && set -a && . "$(SIGNING_ENV)" && set +a && \
	  WEB_EXT_API_KEY="$$AMO_JWT_ISSUER" WEB_EXT_API_SECRET="$$AMO_JWT_SECRET" \
	  npx web-ext sign --source-dir dist --channel unlisted
	@echo "signed: $$(ls -t extension/web-ext-artifacts/*.xpi | head -1)"

# ---------------------------------------------------------------- flash-attention
# The model was tuned with flash-attention 2; the demo warns SDPA lowers audio
# quality. PyPI's build hardcodes C++17, but torch >= 2.14 headers need C++20,
# so this clones the release, patches the flag and compiles for Ampere (sm_80,
# covers RTX 30xx/A-series; set FA_ARCHS=90 for Hopper, 89 for Ada).
FA_VERSION ?= v2.8.3.post1
FA_ARCHS ?= 80
FA_HOST_CXX ?= /usr/bin/g++-15
FA_SRC := build/flash-attention

flash-attn:       ## build + install flash-attention into the venv (takes 20-60 min)
	@mkdir -p build
	@test -d $(FA_SRC) || git clone -q --depth 1 --branch $(FA_VERSION) https://github.com/Dao-AILab/flash-attention.git $(FA_SRC)
	cd $(FA_SRC) && git submodule update --init --depth 1 csrc/cutlass && sed -i 's/-std=c++17/-std=c++20/g' setup.py
	uv pip install --python $(PY) ninja packaging
	CUDA_HOME=$${CUDA_HOME:-/opt/cuda} PATH=$${CUDA_HOME:-/opt/cuda}/bin:$$PATH \
	  CUDAHOSTCXX=$(FA_HOST_CXX) NVCC_PREPEND_FLAGS="-ccbin $(FA_HOST_CXX)" \
	  FLASH_ATTN_CUDA_ARCHS=$(FA_ARCHS) MAX_JOBS=$${MAX_JOBS:-8} FLASH_ATTENTION_FORCE_BUILD=TRUE \
	  uv pip install --python $(PY) --no-build-isolation --no-cache-dir $(FA_SRC)
	$(PY) -c "import flash_attn; print('flash_attn', flash_attn.__version__)"
