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

/** Servers (by base URL) where POST failed at the network level; GET is used from then on. */
const postBlocked = new Set<string>();

/**
 * Start a stream: POST with the JSON body, or GET with `?req=` when POST cannot be
 * sent at all (Firefox for Android has been seen to block POST to a LAN address
 * from the extension while GET goes through).
 */
async function openStream(base: string, body: string, signal: AbortSignal): Promise<Response> {
  const get = () => fetch(`${base}/tts/stream?req=${encodeURIComponent(body)}`, { signal, cache: "no-store" });
  if (postBlocked.has(base)) return get();
  try {
    return await fetch(`${base}/tts/stream`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" }, // simple request: no preflight
      body,
      signal,
      cache: "no-store",
    });
  } catch (e) {
    if (signal.aborted) throw e;
    const res = await get(); // throws the GET error if that fails as well
    postBlocked.add(base);
    return res;
  }
}

/** Which request methods reach the server (settings → Test). */
export async function probeServer(serverUrl: string): Promise<string> {
  const base = normalizeServerUrl(serverUrl);
  const tryIt = async (label: string, run: () => Promise<Response>) => {
    try {
      const r = await run();
      return `${label} ${r.status < 500 ? "ok" : `HTTP ${r.status}`}`;
    } catch (e) {
      return `${label} FAILED (${(e as Error).message})`;
    }
  };
  return [
    await tryIt("GET", () => fetch(`${base}/health`, { cache: "no-store" })),
    await tryIt("POST", () => fetch(`${base}/tts/stop/probe`, { method: "POST", cache: "no-store" })),
    await tryIt("POST+body", () => fetch(`${base}/tts/stream`, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: "{}", cache: "no-store" })),
    await tryIt("GET stream", () => fetch(`${base}/tts/stream?req=%7B%7D`, { cache: "no-store" })),
  ].join(" · ");
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
      res = await openStream(base, JSON.stringify({ ...req, id }), controller.signal);
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
      void fetch(`${base}/tts/stop/${id}`, { method: postBlocked.has(base) ? "GET" : "POST" }).catch(() => undefined);
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
