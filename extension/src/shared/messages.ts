/** Message contracts between background, content script and options page. */

export interface VoiceInfo {
  id: string;
  name: string;
  lang: string;
  lang_label: string;
  gender: string;
  experimental: boolean;
  preview: string;
}

export interface VoicesResponse {
  model?: string;
  default: string;
  voices: VoiceInfo[];
}

export interface ModelInfo {
  id: string;
  label: string;
  description: string;
  loaded: boolean;
  vram_gb: number;
  default_cfg_scale: number;
  default_steps: number;
  voices: number;
}

export interface ModelsResponse {
  default: string;
  max_loaded: number;
  models: ModelInfo[];
}

export interface Health {
  ok: boolean;
  version: string;
  model: string;
  device: string;
  attn: string;
  sample_rate: number;
  voices: number;
  default_voice: string;
  busy: boolean;
  waiting: number;
}

export interface TtsRequest {
  text: string;
  voice?: string | null;
  cfg_scale?: number;
  inference_steps?: number | null;
  /** best-of-N generation; audio only starts once the best take is chosen */
  candidates?: number;
  /** engine id: realtime | 1.5b | 7b (server default when omitted) */
  model?: string | null;
  /** page language tag, used by engines that need an explicit language */
  lang?: string | null;
}

export type TtsEvent =
  | { event: "queued"; position: number }
  | {
      event: "meta";
      text: string;
      voice: string;
      sample_rate: number;
      tokens: number;
      offsets: [number, number][];
      text_window: number;
      speech_window: number;
    }
  | { event: "progress"; window: number; tokens: number; samples: number; char: number | null }
  | { event: "quality"; score: number; candidates: number; scores: number[] }
  | { event: "stats"; seconds: number; elapsed_ms: number; rtf: number }
  | { event: "ping" }
  | { event: "loading"; model: string; label: string }
  | { event: "accepted"; id: string }
  | { event: "done"; samples: number; seconds: number; elapsed_ms: number; rtf: number | null; stopped: boolean; candidates?: number }
  | { event: "error"; message: string }
  | { event: "closed"; code?: number; reason?: string };

/** content -> background one-shot requests */
export type BgRequest =
  | { type: "health" }
  | { type: "probe" }
  | { type: "voices"; model?: string | null }
  | { type: "models" }
  | { type: "loadModel"; model: string }
  | { type: "hasPermission" }
  | { type: "openOptions" }
  | { type: "download"; filename: string; mime: string; data: ArrayBuffer; saveAs?: boolean };

/** background -> content commands */
export type ContentCommand =
  | { type: "ping" }
  | { type: "toggle" }
  | { type: "show" }
  | { type: "readSelection" }
  | { type: "selftest" };

/** content -> background over the "tts" port */
export type TtsPortIn = { type: "start"; req: TtsRequest; serverUrl: string } | { type: "stop" };

/** background -> content over the "tts" port */
export type TtsPortOut = { type: "event"; ev: TtsEvent } | { type: "audio"; pcm: ArrayBuffer };
