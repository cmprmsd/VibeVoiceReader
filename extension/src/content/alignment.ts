/**
 * Sentence-boundary estimation inside one synthesised chunk.
 *
 * The model gives us no timestamps.  What we have:
 *  - `progress` events: "text up to char C was consumed when sample S was
 *    produced" – a lower bound on when the speech for C can start;
 *  - the audio itself: sentence ends show up as long pauses (~1 s) while
 *    commas are short (~0.3 s);
 *  - character counts, for a proportional fallback.
 */

export interface Pause {
  /** seconds */
  start: number;
  end: number;
}

export function rmsFrames(data: Float32Array, sampleRate: number, frameSec = 0.02): Float32Array {
  const hop = Math.max(1, Math.floor(sampleRate * frameSec));
  const n = Math.floor(data.length / hop);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const base = i * hop;
    for (let j = 0; j < hop; j++) acc += data[base + j] * data[base + j];
    out[i] = Math.sqrt(acc / hop);
  }
  return out;
}

export function findPauses(frames: Float32Array, frameSec: number, minSec: number, relThreshold = 0.04, absThreshold = 0.004): Pause[] {
  let peak = 0;
  for (const v of frames) if (v > peak) peak = v;
  const thr = Math.max(absThreshold, peak * relThreshold);
  const minFrames = Math.ceil(minSec / frameSec);
  const out: Pause[] = [];
  let start = -1;
  for (let i = 0; i <= frames.length; i++) {
    const silent = i < frames.length && frames[i] < thr;
    if (silent && start < 0) start = i;
    if (!silent && start >= 0) {
      if (i - start >= minFrames) out.push({ start: start * frameSec, end: i * frameSec });
      start = -1;
    }
  }
  return out;
}

export interface BoundaryInput {
  /** char offset of each sentence inside the chunk text */
  offsets: number[];
  textLength: number;
  /** total samples available so far */
  samples: number;
  sampleRate: number;
  /** whether the chunk is complete */
  complete: boolean;
  /** lower bound (samples) per sentence from progress events, or -1 */
  lowerBounds: number[];
  /** rms frames of the audio so far */
  frames: Float32Array;
  frameSec: number;
  /** seconds per character, learned from earlier chunks */
  secPerChar: number;
}

export interface Boundaries {
  /** start sample of each sentence */
  starts: number[];
  /** leading silence in samples */
  lead: number;
  /** trailing silence (only meaningful when complete) */
  trail: number;
  /** which sentences were anchored on a detected pause */
  anchored: boolean[];
}

export function estimateBoundaries(inp: BoundaryInput): Boundaries {
  const n = inp.offsets.length;
  const sr = inp.sampleRate;
  const pauses = findPauses(inp.frames, inp.frameSec, 0.12);
  const lead = pauses.length && pauses[0].start === 0 ? Math.floor(pauses[0].end * sr) : 0;
  let trail = 0;
  if (inp.complete && pauses.length) {
    const last = pauses[pauses.length - 1];
    if (Math.abs(last.end * sr - inp.samples) < sr * 0.05) trail = Math.floor((last.end - last.start) * sr);
  }
  const starts = new Array<number>(n).fill(0);
  const anchored = new Array<boolean>(n).fill(false);
  starts[0] = lead;
  anchored[0] = true;
  if (n === 1) return { starts, lead, trail, anchored };

  // Proportional prior per boundary (seconds), floored by the model's text progress.
  const speechEnd = inp.complete ? inp.samples - trail : inp.samples;
  const totalSpeech = inp.complete
    ? Math.max(1, speechEnd - lead)
    : Math.max(1, Math.floor(inp.textLength * inp.secPerChar * sr));
  const prior: number[] = [];
  for (let k = 0; k < n; k++) {
    const p = lead + Math.floor((inp.offsets[k] / inp.textLength) * totalSpeech);
    prior[k] = Math.max(p, inp.lowerBounds[k] ?? 0);
  }

  // Candidate boundaries: the end of every pause >= 0.25 s inside the speech.
  const cands = pauses
    .filter((p) => p.start > 0 && p.end * sr < speechEnd - sr * 0.1 && p.end - p.start >= 0.25)
    .map((p) => ({ at: Math.floor(p.end * sr), len: p.end - p.start }));
  const M = cands.length;
  const UNANCHORED = 2.0; // seconds of cost for using the prior instead of a pause
  const bonus = (len: number) => 0.6 * Math.min(len, 1.2);

  // DP over boundaries k=1..n-1 with state j in [0..M] (M = unanchored).
  const INF = 1e18;
  const cost: number[][] = [];
  const back: number[][] = [];
  const posOf = (k: number, j: number) => (j === M ? prior[k] : cands[j].at);
  for (let k = 1; k < n; k++) {
    cost[k] = new Array(M + 1).fill(INF);
    back[k] = new Array(M + 1).fill(-1);
    for (let j = 0; j <= M; j++) {
      const pos = posOf(k, j);
      const local = j === M ? UNANCHORED : Math.abs(cands[j].at - prior[k]) / sr - bonus(cands[j].len);
      if (k === 1) {
        if (pos > lead) {
          cost[k][j] = local;
          back[k][j] = -1;
        }
        continue;
      }
      let best = INF, bj = -1;
      for (let jp = 0; jp <= M; jp++) {
        if (cost[k - 1][jp] >= INF) continue;
        if (jp !== M && j !== M && jp >= j) continue; // candidates must be used in order
        if (posOf(k - 1, jp) >= pos) continue; // monotonic
        if (cost[k - 1][jp] < best) {
          best = cost[k - 1][jp];
          bj = jp;
        }
      }
      if (bj >= 0 || (k - 1 === 0)) {
        cost[k][j] = best + local;
        back[k][j] = bj;
      }
    }
  }
  // Reconstruct.
  let bestJ = M, bestC = INF;
  for (let j = 0; j <= M; j++) if (cost[n - 1][j] < bestC) { bestC = cost[n - 1][j]; bestJ = j; }
  if (bestC < INF) {
    for (let k = n - 1; k >= 1; k--) {
      starts[k] = posOf(k, bestJ);
      anchored[k] = bestJ !== M;
      bestJ = back[k][bestJ];
      if (bestJ < 0 && k > 1) break;
    }
  } else {
    for (let k = 1; k < n; k++) starts[k] = prior[k];
  }
  for (let k = 1; k < n; k++) starts[k] = Math.max(starts[k], starts[k - 1] + 1);
  return { starts, lead, trail, anchored };
}
