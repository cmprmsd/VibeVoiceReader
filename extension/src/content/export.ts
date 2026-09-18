/**
 * Export a sentence range as MP3: synthesise every chunk (best-of-N allowed,
 * nothing is played), trim leading/trailing silence, join with short pauses,
 * encode with lamejs and hand the bytes to the background for download.
 */
import type { BgRequest, TtsEvent } from "../shared/messages";
import type { Settings } from "../shared/settings";
import lamejs from "../vendor/lame";
import { findPauses, rmsFrames } from "./alignment";
import type { Chunk } from "./segment";
import { startTts, type TtsSession } from "./tts-client";

export interface ExportProgress {
  chunk: number;
  chunks: number;
  /** seconds of audio finished so far */
  seconds: number;
  /** estimated total seconds (by character count), for a smooth progress bar */
  estimatedTotal: number;
  /** seconds of the current chunk received so far */
  partial: number;
  phase: "synthesizing" | "encoding" | "saving" | "done" | "cancelled" | "error";
  message?: string;
}

const SR = 24000;
const GAP_SENTENCE = 0.25;
const GAP_PARAGRAPH = 0.6;

export type ExportFormat = "mp3-256" | "mp3-128" | "wav";
export const FORMAT_LABELS: Record<ExportFormat, string> = {
  "mp3-256": "MP3 256 kbit/s (48 kHz)",
  "mp3-128": "MP3 128 kbit/s (48 kHz)",
  wav: "WAV 24 kHz 16-bit (lossless)",
};

export class ExportJob {
  private cancelled = false;
  private session: TtsSession | null = null;

  constructor(
    private chunks: Chunk[],
    private settings: Settings,
    private filename: string,
    private onProgress: (p: ExportProgress) => void,
    private saveAs = true,
    private format: ExportFormat = "mp3-256",
  ) {}

  cancel(): void {
    this.cancelled = true;
    this.session?.stop();
    this.session?.close();
  }

  async run(): Promise<void> {
    const parts: Float32Array[] = [];
    let seconds = 0;
    const estimatedTotal = this.chunks.reduce((n, c) => n + c.text.length, 0) * 0.065;
    const report = (chunk: number, phase: ExportProgress["phase"], partial = 0, message?: string) =>
      this.onProgress({ chunk, chunks: this.chunks.length, seconds, estimatedTotal, partial, phase, message });
    try {
      for (let i = 0; i < this.chunks.length; i++) {
        if (this.cancelled) return report(i, "cancelled");
        report(i, "synthesizing");
        const pcm = await this.synth(this.chunks[i].text, (partial) => report(i, "synthesizing", partial));
        const trimmed = trimSilence(pcm);
        if (i > 0) {
          const paragraphBreak = this.chunks[i].sentences[0].para !== this.chunks[i - 1].sentences[0].para;
          parts.push(new Float32Array(Math.round(SR * (paragraphBreak ? GAP_PARAGRAPH : GAP_SENTENCE))));
        }
        parts.push(trimmed);
        seconds += trimmed.length / SR;
      }
      report(this.chunks.length, "encoding");
      let data: ArrayBuffer;
      let mime: string;
      if (this.format === "wav") {
        data = encodeWav(parts, SR);
        mime = "audio/wav";
      } else {
        // MP3 at 24 kHz is capped at 160 kbit/s (MPEG-2); upsample to 48 kHz for 256.
        data = await encodeMp3(parts.map((p) => upsample2x(p)), SR * 2, this.format === "mp3-256" ? 256 : 128);
        mime = "audio/mpeg";
      }
      report(this.chunks.length, "saving");
      await browser.runtime.sendMessage({ type: "download", filename: this.filename, mime, data, saveAs: this.saveAs } satisfies BgRequest);
      report(this.chunks.length, "done");
    } catch (e) {
      report(0, "error", 0, (e as Error).message);
    }
  }

  private synth(text: string, onPartial: (seconds: number) => void): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      const buf: Float32Array[] = [];
      let total = 0;
      this.session = startTts(
        {
          text,
          voice: this.settings.voice,
          cfg_scale: this.settings.cfgScale,
          inference_steps: this.settings.inferenceSteps,
          candidates: Math.max(2, this.settings.candidates || 1), // offline: always let the server pick the cleanest take
          model: this.settings.model,
          lang: document.documentElement.lang || navigator.language,
        },
        this.settings,
        {
          onEvent: (ev: TtsEvent) => {
            if (ev.event === "error") reject(new Error(ev.message));
            else if (ev.event === "done" || ev.event === "closed") {
              const out = new Float32Array(total);
              let o = 0;
              for (const b of buf) {
                out.set(b, o);
                o += b.length;
              }
              this.session?.close();
              this.session = null;
              resolve(out);
            }
          },
          onAudio: (pcm) => {
            const i16 = new Int16Array(pcm);
            const f = new Float32Array(i16.length);
            for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
            buf.push(f);
            total += f.length;
            onPartial(total / SR);
          },
        },
      );
    });
  }
}

function trimSilence(x: Float32Array): Float32Array {
  if (x.length === 0) return x;
  const frames = rmsFrames(x, SR, 0.02);
  const pauses = findPauses(frames, 0.02, 0.05);
  let start = 0;
  let end = x.length;
  if (pauses.length && pauses[0].start === 0) start = Math.max(0, Math.floor((pauses[0].end - 0.08) * SR));
  const last = pauses[pauses.length - 1];
  if (last && Math.abs(last.end * SR - x.length) < SR * 0.05) end = Math.min(x.length, Math.floor((last.start + 0.12) * SR));
  return x.subarray(start, Math.max(start, end));
}

/** 2x upsampling with a 47-tap Kaiser-windowed half-band FIR (passband to ~11 kHz, no imaging). */
function upsample2x(x: Float32Array): Float32Array {
  const taps = 47;
  const half = (taps - 1) / 2;
  const h = new Float32Array(taps);
  const beta = 6.0;
  const i0 = (v: number) => {
    let sum = 1, term = 1;
    for (let k = 1; k < 25; k++) {
      term *= (v / (2 * k)) ** 2;
      sum += term;
    }
    return sum;
  };
  for (let n = 0; n < taps; n++) {
    const m = n - half;
    const sinc = m === 0 ? 0.5 : Math.sin(Math.PI * m * 0.5) / (Math.PI * m);
    const w = i0(beta * Math.sqrt(1 - (m / half) ** 2)) / i0(beta);
    h[n] = 2 * sinc * w; // gain 2 compensates the zero-stuffing
  }
  const up = new Float32Array(x.length * 2);
  for (let i = 0; i < x.length; i++) up[2 * i] = x[i];
  const out = new Float32Array(up.length);
  for (let i = 0; i < up.length; i++) {
    let acc = 0;
    for (let n = 0; n < taps; n++) {
      const j = i - n + half;
      if (j >= 0 && j < up.length) acc += h[n] * up[j];
    }
    out[i] = acc;
  }
  return out;
}

function encodeWav(parts: Float32Array[], sr: number): ArrayBuffer {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buf);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + total * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, total * 2, true);
  let o = 44;
  for (const p of parts) for (let i = 0; i < p.length; i++, o += 2) v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(p[i] * 32767))), true);
  return buf;
}

async function encodeMp3(parts: Float32Array[], sr: number, kbps: number): Promise<ArrayBuffer> {
  const enc = new lamejs.Mp3Encoder(1, sr, kbps);
  const out: Int8Array[] = [];
  const block = 1152;
  let carry = new Int16Array(0);
  for (const part of parts) {
    const i16 = new Int16Array(carry.length + part.length);
    i16.set(carry);
    for (let i = 0; i < part.length; i++) i16[carry.length + i] = Math.max(-32768, Math.min(32767, Math.round(part[i] * 32767)));
    let i = 0;
    for (; i + block <= i16.length; i += block) out.push(enc.encodeBuffer(i16.subarray(i, i + block)));
    carry = i16.slice(i);
    await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
  }
  if (carry.length) out.push(enc.encodeBuffer(carry));
  out.push(enc.flush());
  const total = out.reduce((n, b) => n + b.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const b of out) {
    bytes.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), o);
    o += b.length;
  }
  return bytes.buffer;
}
