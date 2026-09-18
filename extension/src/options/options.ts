import type { Health, VoicesResponse } from "../shared/messages";
import { loadSettings, normalizeServerUrl, requestServerPermission, saveSettings, type ChunkMode, type Transport } from "../shared/settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");

function setStatus(text: string, ok?: boolean) {
  status.textContent = text;
  status.className = ok === undefined ? "" : ok ? "ok" : "bad";
}

async function fillVoices(serverUrl: string, selected: string | null) {
  const sel = $<HTMLSelectElement>("voice");
  sel.replaceChildren();
  try {
    const res = await fetch(normalizeServerUrl(serverUrl) + "/voices");
    const data = (await res.json()) as VoicesResponse;
    const auto = new Option("Server default (" + data.default + ")", "");
    sel.append(auto);
    for (const v of data.voices) {
      const label = `${v.name} · ${v.lang_label} · ${v.gender}${v.experimental ? " · experimental" : ""}`;
      sel.append(new Option(label, v.id));
    }
    sel.value = selected ?? "";
  } catch {
    sel.append(new Option("(server unreachable)", ""));
  }
}

async function init() {
  const s = await loadSettings();
  $<HTMLInputElement>("serverUrl").value = s.serverUrl;
  $<HTMLSelectElement>("rate").value = String(s.rate);
  $<HTMLSelectElement>("transport").value = s.transport;
  $<HTMLSelectElement>("chunkMode").value = s.chunkMode;
  $<HTMLSelectElement>("inferenceSteps").value = String(s.inferenceSteps);
  $<HTMLSelectElement>("candidates").value = String(s.candidates);
  $<HTMLInputElement>("cfgScale").value = String(s.cfgScale);
  $<HTMLInputElement>("highlightColor").value = s.highlightColor;
  await fillVoices(s.serverUrl, s.voice);

  $("test").addEventListener("click", async () => {
    const url = normalizeServerUrl($<HTMLInputElement>("serverUrl").value);
    const granted = requestServerPermission(url); // synchronous with the click
    setStatus("Testing…");
    try {
      if (!(await granted)) throw new Error("permission to reach the server origin was not granted");
      const h = (await (await fetch(url + "/health")).json()) as Health;
      setStatus(`OK: ${h.model} on ${h.device} (${h.attn}), ${h.voices} voices`, true);
      await fillVoices(url, $<HTMLSelectElement>("voice").value || null);
    } catch (e) {
      setStatus(`Cannot reach ${url}: ${(e as Error).message}`, false);
    }
  });

  $("save").addEventListener("click", async () => {
    const url = normalizeServerUrl($<HTMLInputElement>("serverUrl").value);
    const granted = requestServerPermission(url);
    await saveSettings({
      serverUrl: url,
      voice: $<HTMLSelectElement>("voice").value || null,
      rate: Number($<HTMLSelectElement>("rate").value) || 1,
      transport: $<HTMLSelectElement>("transport").value as Transport,
      chunkMode: $<HTMLSelectElement>("chunkMode").value as ChunkMode,
      inferenceSteps: Number($<HTMLSelectElement>("inferenceSteps").value) || 5,
      candidates: Number($<HTMLSelectElement>("candidates").value) || 1,
      cfgScale: Math.min(2.5, Math.max(1, Number($<HTMLInputElement>("cfgScale").value) || 1.25)),
      highlightColor: $<HTMLInputElement>("highlightColor").value.trim() || "rgba(99, 102, 241, 0.28)",
    });
    setStatus((await granted) ? "Saved." : "Saved, but access to the server origin was not granted.", (await granted));
  });
}

void init();
