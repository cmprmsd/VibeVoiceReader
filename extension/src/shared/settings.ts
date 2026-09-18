export type Transport = "relay" | "direct";

export type ChunkMode = "sentence" | "paragraph" | "auto";

export interface Settings {
  serverUrl: string;
  /** engine id, null = server default */
  model: string | null;
  voice: string | null;
  rate: number;
  cfgScale: number;
  inferenceSteps: number;
  /** best-of-N takes for prefetched chunks (1 = off) */
  candidates: number;
  exportFormat: "mp3-256" | "mp3-128" | "wav";
  transport: Transport;
  chunkMode: ChunkMode;
  highlightColor: string;
}

export const DEFAULTS: Settings = {
  serverUrl: "http://127.0.0.1:8877",
  model: null,
  voice: null,
  rate: 1,
  cfgScale: 1.25,
  inferenceSteps: 5,
  candidates: 2,
  exportFormat: "mp3-256",
  transport: "relay",
  chunkMode: "paragraph",
  highlightColor: "rgba(99, 102, 241, 0.28)",
};

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get("settings");
  return { ...DEFAULTS, ...((stored.settings as Partial<Settings>) ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await browser.storage.local.set({ settings: next });
  return next;
}

export function normalizeServerUrl(url: string): string {
  let u = url.trim();
  if (!/^https?:\/\//.test(u)) u = "http://" + u;
  return u.replace(/\/+$/, "");
}

export function wsUrl(serverUrl: string, path: string): string {
  return normalizeServerUrl(serverUrl).replace(/^http/, "ws") + path;
}

/** Match pattern for the server origin, for permissions.request/contains. */
export function serverOriginPattern(serverUrl: string): string {
  const u = new URL(normalizeServerUrl(serverUrl));
  return `${u.protocol}//${u.hostname}/*`;
}

export async function hasServerPermission(serverUrl: string): Promise<boolean> {
  return browser.permissions.contains({ origins: [serverOriginPattern(serverUrl)] });
}

/** Must be called from a user-input handler (toolbar click, button, shortcut). */
export async function requestServerPermission(serverUrl: string): Promise<boolean> {
  return browser.permissions.request({ origins: [serverOriginPattern(serverUrl)] });
}
