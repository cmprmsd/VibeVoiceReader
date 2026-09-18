import type { BgRequest, ContentCommand, TtsPortIn, TtsPortOut } from "./shared/messages";
import { hasServerPermission, loadSettings, normalizeServerUrl, requestServerPermission } from "./shared/settings";
import { streamTts, type StreamHandle } from "./shared/tts-http";

declare const __SELFTEST__: boolean;

const MENU_ID = "vibevoice-read-selection";

browser.runtime.onInstalled.addListener(() => {
  browser.menus.create({
    id: MENU_ID,
    title: "Read selection with VibeVoice",
    contexts: ["selection"],
  });
});

/**
 * Firefox MV3 treats host permissions as optional, so the first user gesture
 * asks for access to the server origin (the prompt only appears once).
 * Must be invoked synchronously from the gesture handler.
 */
function ensureServerPermission(): Promise<boolean> {
  return loadSettings().then(async ({ serverUrl }) => {
    if (await hasServerPermission(serverUrl)) return true;
    try {
      return await requestServerPermission(serverUrl);
    } catch (e) {
      console.warn("[vibevoice] permission request failed:", e);
      return false;
    }
  });
}

/** Make sure the content script is present in the tab, then send it a command. */
async function sendToTab(tabId: number, cmd: ContentCommand): Promise<void> {
  let alive = false;
  try {
    alive = (await browser.tabs.sendMessage(tabId, { type: "ping" } satisfies ContentCommand)) === true;
    if (__SELFTEST__) console.log("[vv-selftest] ping ->", alive);
  } catch (e) {
    if (__SELFTEST__) console.log("[vv-selftest] ping failed:", String(e));
  }
  if (!alive) {
    const res = await browser.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    if (__SELFTEST__) console.log("[vv-selftest] executeScript ->", JSON.stringify(res));
  }
  await browser.tabs.sendMessage(tabId, cmd);
}

browser.action.onClicked.addListener((tab) => {
  const granted = ensureServerPermission();
  if (tab.id !== undefined) void granted.then(() => sendToTab(tab.id!, { type: "toggle" }));
});

browser.menus.onClicked.addListener((info, tab) => {
  const granted = ensureServerPermission();
  if (info.menuItemId === MENU_ID && tab?.id !== undefined) void granted.then(() => sendToTab(tab.id!, { type: "readSelection" }));
});

browser.commands.onCommand.addListener((command) => {
  if (command !== "read-selection") return;
  const granted = ensureServerPermission();
  void browser.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
    await granted;
    if (tab?.id !== undefined) void sendToTab(tab.id, { type: "readSelection" });
  });
});

// ---------------------------------------------------------------- HTTP relay
browser.runtime.onMessage.addListener((msg: BgRequest, _sender) => {
  switch (msg.type) {
    case "health":
      return fetchJson("/health");
    case "hasPermission":
      return loadSettings().then((s) => hasServerPermission(s.serverUrl));
    case "voices":
      return fetchJson("/voices" + (msg.model ? `?model=${encodeURIComponent(msg.model)}` : ""));
    case "models":
      return fetchJson("/models");
    case "loadModel":
      return postJson(`/models/${encodeURIComponent(msg.model)}/load`);
    case "openOptions":
      return browser.runtime.openOptionsPage();
    case "download": {
      const url = URL.createObjectURL(new Blob([msg.data], { type: msg.mime }));
      return browser.downloads.download({ url, filename: msg.filename, saveAs: msg.saveAs ?? true }).finally(() => setTimeout(() => URL.revokeObjectURL(url), 60_000));
    }
  }
  return undefined;
});

async function postJson(path: string): Promise<unknown> {
  const { serverUrl } = await loadSettings();
  const res = await fetch(normalizeServerUrl(serverUrl) + path, { method: "POST", cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { detail?: string }).detail ?? `${path}: HTTP ${res.status}`);
  return body;
}

async function fetchJson(path: string): Promise<unknown> {
  const { serverUrl } = await loadSettings();
  const res = await fetch(normalizeServerUrl(serverUrl) + path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// -------------------------------------------------------------- TTS relay
// The content script opens one runtime.Port per utterance; we stream the
// framed HTTP response from the local server and forward events + PCM frames.
// (Plain ws:// is blocked from extension contexts, http://127.0.0.1 is not.)
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "tts") return;
  let handle: StreamHandle | null = null;
  const send = (m: TtsPortOut) => {
    try {
      port.postMessage(m);
    } catch {
      /* port gone */
    }
  };
  port.onMessage.addListener((raw) => {
    const msg = raw as TtsPortIn;
    if (msg.type === "start") {
      handle = streamTts(msg.serverUrl, msg.req, {
        onEvent: (ev) => send({ type: "event", ev }),
        onAudio: (pcm) => send({ type: "audio", pcm }),
      });
    } else if (msg.type === "stop") {
      handle?.stop();
    }
  });
  port.onDisconnect.addListener(() => {
    handle?.abort();
    handle = null;
  });
});

// ------------------------------------------------------------------ selftest
// Only compiled in with VV_SELFTEST=1: auto-inject into a page whose URL carries
// "vv-selftest" and make the content script read a sample sentence, logging to
// stdout (web-ext --pref devtools.console.stdout.content=true).
if (__SELFTEST__) {
  const runSelftest = async (tabId: number, url: string) => {
    console.log("[vv-selftest] injecting into", url);
    try {
      await sendToTab(tabId, { type: "selftest" });
    } catch (e) {
      console.log("[vv-selftest] FAILED", String(e));
    }
  };
  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === "complete" && tab.url?.includes("vv-selftest")) void runSelftest(tabId, tab.url);
  });
  // The start tab usually finishes loading before the add-on is installed.
  void browser.tabs.query({}).then((tabs) => {
    console.log("[vv-selftest] background up; tabs:", tabs.map((t) => `${t.id}:${t.status}:${t.title ?? "-"}:${t.url ?? "-"}`).join(" | "));
    // Tab URLs may be hidden; inject everywhere and let the content script
    // check its own location for the marker.
    for (const t of tabs) if (t.id !== undefined) void runSelftest(t.id, t.url ?? t.title ?? String(t.id));
  });
}
