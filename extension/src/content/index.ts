/**
 * VibeVoice Reader content script — injected on demand via the toolbar button,
 * the context menu or the keyboard shortcut.  Idempotent: a second injection
 * only re-sends the command to the existing instance.
 */
import type { BgRequest, ContentCommand, ModelsResponse, VoicesResponse } from "../shared/messages";
import { loadSettings, saveSettings, type ChunkMode, type Settings } from "../shared/settings";
import { ExportJob, FORMAT_LABELS, type ExportFormat } from "./export";
import { extractArticle, extractFromElement, extractSelection, type Extraction } from "./extract";
import { Highlighter } from "./highlight";
import { pickBlock } from "./pick";
import { PlayerUI } from "./player-ui";
import { buildChunks, splitSentences } from "./segment";
import { ReadingSession } from "./session";

declare const __SELFTEST__: boolean;
const log = (...a: unknown[]) => {
  if (__SELFTEST__) console.log("[vv-selftest]", ...a);
};

declare global {
  interface Window {
    __vibevoiceReader?: Reader;
  }
}

const SAMPLE_RATE = 24000;

class Reader {
  private ui: PlayerUI;
  private settings: Settings | null = null;
  private session: ReadingSession | null = null;
  private ctx: AudioContext | null = null;
  private lastExtraction: Extraction | null = null;

  constructor() {
    this.ui = new PlayerUI({
      onPlayPause: () => this.togglePlay(),
      onStop: () => this.stop(),
      onPrev: () => this.session?.prev(),
      onNext: () => this.session?.next(),
      onReadSelection: () => this.readSelection(),
      onReadPage: () => this.readPage(),
      onPick: () => this.pick(),
      onExport: () => this.openExport(),
      onVoiceChange: (voice) => this.switchVoice(voice),
      onRateChange: (rate) => {
        void this.update({ rate });
        this.session?.setRate(rate);
      },
      onModeChange: (chunkMode) => {
        void this.update({ chunkMode });
        if (this.lastExtraction && this.session) this.rebuild(chunkMode);
      },
      onSettings: () => this.openSettings(),
      onClose: () => this.hide(),
    });
  }

  private dead = false;

  mountMarker(): void {
    this.ui.mount();
    this.ui.host.addEventListener(SHUTDOWN, () => {
      this.dead = true;
      this.stop();
      this.ui.host.remove();
    });
  }

  private async update(patch: Partial<Settings>): Promise<void> {
    this.settings = await saveSettings(patch);
  }

  async show(): Promise<void> {
    this.ui.show();
    if (!this.settings) await this.loadVoices();
  }
  hide(): void {
    this.stop();
    this.exportJob?.cancel();
    this.exportJob = null;
    this.ui.closeDialog();
    this.previewHighlighter?.destroy();
    this.previewHighlighter = null;
    this.ui.hide();
  }
  toggle(): void {
    if (this.ui.visible) this.hide();
    else void this.show();
  }

  private async loadVoices(): Promise<void> {
    this.settings = await loadSettings();
    this.ui.setRate(this.settings.rate);
    this.ui.setMode(this.settings.chunkMode);
    try {
      const res = (await browser.runtime.sendMessage({ type: "voices", model: this.settings.model } satisfies BgRequest)) as VoicesResponse;
      this.ui.setVoices(res.voices, this.settings.voice, res.default);
      this.ui.setStatus(res.voices.length ? "" : "This model has no voices yet — add reference clips or pick another model", !res.voices.length);
      log("voices", res.voices.length, "default", res.default, "transport", this.settings.transport);
    } catch (e) {
      log("voices FAILED", String(e));
      const allowed = await browser.runtime.sendMessage({ type: "hasPermission" } satisfies BgRequest).catch(() => true);
      this.ui.setVoicesPlaceholder(allowed ? "Server unreachable" : "Server access not granted");
      this.ui.setStatus(
        allowed
          ? `Server unreachable at ${this.settings.serverUrl} — start it with "make server" or "docker compose up -d"`
          : "Access to the server was not granted — click the toolbar button and allow it",
        true,
      );
    }
  }

  // ------------------------------------------------------------ reading
  readSelection(): void {
    void this.show().then(() => {
      const ex = extractSelection();
      if (!ex) {
        this.ui.setStatus("Select some text first, or press Page to read the article");
        return;
      }
      this.read(ex);
    });
  }

  readPage(): void {
    void this.show().then(() => {
      this.ui.setStatus("Finding the main text…");
      const ex = extractArticle();
      this.read(ex);
    });
  }

  /**
   * Switch voices while reading: everything generated so far is in the old
   * voice, so re-chunk from the current sentence and start it again with the
   * new voice (a paused session stays paused).
   */
  private switchVoice(voice: string): void {
    if (this.settings) this.settings.voice = voice;
    void this.update({ voice });
    if (!this.session || !this.lastExtraction) return;
    const at = Math.max(0, this.session.currentSentence);
    const playing = this.session.currentState === "playing" || this.session.currentState === "loading";
    log("switch voice to", voice, "at sentence", at, playing ? "(playing)" : "(paused)");
    this.read(this.lastExtraction, at, !playing);
  }

  private read(ex: Extraction, fromSentence = 0, startPaused = false): void {
    this.previewHighlighter?.destroy();
    this.previewHighlighter = null;
    this.stop();
    if (!this.settings) return;
    this.lastExtraction = ex;
    const lang = document.documentElement.lang || navigator.language || "en";
    const sentences = splitSentences(ex.paragraphs, lang);
    if (sentences.length === 0) {
      this.ui.setStatus("No readable text found", true);
      return;
    }
    // The start sentence always opens a chunk, so restarts (voice or mode
    // change, jumps) begin exactly there instead of mid-paragraph.
    const k = Math.min(Math.max(0, fromSentence), sentences.length - 1);
    const chunks = [...buildChunks(sentences.slice(0, k), this.settings.chunkMode), ...buildChunks(sentences.slice(k), this.settings.chunkMode)];
    chunks.forEach((c, i) => (c.id = i));
    log(
      "extracted",
      ex.source,
      `${ex.paragraphs.length} paragraphs, ${sentences.length} sentences, ${chunks.length} chunks, ${sentences.filter((s) => !s.range).length} without range, unlocated ${ex.unlocated}`,
    );
    if (ex.unlocatedSamples.length) log("unlocated samples:", JSON.stringify(ex.unlocatedSamples), "skipped captions", ex.skippedCaptions ?? 0);
    this.ctx ??= new AudioContext({ sampleRate: SAMPLE_RATE });
    const session = new ReadingSession(
      chunks,
      this.settings,
      this.ctx,
      {
        onState: (state, detail) => {
          if (this.session !== session) return;
          log("state", state, detail ?? "");
          switch (state) {
            case "loading":
              this.ui.setState("loading");
              this.ui.setStatus(detail ?? "Generating…");
              break;
            case "playing":
              this.ui.setState("playing");
              this.ui.setStatus(detail ?? "");
              break;
            case "paused":
              this.ui.setState("paused");
              this.ui.setStatus(detail ?? "Paused");
              break;
            case "ended":
              this.ui.setState("paused");
              this.ui.setStatus("Finished");
              break;
            case "error":
              this.ui.setState("error");
              this.ui.setStatus(detail ?? "Error", true);
              break;
            case "idle":
              this.ui.setState("idle");
              break;
          }
        },
        onSentence: (s, index, total) => {
          if (this.session !== session) return;
          this.ui.setCounter(index, total);
          this.ui.setNavEnabled(index > 0, index < total - 1);
          if (s) log("sentence", index, JSON.stringify(s.text.slice(0, 60)));
        },
        onRtf: (rtf) => {
          if (this.session === session) this.ui.setRtf(rtf);
        },
        onTime: (elapsed, total, estimated) => {
          if (this.session === session) this.ui.setTime(elapsed, total, estimated);
        },
      },
      log,
    );
    this.session = session;
    this.ui.setStatus(
      ex.source === "article" ? `Reading: ${ex.title}` : ex.source === "body" ? "Reading the whole page (no article detected)" : "Reading selection",
    );
    void session.start(k, startPaused);
    if (__SELFTEST__ && !this.selftestSwitched) {
      this.selftestSwitched = true;
      const m = /vv-switch=([\w-]+)(?:,(\d+))?/.exec(location.href);
      if (m) setTimeout(() => this.switchVoice(m[1]), Number(m[2] ?? 5) * 1000);
      const r = /vv-rate=([\d.]+),(\d+)/.exec(location.href);
      if (r) setTimeout(() => { log("set rate", r[1]); this.ui.setRate(Number(r[1])); this.session?.setRate(Number(r[1])); }, Number(r[2]) * 1000);
      const pz = /vv-pause=(\d+),(\d+)/.exec(location.href);
      if (pz) {
        setTimeout(() => { log("pause at", this.session?.currentSentence); this.session?.pause(); }, Number(pz[1]) * 1000);
        setTimeout(() => { log("resume after idle; sentence", this.session?.currentSentence); void this.session?.resume(); }, Number(pz[2]) * 1000);
      }
    }
  }
  private selftestSwitched = false;
  private selftestStarted = false;

  // ------------------------------------------------------------ settings
  private previewHighlighter: Highlighter | null = null;

  openSettings(): void {
    void this.show().then(async () => {
      if (!this.settings) return;
      const s = this.settings;
      let models: ModelsResponse | null = null;
      try {
        models = (await browser.runtime.sendMessage({ type: "models" } satisfies BgRequest)) as ModelsResponse;
      } catch {
        models = null;
      }
      this.ui.showSettingsDialog(
        { serverUrl: s.serverUrl, model: s.model, candidates: s.candidates, inferenceSteps: s.inferenceSteps, cfgScale: s.cfgScale, highlightColor: s.highlightColor, transport: s.transport },
        models,
        {
          onChange: (patch) => {
            void this.update(patch as Partial<Settings>).then(async () => {
              if ("serverUrl" in patch) void this.loadVoices();
              if ("model" in patch) await this.activateModel((patch as { model: string | null }).model);
            });
          },
          onPreviewColor: (css) => {
            if (this.session) this.session.setHighlightColor(css);
            else {
              // no session: show the colour on the first paragraph of the page
              this.previewHighlighter ??= new Highlighter();
              this.previewHighlighter.setColor(css);
              const p = document.querySelector("main p, article p, p");
              if (p) {
                const r = document.createRange();
                r.selectNodeContents(p);
                this.previewHighlighter.set(r);
              }
            }
          },
          onTestServer: async (url) => {
            await this.update({ serverUrl: url });
            // which request methods get through from this browser (some block POST to LAN hosts)
            const probe = (await browser.runtime.sendMessage({ type: "probe" } satisfies BgRequest).catch((e) => `probe failed: ${e}`)) as string;
            log("probe", probe);
            try {
              const h = (await browser.runtime.sendMessage({ type: "health" } satisfies BgRequest)) as { model: string; device: string; attn: string; voices: number };
              await this.loadVoices();
              return `OK — ${h.model.split("/").pop()} on ${h.device} (${h.attn}), ${h.voices} voices · ${probe}`;
            } catch (e) {
              const allowed = await browser.runtime.sendMessage({ type: "hasPermission" } satisfies BgRequest).catch(() => true);
              return `${allowed ? `Cannot reach ${url}` : "Not allowed: grant access in the extension settings"} · ${probe}`;
            }
          },
          onOpenExtensionSettings: () => void browser.runtime.sendMessage({ type: "openOptions" } satisfies BgRequest),
        },
      );
    });
  }

  // ------------------------------------------------------------ pick & export
  private pickCleanup: (() => void) | null = null;

  pick(): void {
    void this.show().then(() => {
      this.pickCleanup?.();
      this.ui.setStatus("Click the block to start reading from (Esc to cancel)");
      this.pickCleanup = pickBlock((el) => {
        this.pickCleanup = null;
        if (!el) {
          this.ui.setStatus("");
          return;
        }
        const ex = extractFromElement(el);
        log("picked", el.tagName, `${ex.paragraphs.length} paragraphs`);
        if (ex.paragraphs.length === 0) {
          this.ui.setStatus("No readable text in that block", true);
          return;
        }
        this.read(ex);
      });
    });
  }

  /** Load the chosen engine now and say clearly whether that worked. */
  private async activateModel(model: string | null): Promise<void> {
    const id = model ?? "";
    await this.loadVoices(); // the voice list is known before the weights are; show it right away
    this.ui.setStatus(id ? `Loading ${id}…` : "Using the server's default model…");
    try {
      const info = (await browser.runtime.sendMessage({ type: "loadModel", model: id || "realtime" } satisfies BgRequest)) as { label: string; voices: number };
      await this.loadVoices(); // clip folders are rescanned on load
      this.ui.setStatus(`${info.label} ready · ${info.voices} voices`);
      log("model loaded", info.label, info.voices);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      this.ui.setStatus(`Model not available: ${msg}`, true);
      log("model load failed", msg);
      return;
    }
    if (this.lastExtraction && this.session) {
      const at = Math.max(0, this.session.currentSentence);
      const playing = this.session.currentState === "playing" || this.session.currentState === "loading";
      this.read(this.lastExtraction, at, !playing);
    }
  }

  private exportJob: ExportJob | null = null;

  openExport(): void {
    void this.show().then(() => {
      if (!this.settings) return;
      const ex = this.lastExtraction ?? extractSelection() ?? extractArticle();
      this.lastExtraction = ex;
      const lang = document.documentElement.lang || navigator.language || "en";
      const sentences = splitSentences(ex.paragraphs, lang);
      if (!sentences.length) {
        this.ui.setStatus("No readable text found", true);
        return;
      }
      const label = ex.source === "selection" ? "selection" : ex.title || document.title;
      const formats = (Object.keys(FORMAT_LABELS) as ExportFormat[]).map((value) => ({ value, label: FORMAT_LABELS[value] }));
      this.ui.showExportDialog(sentences, label, formats, this.settings.exportFormat, (from, to, format) => {
        void this.update({ exportFormat: format as ExportFormat });
        this.startExport(sentences.slice(from, to + 1), label, true, format as ExportFormat);
      }, () => {
        this.exportJob?.cancel();
        this.exportJob = null;
      });
    });
  }

  private startExport(sentences: ReturnType<typeof splitSentences>, label: string, saveAs = true, format: ExportFormat = "mp3-256"): void {
    if (!this.settings) return;
    this.exportJob?.cancel();
    const chunks = buildChunks(sentences, "paragraph");
    const safe = (label || "vibevoice").replace(/[^\w\d\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || "vibevoice";
    const job = new ExportJob(chunks, this.settings, `${safe}.${format === "wav" ? "wav" : "mp3"}`, (p) => {
      if (this.exportJob !== job) return;
      const frac = p.estimatedTotal > 0 ? Math.min(0.97, (p.seconds + p.partial) / p.estimatedTotal) : p.chunks ? p.chunk / p.chunks : 0;
      const text =
        p.phase === "synthesizing"
          ? `Synthesizing chunk ${p.chunk + 1} of ${p.chunks} · ${Math.round(p.seconds + p.partial)} s of ~${Math.round(p.estimatedTotal)} s${p.partial === 0 ? " (choosing the cleanest take…)" : ""}`
        : p.phase === "encoding" ? "Encoding MP3…"
        : p.phase === "saving" ? "Saving…"
        : p.phase === "done" ? `Done · ${Math.round(p.seconds)} s of audio`
        : p.phase === "cancelled" ? "Cancelled"
        : `Error: ${p.message}`;
      log("export", p.phase, p.chunk, "/", p.chunks, Math.round(p.seconds), "s");
      this.ui.setExportProgress(p.phase === "done" ? 1 : frac, text, p.phase === "done" || p.phase === "error" || p.phase === "cancelled");
    }, saveAs, format);
    this.exportJob = job;
    void job.run();
  }

  /** Re-chunk the current text with a new mode, keeping the sentence position. */
  private rebuild(mode: ChunkMode): void {
    if (!this.lastExtraction || !this.session || !this.settings) return;
    const at = Math.max(0, this.session.currentSentence);
    const playing = this.session.currentState === "playing" || this.session.currentState === "loading";
    this.settings.chunkMode = mode;
    this.read(this.lastExtraction, at, !playing);
  }

  private lastSentence = 0;

  private togglePlay(): void {
    if (!this.session) {
      if (this.lastExtraction && this.lastSentence > 0) this.read(this.lastExtraction, this.lastSentence);
      else if (extractSelection()) this.readSelection();
      else this.readPage();
      return;
    }
    this.session.toggle();
  }

  stop(): void {
    const s = this.session;
    this.session = null;
    if (s && s.currentState !== "ended") this.lastSentence = Math.max(0, s.currentSentence);
    else this.lastSentence = 0;
    try {
      s?.stop();
    } catch (e) {
      log("stop failed:", String(e));
    }
    this.ui.setState("idle");
  }

  handle(cmd: ContentCommand): unknown {
    if (this.dead) return false;
    switch (cmd.type) {
      case "ping":
        return true;
      case "toggle":
        this.toggle();
        return true;
      case "show":
        void this.show();
        return true;
      case "readSelection":
        this.readSelection();
        return true;
      case "selftest":
        if (!location.href.includes("vv-selftest")) return false;
        if (this.session || this.selftestStarted) return true; // already running
        this.selftestStarted = true;
        log("selftest start on", location.href);
        void this.show().then(async () => {
          log("icon widths", JSON.stringify(this.ui.iconWidths()));
          const srv = /vv-server=([^&]+)/.exec(location.href);
          if (srv) {
            await this.update({ serverUrl: decodeURIComponent(srv[1]) });
            await this.loadVoices();
            log("server hook done");
          }
          if (this.settings && location.href.includes("vv-mode=")) {
            this.settings.chunkMode = (/vv-mode=(\w+)/.exec(location.href)?.[1] ?? "paragraph") as ChunkMode;
          }
          if (this.settings && location.href.includes("vv-model=")) {
            this.settings.model = /vv-model=([\w.]+)/.exec(location.href)?.[1] ?? null;
            this.settings.voice = null;
            log("model", this.settings.model);
          }
          const ex = extractArticle();
          if (location.href.includes("vv-pickfirst=1")) {
            const el = document.querySelector("[data-pick]") ?? document.querySelector("p");
            const picked = el ? extractFromElement(el) : null;
            log("pickfirst:", el?.tagName, picked ? `${picked.paragraphs.length} paragraphs` : "none");
            if (picked && picked.paragraphs.length) this.read(picked);
            else this.ui.setStatus("No readable text in that block", true);
            return;
          }
          if (location.href.includes("vv-settings=1")) {
            this.openSettings();
            log("settings panel opened");
            return;
          }
          const exp = /vv-export=(\d+)/.exec(location.href);
          if (exp) {
            const lang = document.documentElement.lang || navigator.language || "en";
            const sentences = splitSentences(ex.paragraphs, lang).slice(0, Number(exp[1]));
            this.ui.showExportDialog(sentences, "selftest", [{ value: "mp3-256", label: "MP3 256" }], "mp3-256", () => undefined, () => {
              this.exportJob?.cancel();
              this.exportJob = null;
            });
            this.startExport(sentences, "selftest", false, "mp3-256");
            const cancelAt = /vv-cancel=(\d+)/.exec(location.href);
            if (cancelAt) {
              setTimeout(() => {
                const button = this.ui.dialogButton("Cancel");
                log("clicking", button?.textContent, "job running:", this.exportJob !== null);
                button?.click();
                setTimeout(() => log("after cancel: job", this.exportJob === null ? "gone" : "STILL RUNNING"), 3000);
              }, Number(cancelAt[1]) * 1000);
            }
            return;
          }
          if (location.href.includes("vv-selectword=1")) {
            const para = ex.paragraphs[1];
            const firstWord = para?.text.split(" ")[0] ?? "";
            const r = para?.locate(0, firstWord.length);
            if (r) {
              const sel = window.getSelection()!;
              sel.removeAllRanges();
              sel.addRange(r);
              log("word selected:", JSON.stringify(sel.toString()));
              this.readSelection();
              return;
            }
          }
          if (location.href.includes("vv-select=1")) {
            // Programmatically select the 2nd..3rd paragraph and read the selection.
            const a = ex.paragraphs[1]?.locate(0, ex.paragraphs[1].text.length);
            const b = ex.paragraphs[2]?.locate(0, ex.paragraphs[2].text.length);
            if (a && b) {
              const sel = window.getSelection()!;
              sel.removeAllRanges();
              const r = document.createRange();
              r.setStart(a.startContainer, a.startOffset);
              r.setEnd(b.endContainer, b.endOffset);
              sel.addRange(r);
              log("selection set:", JSON.stringify(sel.toString().slice(0, 80)));
              this.readSelection();
              return;
            }
          }
          // keep the self-test short: first few paragraphs only
          ex.paragraphs = ex.paragraphs.slice(0, Number(/vv-paras=(\d+)/.exec(location.href)?.[1] ?? 3));
          this.read(ex);
        });
        return true;
    }
  }
}

// Content-script sandboxes do not share window expandos in Firefox, and a
// script from a previous extension version can linger after a reload.  The
// newest injection therefore always takes over: it asks any existing instance
// (via a DOM event on the marker element) to shut down, then initialises.
const SHUTDOWN = "vibevoice-reader:shutdown";
try {
  log("content boot", location.href, "browser?", typeof browser);
  const old = document.getElementById("vibevoice-reader-host");
  if (old) {
    log("taking over from an existing instance");
    old.dispatchEvent(new CustomEvent(SHUTDOWN));
    old.remove();
  }
  const reader = new Reader();
  window.__vibevoiceReader = reader;
  reader.mountMarker();
  browser.runtime.onMessage.addListener((msg: ContentCommand) => Promise.resolve(reader.handle(msg)));
  log("content ready");
} catch (e) {
  console.error("[vibevoice] content script failed to initialise:", e);
}
