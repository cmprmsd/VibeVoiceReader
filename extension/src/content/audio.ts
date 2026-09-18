/**
 * Gapless streaming player for PCM16 mono audio using Web Audio.
 *
 * Incoming chunks are appended to one growing sample buffer for the current
 * utterance and scheduled back-to-back as AudioBufferSourceNodes.  Seeking,
 * pausing and rate changes cancel the scheduled sources and re-schedule from
 * a sample offset, which is cheap because the whole utterance stays in memory.
 */
import { Wsola } from "./stretch";

export class StreamPlayer {
  readonly sampleRate: number;
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private data: Float32Array<ArrayBuffer>;
  private total = 0; // samples received
  private nextSample = 0; // next SOURCE sample handed to the stretcher
  private stretcher: Wsola;
  private outQueue: Float32Array[] = []; // stretched audio not yet scheduled
  private nextWhen = 0; // ctx time at which the next chunk starts
  private scheduledOut = 0; // output samples scheduled since startTime (integer, keeps starts sample-exact)
  private baseSample = 0; // sample position when playback (re)started
  private startTime = 0; // ctx.currentTime when playback (re)started
  private pausedAt = 0; // sample position while paused
  private sources = new Set<AudioBufferSourceNode>();
  private _rate = 1;
  private _playing = false;
  private _finished = false; // producer signalled end of stream
  private _ended = false;
  private _buffering = false; // paused by an underrun, resumes automatically
  private static readonly REBUFFER_SEC = 1.0;

  onEnded: (() => void) | null = null;
  onStateChange: (() => void) | null = null;

  /**
   * @param ctx shared AudioContext (one per page); its sampleRate must match
   * @param rate initial playback rate
   */
  constructor(ctx: AudioContext, rate = 1) {
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    this._rate = rate;
    this.stretcher = new Wsola(this.sampleRate, rate);
    this.data = new Float32Array(new ArrayBuffer(this.sampleRate * 30 * 4));
  }

  /** All samples received so far (a view, do not mutate). */
  get samples(): Float32Array {
    return this.data.subarray(0, this.total);
  }
  get totalSamples(): number {
    return this.total;
  }

  get playing(): boolean {
    return this._playing;
  }
  get ended(): boolean {
    return this._ended;
  }
  get rate(): number {
    return this._rate;
  }
  get bufferedSeconds(): number {
    return this.total / this.sampleRate;
  }
  get finished(): boolean {
    return this._finished;
  }
  get buffering(): boolean {
    return this._buffering;
  }
  /** Current playback position in samples (of the source audio, independent of rate). */
  get positionSamples(): number {
    if (!this._playing || !this.ctx) return this.pausedAt;
    const elapsed = Math.max(0, this.ctx.currentTime - this.startTime);
    return Math.min(this.total, this.baseSample + Math.floor(elapsed * this._rate * this.sampleRate));
  }
  get positionSeconds(): number {
    return this.positionSamples / this.sampleRate;
  }
  get contextState(): AudioContextState | "none" {
    return this.ctx?.state ?? "none";
  }

  // ------------------------------------------------------------ producer side
  push(pcm16: ArrayBuffer): void {
    const int16 = new Int16Array(pcm16);
    if (this.total + int16.length > this.data.length) {
      const grown = new Float32Array(new ArrayBuffer(Math.max(this.data.length * 2, this.total + int16.length) * 4));
      grown.set(this.data.subarray(0, this.total));
      this.data = grown;
    }
    for (let i = 0; i < int16.length; i++) this.data[this.total + i] = int16[i] / 32768;
    this.total += int16.length;
    if (this._playing) this.schedulePending();
    else if (this._buffering && this.total - this.pausedAt >= this.sampleRate * StreamPlayer.REBUFFER_SEC) void this.play(this.pausedAt);
  }

  /** Producer is done: no more push() calls will follow. */
  finish(): void {
    this._finished = true;
    if (this._buffering) {
      void this.play(this.pausedAt);
      return;
    }
    if (this._playing) {
      this.schedulePending();
      this.flushStretcher();
    }
    this.checkEnded();
  }

  // ------------------------------------------------------------ consumer side
  async play(fromSample?: number): Promise<void> {
    const ctx = this.ctx!;
    if (ctx.state !== "running") await ctx.resume();
    this.cancelScheduled();
    const from = fromSample ?? this.pausedAt;
    this.baseSample = Math.min(from, this.total);
    this.nextSample = this.baseSample;
    this.stretcher.reset(this._rate);
    this.outQueue = [];
    this.startTime = ctx.currentTime + 0.03;
    this.nextWhen = this.startTime;
    this.scheduledOut = 0;
    this._playing = true;
    this._buffering = false;
    this._ended = false;
    this.schedulePending();
    if (this._finished) this.flushStretcher();
    this.onStateChange?.();
  }

  pause(): void {
    this._buffering = false;
    if (!this._playing) return;
    this.pausedAt = this.positionSamples;
    this.cancelScheduled();
    this._playing = false;
    this.onStateChange?.();
  }

  /** Audio fell behind playback: stop cleanly and resume once more has arrived. */
  private underrun(): void {
    this.pausedAt = Math.min(this.positionSamples, this.total);
    this.cancelScheduled();
    this._playing = false;
    this._buffering = true;
    this.onStateChange?.();
  }

  seek(seconds: number): void {
    const sample = Math.max(0, Math.min(this.total, Math.floor(seconds * this.sampleRate)));
    if (this._playing) void this.play(sample);
    else {
      this.pausedAt = sample;
      this.onStateChange?.();
    }
  }

  setRate(rate: number): void {
    if (rate === this._rate) return;
    const pos = this.positionSamples;
    this._rate = rate;
    if (this._playing) void this.play(pos);
  }

  stop(): void {
    this.cancelScheduled();
    this._playing = false;
    this._buffering = false;
    this.pausedAt = 0;
    this.total = 0;
    this.nextSample = 0;
    this._finished = false;
    this._ended = false;
    this.onStateChange?.();
  }

  destroy(): void {
    this.stop();
    this.gain?.disconnect();
    this.gain = null;
    this.ctx = null;
  }

  // ---------------------------------------------------------------- internals
  private schedulePending(): void {
    if (!this.ctx || !this.gain || !this._playing) return;
    if (this.nextSample >= this.total) {
      this.checkEnded();
      return;
    }
    const ctx = this.ctx;
    // Underrun: the network fell behind playback. Shift the timeline instead of
    // letting scheduled chunks pile up in the past.
    if (this.nextWhen < ctx.currentTime) {
      const gap = ctx.currentTime + 0.02 - this.nextWhen;
      this.nextWhen += gap;
      this.startTime += gap;
    }
    const start = this.nextSample;
    const end = this.total;
    // Time-stretch (pitch preserved) instead of resampling; at rate 1 this is a pass-through.
    const out = this.stretcher.push(this.data.slice(start, end));
    this.nextSample = end;
    this.scheduleOut(out);
  }

  private flushStretcher(): void {
    if (!this._playing) return;
    const tail = this.stretcher.flush();
    this.scheduleOut(tail);
  }

  private scheduleOut(out: Float32Array): void {
    if (!this.ctx || !this.gain || out.length === 0) return;
    const ctx = this.ctx;
    if (this.nextWhen < ctx.currentTime - 0.01) {
      // Underrun: rather than stitching late chunks with small gaps (audible
      // stutter), pause and rebuffer; push()/finish() resume playback.
      this.underrun();
      return;
    }
    const buf = ctx.createBuffer(1, out.length, this.sampleRate);
    buf.copyToChannel(out as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.onended = () => {
      this.sources.delete(src);
      this.checkEnded();
    };
    src.start(this.nextWhen);
    this.sources.add(src);
    this.scheduledOut += out.length;
    this.nextWhen = this.startTime + this.scheduledOut / this.sampleRate;
  }

  private cancelScheduled(): void {
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
    this.sources.clear();
  }

  private checkEnded(): void {
    if (this._playing && this._finished && this.nextSample >= this.total && this.sources.size === 0) {
      this._playing = false;
      this._ended = true;
      this.pausedAt = this.total;
      this.onStateChange?.();
      this.onEnded?.();
    }
  }
}
