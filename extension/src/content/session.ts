/**
 * ReadingSession: plays a list of chunks in order with prefetch, tracks the
 * active sentence (exact in sentence mode, estimated in paragraph mode) and
 * drives the highlighter.
 */
import type { TtsEvent } from "../shared/messages";
import type { Settings } from "../shared/settings";
import { estimateBoundaries, findPauses, rmsFrames, type Boundaries } from "./alignment";
import { StreamPlayer } from "./audio";
import { Highlighter } from "./highlight";
import type { Chunk, Sentence } from "./segment";
import { startTts, type TtsSession } from "./tts-client";

export type SessionState = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

interface Utterance {
  chunk: Chunk;
  player: StreamPlayer;
  session: TtsSession | null;
  status: "pending" | "fetching" | "done" | "error";
  error?: string;
  offsets: [number, number][]; // token -> char
  lowerBounds: number[]; // per sentence, samples
  progressChar: number;
  boundaries: Boundaries | null;
  frames: Float32Array;
  framedSamples: number;
  durationSec: number;
  retries: number;
}

export interface SessionCallbacks {
  onState: (state: SessionState, detail?: string) => void;
  onSentence: (sentence: Sentence | null, index: number, total: number) => void;
  onTime: (elapsedSec: number, totalSec: number, estimated: boolean) => void;
}

const PREFETCH = 3;
const GEN_RTF = 0.5; // conservative generation speed (seconds of GPU time per second of audio)
const FRAME_SEC = 0.02;
const PREBUFFER_SEC = 0.4;

export class ReadingSession {
  private utterances: Utterance[] = [];
  private current = -1;
  private state: SessionState = "idle";
  private raf = 0;
  private highlighter: Highlighter;
  private sentenceIndex = -1;
  private secPerChar = 0.07;
  private learned = 0;
  private destroyed = false;
  private rate: number;
  private waitingForAudio = false;
  private ctx: AudioContext;
  readonly sentences: Sentence[];

  constructor(
    private chunks: Chunk[],
    private settings: Settings,
    ctx: AudioContext,
    private cb: SessionCallbacks,
    private log: (...a: unknown[]) => void = () => {},
  ) {
    this.ctx = ctx;
    this.rate = settings.rate;
    this.highlighter = new Highlighter();
    this.highlighter.setColor(settings.highlightColor);
    this.sentences = chunks.flatMap((c) => c.sentences);
    this.utterances = chunks.map((chunk) => ({
      chunk,
      player: new StreamPlayer(ctx, this.rate),
      session: null,
      status: "pending",
      offsets: [],
      lowerBounds: chunk.sentences.map(() => -1),
      progressChar: 0,
      boundaries: null,
      frames: new Float32Array(0),
      framedSamples: 0,
      durationSec: 0,
      retries: 0,
    }));
  }

  get currentState(): SessionState {
    return this.state;
  }
  get currentSentence(): number {
    return this.sentenceIndex;
  }

  // ------------------------------------------------------------ control
  async start(fromSentence = 0, paused = false): Promise<void> {
    if (this.ctx.state !== "running") await this.ctx.resume().catch(() => undefined);
    const ci = this.chunkOfSentence(fromSentence);
    this.setState(paused ? "paused" : "loading");
    this.ensureFetching(ci);
    await this.playChunk(ci, fromSentence, paused);
  }

  pause(): void {
    const u = this.utterances[this.current];
    u?.player.pause();
    this.setState("paused");
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== "running") await this.ctx.resume().catch(() => undefined);
    const u = this.utterances[this.current];
    if (!u) return this.start(0);
    if (this.state === "ended") return this.start(0);
    if (u.player.totalSamples === 0) {
      this.setState("loading");
      this.waitingForAudio = true;
      return;
    }
    await u.player.play();
    this.setState("playing");
    this.startTicker();
  }

  toggle(): void {
    if (this.state === "playing") this.pause();
    else void this.resume();
  }

  setRate(rate: number): void {
    this.rate = rate;
    for (const u of this.utterances) u.player.setRate(rate);
  }

  setHighlightColor(css: string): void {
    this.highlighter.setColor(css);
  }

  next(): void {
    const target = Math.min(this.sentences.length - 1, Math.max(0, this.sentenceIndex) + 1);
    void this.jumpTo(target);
  }

  prev(): void {
    const u = this.utterances[this.current];
    const k = this.sentenceIndex;
    if (u && k >= 0) {
      const local = k - this.firstSentenceIndex(this.current);
      const startSample = u.boundaries?.starts[local] ?? 0;
      if (u.player.positionSamples - startSample > u.player.sampleRate * 1.5) {
        void this.jumpTo(k);
        return;
      }
    }
    void this.jumpTo(Math.max(0, k - 1));
  }

  async jumpTo(sentence: number): Promise<void> {
    const ci = this.chunkOfSentence(sentence);
    const wasPlaying = this.state === "playing" || this.state === "loading";
    if (ci !== this.current) {
      this.utterances[this.current]?.player.pause();
      this.ensureFetching(ci);
      await this.playChunk(ci, sentence, !wasPlaying);
      return;
    }
    const u = this.utterances[ci];
    const local = sentence - this.firstSentenceIndex(ci);
    const startSample = u.boundaries?.starts[local] ?? 0;
    u.player.seek(Math.min(startSample, u.player.totalSamples) / u.player.sampleRate);
    if (wasPlaying && !u.player.playing) await u.player.play();
    this.tick();
  }

  stop(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopTicker();
    for (const u of this.utterances) {
      try {
        if (u.status === "fetching") u.session?.stop();
        u.session?.close();
      } catch (e) {
        this.log("stop: ignoring", String(e));
      }
      u.session = null;
      try {
        u.player.destroy();
      } catch {
        /* context may be closed */
      }
    }
    try {
      this.highlighter.destroy();
    } catch {
      /* ignore */
    }
    this.setState("idle");
  }

  // ------------------------------------------------------------ playback
  private chunkOfSentence(index: number): number {
    let acc = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      acc += this.chunks[i].sentences.length;
      if (index < acc) return i;
    }
    return Math.max(0, this.chunks.length - 1);
  }

  private firstSentenceIndex(ci: number): number {
    let acc = 0;
    for (let i = 0; i < ci; i++) acc += this.chunks[i].sentences.length;
    return acc;
  }

  private async playChunk(ci: number, fromSentence: number, pausedStart = false): Promise<void> {
    if (this.destroyed) return;
    this.current = ci;
    const u = this.utterances[ci];
    this.ensureFetching(ci);
    const local = Math.max(0, fromSentence - this.firstSentenceIndex(ci));
    const startAt = () => u.boundaries?.starts[local] ?? (local === 0 ? u.boundaries?.lead ?? 0 : 0);
    u.player.onEnded = () => this.onChunkEnded(ci);
    u.player.onStateChange = () => {
      if (this.destroyed || ci !== this.current) return;
      if (u.player.buffering) this.setState("loading", "buffering… (server is busy)");
      else if (u.player.playing && this.state === "loading") this.setState("playing");
    };
    if (u.player.totalSamples === 0) {
      this.setState("loading");
      this.waitingForAudio = !pausedStart;
      this.setSentence(this.firstSentenceIndex(ci) + local);
      return;
    }
    if (pausedStart) {
      u.player.seek(startAt() / u.player.sampleRate);
      this.setState("paused");
    } else {
      await u.player.play(startAt());
      this.setState("playing");
      this.startTicker();
    }
    this.tick();
  }

  private onChunkEnded(ci: number): void {
    if (this.destroyed || ci !== this.current) return;
    const next = ci + 1;
    if (next >= this.utterances.length) {
      this.setState("ended");
      this.stopTicker();
      this.highlighter.set(null);
      this.cb.onSentence(null, this.sentences.length, this.sentences.length);
      return;
    }
    void this.playChunk(next, this.firstSentenceIndex(next));
  }

  private ensureFetching(from: number): void {
    // Fetch the current chunk and up to PREFETCH ahead, one at a time in order.
    for (let i = from; i < Math.min(this.utterances.length, from + 1 + PREFETCH); i++) {
      const u = this.utterances[i];
      if (u.status !== "pending") continue;
      const prev = this.utterances[i - 1];
      if (i > from && prev && prev.status === "fetching") break; // keep server queue orderly
      this.fetch(i);
    }
  }

  private fetch(i: number): void {
    const u = this.utterances[i];
    u.status = "fetching";
    const t0 = performance.now();
    // The chunk we are waiting on streams immediately.  Chunks fetched ahead
    // can afford best-of-N takes (the server scores and picks) - but only when
    // the audio already buffered ahead of playback covers the extra generation
    // time, otherwise playback would stall waiting for the second take.
    const wanted = Math.max(1, this.settings.candidates ?? 1);
    const urgent = i === this.current || this.current < 0;
    let candidates = 1;
    if (!urgent && wanted > 1) {
      const lead = this.bufferedAheadSec(i);
      const genSec = u.chunk.text.length * this.secPerChar * GEN_RTF;
      candidates = lead >= wanted * genSec + 2 ? wanted : lead >= 2 * genSec + 2 ? 2 : 1;
      this.log("chunk", i, "lead", lead.toFixed(1), "s, est. generation", genSec.toFixed(1), "s/take");
    }
    this.log("fetch chunk", i, `${u.chunk.sentences.length} sentences, ${u.chunk.text.length} chars, voice ${this.settings.voice ?? "default"}, candidates ${candidates}`);
    u.session = startTts(
      { text: u.chunk.text, voice: this.settings.voice, cfg_scale: this.settings.cfgScale, inference_steps: this.settings.inferenceSteps, candidates, model: this.settings.model, lang: document.documentElement.lang || navigator.language },
      this.settings,
      {
        onEvent: (ev: TtsEvent) => this.onEvent(i, ev, t0),
        onAudio: (pcm) => {
          if (this.destroyed) return;
          const first = u.player.totalSamples === 0;
          u.player.push(pcm);
          this.updateFrames(u);
          if (first) this.log("chunk", i, "first audio after", Math.round(performance.now() - t0), "ms");
          this.maybeStart(i, u);
        },
      },
    );
  }

  /** Seconds of audio between the playback position and the end of what is buffered before chunk `i`. */
  private bufferedAheadSec(i: number): number {
    let sec = 0;
    for (let k = Math.max(0, this.current); k < i; k++) {
      const x = this.utterances[k];
      const total = x.player.totalSamples / x.player.sampleRate;
      sec += k === this.current ? Math.max(0, total - x.player.positionSeconds) : total;
    }
    return sec / this.rate;
  }

  /** Start the waiting chunk once enough speech is buffered to ride out generation hiccups. */
  private maybeStart(i: number, u: Utterance): void {
    if (i !== this.current || !this.waitingForAudio) return;
    const sr = u.player.sampleRate;
    const lead = u.boundaries?.lead ?? 0;
    const speechBuffered = u.player.totalSamples - lead;
    if (u.status === "done" || speechBuffered >= sr * PREBUFFER_SEC || u.player.totalSamples >= sr * 2.5) {
      this.waitingForAudio = false;
      void this.playChunk(i, this.sentenceIndex < 0 ? this.firstSentenceIndex(i) : this.sentenceIndex);
    }
  }

  private onEvent(i: number, ev: TtsEvent, t0: number): void {
    if (this.destroyed) return;
    const u = this.utterances[i];
    switch (ev.event) {
      case "meta":
        u.offsets = ev.offsets;
        break;
      case "progress": {
        if (ev.char == null) break;
        u.progressChar = ev.char;
        // Lower bound: sentence k cannot start before the window that consumed its first char.
        u.chunk.offsets.forEach((off, k) => {
          if (u.lowerBounds[k] < 0 && ev.char! >= off) u.lowerBounds[k] = ev.samples;
        });
        break;
      }
      case "queued":
        if (i === this.current) this.cb.onState(this.state, `waiting for the server (position ${ev.position})`);
        break;
      case "loading":
        if (i === this.current) this.cb.onState(this.state, `loading ${ev.label}…`);
        break;
      case "quality":
        this.log("chunk", i, "quality: best score", ev.score, "of", ev.scores.join("/"), `(${ev.candidates} takes)`);
        break;
      case "done":
        u.status = "done";
        u.session?.close();
        u.session = null;
        u.player.finish();
        u.durationSec = ev.seconds;
        this.updateFrames(u, true);
        this.maybeStart(i, u);
        this.learn(u);
        this.log("chunk", i, "done:", ev.seconds, "s audio, rtf", ev.rtf, "boundaries", u.boundaries?.starts.map((s) => (s / u.player.sampleRate).toFixed(2)).join(","), "anchored", u.boundaries?.anchored.map((a) => (a ? 1 : 0)).join(""));
        if (u.chunk.sentences.length > 1) {
          const sr = u.player.sampleRate;
          const pauses = findPauses(u.frames, FRAME_SEC, 0.25).map((p) => `${p.start.toFixed(2)}+${(p.end - p.start).toFixed(2)}`);
          this.log("chunk", i, "offsets", u.chunk.offsets.join(","), "of", u.chunk.text.length, "lower", u.lowerBounds.map((b) => (b / sr).toFixed(2)).join(","), "pauses", pauses.join(" "));
          this.log("chunk", i, "text", JSON.stringify(u.chunk.text));
        }
        if (ev.stopped && !this.destroyed) this.log("chunk", i, "was stopped by the server");
        this.ensureFetching(this.current < 0 ? 0 : this.current);
        break;
      case "error":
        this.log("chunk", i, "error", ev.message);
        if (u.retries < 1 && u.player.totalSamples === 0) {
          // Transient server hiccup (e.g. a request cancelled mid-switch): try once more.
          u.retries++;
          u.session?.close();
          u.session = null;
          u.status = "pending";
          setTimeout(() => {
            if (!this.destroyed && u.status === "pending") this.fetch(i);
          }, 400);
          break;
        }
        u.status = "error";
        u.error = ev.message;
        u.session?.close();
        u.session = null;
        u.player.finish();
        if (i === this.current) this.setState("error", ev.message);
        break;
      case "closed":
        if (u.status === "fetching") {
          u.status = u.player.totalSamples > 0 ? "done" : "error";
          u.error = "connection closed";
          u.player.finish();
          this.updateFrames(u, true);
          if (i === this.current && u.player.totalSamples === 0) this.setState("error", "connection closed before audio arrived");
        }
        break;
    }
  }

  private updateFrames(u: Utterance, complete = false): void {
    const sr = u.player.sampleRate;
    const total = u.player.totalSamples;
    // Extend the RMS frames with the new samples only.
    const hop = Math.floor(sr * FRAME_SEC);
    if (total - u.framedSamples >= hop) {
      const fresh = rmsFrames(u.player.samples.subarray(u.framedSamples, total), sr, FRAME_SEC);
      const merged = new Float32Array(u.frames.length + fresh.length);
      merged.set(u.frames);
      merged.set(fresh, u.frames.length);
      u.frames = merged;
      u.framedSamples += fresh.length * hop;
    }
    if (u.chunk.sentences.length === 0) return;
    u.boundaries = estimateBoundaries({
      offsets: u.chunk.offsets,
      textLength: u.chunk.text.length,
      samples: total,
      sampleRate: sr,
      complete,
      lowerBounds: u.lowerBounds,
      frames: u.frames,
      frameSec: FRAME_SEC,
      secPerChar: this.secPerChar,
    });
  }

  private learn(u: Utterance): void {
    if (!u.boundaries) return;
    const speech = (u.player.totalSamples - u.boundaries.lead - u.boundaries.trail) / u.player.sampleRate;
    if (speech <= 0 || u.chunk.text.length < 20) return;
    const spc = speech / u.chunk.text.length;
    this.learned++;
    this.secPerChar = this.secPerChar + (spc - this.secPerChar) / Math.min(this.learned, 5);
  }

  // ------------------------------------------------------------ ticking
  // A timer rather than requestAnimationFrame: rAF pauses in background tabs,
  // and the highlight and controls must keep tracking playback there too.
  private startTicker(): void {
    if (this.raf) return;
    this.raf = window.setInterval(() => this.tick(), 200);
  }
  private stopTicker(): void {
    if (this.raf) clearInterval(this.raf);
    this.raf = 0;
  }

  private tick(): void {
    const u = this.utterances[this.current];
    if (!u) return;
    const pos = u.player.positionSamples;
    let local = 0;
    if (u.boundaries) {
      for (let k = 0; k < u.boundaries.starts.length; k++) if (pos >= u.boundaries.starts[k]) local = k;
    }
    this.setSentence(this.firstSentenceIndex(this.current) + local);

    // time: completed chunks + current position; estimate the rest by characters
    let elapsed = 0;
    let total = 0;
    let estimated = false;
    for (let i = 0; i < this.utterances.length; i++) {
      const x = this.utterances[i];
      const dur = x.status === "done" ? x.player.totalSamples / x.player.sampleRate : x.chunk.text.length * this.secPerChar + 1;
      if (x.status !== "done") estimated = true;
      total += dur;
      if (i < this.current) elapsed += dur;
      else if (i === this.current) elapsed += pos / x.player.sampleRate;
    }
    this.cb.onTime(elapsed / this.rate, total / this.rate, estimated);
  }

  private setSentence(index: number): void {
    if (index === this.sentenceIndex) return;
    this.sentenceIndex = index;
    const s = this.sentences[index] ?? null;
    this.highlighter.set(s?.range ?? null);
    if (s?.range) this.highlighter.reveal(s.range);
    this.cb.onSentence(s, index, this.sentences.length);
  }

  private setState(state: SessionState, detail?: string): void {
    this.state = state;
    this.cb.onState(state, detail);
  }
}
