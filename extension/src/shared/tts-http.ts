/**
 * Framed HTTP streaming client for POST /tts/stream, shared by the background
 * relay and the "direct" transport.  Frame = 1 byte type (1 JSON, 2 PCM16),
 * uint32 little-endian length, payload.
 */
import type { TtsEvent, TtsRequest } from "./messages";
import { normalizeServerUrl } from "./settings";

export interface StreamHandlers {
  onEvent: (ev: TtsEvent) => void;
  onAudio: (pcm: ArrayBuffer) => void;
}

export interface StreamHandle {
  /** Ask the server to stop; the stream still ends with a "done" event. */
  stop: () => void;
  /** Abort the HTTP request immediately. */
  abort: () => void;
}

export function streamTts(serverUrl: string, req: TtsRequest, h: StreamHandlers): StreamHandle {
  const base = normalizeServerUrl(serverUrl);
  const id = crypto.randomUUID();
  const controller = new AbortController();
  let finished = false;
  const finish = (ev: TtsEvent) => {
    if (finished) return;
    finished = true;
    h.onEvent(ev);
  };

  void (async () => {
    let res: Response;
    try {
      res = await fetch(`${base}/tts/stream`, {
        method: "POST",
        // text/plain keeps this a "simple" request: no CORS preflight.  Firefox for
        // Android blocks the preflight to a LAN server before it is even sent, while
        // simple requests go through; the server parses the JSON body regardless.
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ ...req, id }),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (e) {
      finish({ event: "error", message: `Cannot reach ${base}: ${(e as Error).message}` });
      return;
    }
    if (!res.ok || !res.body) {
      finish({ event: "error", message: `${base}/tts/stream: HTTP ${res.status} ${await res.text().catch(() => "")}` });
      return;
    }
    const reader = res.body.getReader();
    const parser = new FrameParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const f of parser.push(value)) {
          if (f.type === 2) h.onAudio(f.payload.buffer.slice(f.payload.byteOffset, f.payload.byteOffset + f.payload.byteLength) as ArrayBuffer);
          else if (f.type === 1) {
            const ev = JSON.parse(new TextDecoder().decode(f.payload)) as TtsEvent;
            if (ev.event === "done" || ev.event === "error") finished = true;
            h.onEvent(ev);
          }
        }
      }
      finish({ event: "closed", reason: "stream ended" });
    } catch (e) {
      finish(controller.signal.aborted ? { event: "closed", reason: "aborted" } : { event: "error", message: (e as Error).message });
    }
  })();

  return {
    stop: () => {
      void fetch(`${base}/tts/stop/${id}`, { method: "POST" }).catch(() => undefined);
    },
    abort: () => controller.abort(),
  };
}

export class FrameParser {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): { type: number; payload: Uint8Array }[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    const out: { type: number; payload: Uint8Array }[] = [];
    let off = 0;
    const view = new DataView(this.buf.buffer, this.buf.byteOffset);
    while (this.buf.length - off >= 5) {
      const type = view.getUint8(off);
      const len = view.getUint32(off + 1, true);
      if (this.buf.length - off < 5 + len) break;
      out.push({ type, payload: this.buf.subarray(off + 5, off + 5 + len) });
      off += 5 + len;
    }
    this.buf = this.buf.slice(off);
    return out;
  }
}
