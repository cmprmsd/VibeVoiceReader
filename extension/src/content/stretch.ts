/**
 * WSOLA time-stretcher (waveform-similarity overlap-add) for mono speech.
 *
 * Changes tempo without changing pitch.  Streaming friendly: push() input as
 * it arrives and take whatever output is ready; flush() at the end.  A speed
 * of 1 is a pass-through.  Output/input length ratio is 1/rate; the mapping
 * from output position to input position is linear within ±TOLERANCE samples,
 * which is far below sentence granularity.
 */
export class Wsola {
  private readonly N: number; // analysis/synthesis frame length
  private readonly Hs: number; // synthesis hop (N/2)
  private readonly tol: number; // search tolerance
  private readonly win: Float32Array;
  private Ha = 0; // analysis hop = Hs * rate
  private rate = 1;
  private inBuf = new Float32Array(0);
  private inBase = 0; // absolute input index of inBuf[0]
  private inEnd = 0; // absolute input samples received
  private k = 0; // next output frame index
  private prevSeg: Float32Array | null = null;
  private tail: Float32Array; // pending windowed tail (Hs samples)

  constructor(sampleRate: number, rate = 1) {
    this.N = Math.round(sampleRate * 0.02); // 20 ms
    if (this.N % 2) this.N++;
    this.Hs = this.N / 2;
    this.tol = Math.round(sampleRate * 0.005); // 5 ms
    this.win = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N); // periodic Hann: COLA at 50 %
    this.tail = new Float32Array(this.Hs);
    this.reset(rate);
  }

  reset(rate: number): void {
    this.rate = rate;
    this.Ha = this.Hs * rate;
    this.inBuf = new Float32Array(0);
    this.inBase = 0;
    this.inEnd = 0;
    this.k = 0;
    this.prevSeg = null;
    this.tail.fill(0);
  }

  get bypass(): boolean {
    return Math.abs(this.rate - 1) < 1e-3;
  }

  /** Input samples consumed so far (absolute), for position mapping. */
  get inputPosition(): number {
    return Math.round(this.k * this.Ha);
  }

  push(input: Float32Array): Float32Array {
    if (this.bypass) return input;
    // append
    const merged = new Float32Array(this.inBuf.length + input.length);
    merged.set(this.inBuf);
    merged.set(input, this.inBuf.length);
    this.inBuf = merged;
    this.inEnd += input.length;
    return this.produce(false);
  }

  flush(): Float32Array {
    if (this.bypass) return new Float32Array(0);
    // pad so the remaining frames can be produced, then emit the tail
    const pad = new Float32Array(this.N + 2 * this.tol);
    const merged = new Float32Array(this.inBuf.length + pad.length);
    merged.set(this.inBuf);
    this.inBuf = merged;
    const body = this.produce(true);
    const out = new Float32Array(body.length + this.Hs);
    out.set(body);
    out.set(this.tail, body.length);
    this.tail.fill(0);
    return out;
  }

  private produce(final: boolean): Float32Array {
    const { N, Hs, tol, win } = this;
    const chunks: Float32Array[] = [];
    const limit = final ? this.inEnd + this.N + 2 * tol : this.inEnd;
    for (;;) {
      const p = Math.round(this.k * this.Ha); // nominal input start (absolute)
      const searchFrom = this.prevSeg ? Math.max(0, p - tol) : p;
      const searchTo = this.prevSeg ? p + tol : p;
      if (searchTo + N > limit) break; // need more input
      if (final && p >= this.inEnd) break; // no real input left
      // choose the candidate that best continues the previous segment
      let best = p;
      if (this.prevSeg) {
        let bestScore = -Infinity;
        const target = this.prevSeg.subarray(Hs, N); // natural continuation
        for (let c = searchFrom; c <= searchTo; c++) {
          const off = c - this.inBase;
          let dot = 0, e = 1e-9;
          for (let i = 0; i < Hs; i++) {
            const v = this.inBuf[off + i];
            dot += v * target[i];
            e += v * v;
          }
          const score = dot / Math.sqrt(e);
          if (score > bestScore) {
            bestScore = score;
            best = c;
          }
        }
      }
      const off = best - this.inBase;
      const seg = this.inBuf.slice(off, off + N);
      const out = new Float32Array(Hs);
      if (!this.prevSeg) {
        out.set(seg.subarray(0, Hs)); // first frame: no fade-in
      } else {
        for (let i = 0; i < Hs; i++) out[i] = this.tail[i] + seg[i] * win[i];
      }
      for (let i = 0; i < Hs; i++) this.tail[i] = seg[Hs + i] * win[Hs + i];
      this.prevSeg = seg;
      this.k++;
      chunks.push(out);
      // drop input we can no longer need
      const keepFrom = Math.max(0, Math.round(this.k * this.Ha) - tol) - this.inBase;
      if (keepFrom > 4 * N) {
        this.inBuf = this.inBuf.slice(keepFrom);
        this.inBase += keepFrom;
      }
    }
    if (chunks.length === 0) return new Float32Array(0);
    if (chunks.length === 1) return chunks[0];
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}
