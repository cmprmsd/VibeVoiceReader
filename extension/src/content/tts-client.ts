import type { TtsEvent, TtsPortIn, TtsPortOut, TtsRequest } from "../shared/messages";
import { type Settings } from "../shared/settings";
import { streamTts } from "../shared/tts-http";

export interface TtsHandlers {
  onEvent: (ev: TtsEvent) => void;
  onAudio: (pcm: ArrayBuffer) => void;
}

export interface TtsSession {
  /** Ask the server to stop generating; the "done" event still arrives. */
  stop(): void;
  /** Tear the connection down immediately. */
  close(): void;
}

export function startTts(req: TtsRequest, settings: Settings, h: TtsHandlers): TtsSession {
  return usesDirect(settings) ? direct(req, settings, h) : relay(req, settings, h);
}

/** "direct" only works when the page may talk to the server: an https page cannot fetch http (mixed content). */
export function usesDirect(settings: Settings): boolean {
  if (settings.transport !== "direct") return false;
  const http = /^http:/i.test(settings.serverUrl.trim()) || !/^https?:/i.test(settings.serverUrl.trim());
  return !(location.protocol === "https:" && http);
}

const tag = (ev: TtsEvent, path: string): TtsEvent => (ev.event === "error" ? { ...ev, message: `${ev.message} [${path}]` } : ev);

function relay(req: TtsRequest, settings: Settings, h: TtsHandlers): TtsSession {
  const port = browser.runtime.connect({ name: "tts" });
  let closed = false;
  port.onMessage.addListener((raw) => {
    const m = raw as TtsPortOut;
    if (m.type === "audio") h.onAudio(m.pcm);
    else {
      if (m.ev.event === "closed") closed = true;
      h.onEvent(tag(m.ev, "via extension"));
    }
  });
  port.onDisconnect.addListener(() => {
    if (!closed) {
      closed = true;
      h.onEvent({ event: "closed", reason: "background disconnected" });
    }
  });
  port.postMessage({ type: "start", req, serverUrl: settings.serverUrl } satisfies TtsPortIn);
  // The background event page may already have unloaded (it goes away after
  // ~30 s without messages), which disconnects the port; never let that throw.
  return {
    stop: () => {
      if (closed) return;
      try {
        port.postMessage({ type: "stop" } satisfies TtsPortIn);
      } catch {
        closed = true;
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}

function direct(req: TtsRequest, settings: Settings, h: TtsHandlers): TtsSession {
  const handle = streamTts(settings.serverUrl, req, { onAudio: h.onAudio, onEvent: (ev) => h.onEvent(tag(ev, "direct from page")) });
  return { stop: () => handle.stop(), close: () => handle.abort() };
}
