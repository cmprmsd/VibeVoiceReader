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
  return settings.transport === "direct" ? direct(req, settings, h) : relay(req, settings, h);
}

function relay(req: TtsRequest, settings: Settings, h: TtsHandlers): TtsSession {
  const port = browser.runtime.connect({ name: "tts" });
  let closed = false;
  port.onMessage.addListener((raw) => {
    const m = raw as TtsPortOut;
    if (m.type === "audio") h.onAudio(m.pcm);
    else {
      if (m.ev.event === "closed") closed = true;
      h.onEvent(m.ev);
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
  const handle = streamTts(settings.serverUrl, req, h);
  return { stop: () => handle.stop(), close: () => handle.abort() };
}
