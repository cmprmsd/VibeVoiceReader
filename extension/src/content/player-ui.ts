import type { VoiceInfo } from "../shared/messages";

export type PlayerState = "idle" | "loading" | "playing" | "paused" | "error";

export interface PlayerCallbacks {
  onPlayPause: () => void;
  onStop: () => void;
  onPrev: () => void;
  onNext: () => void;
  onReadSelection: () => void;
  onReadPage: () => void;
  onPick: () => void;
  onExport: () => void;
  onVoiceChange: (voiceId: string) => void;
  onRateChange: (rate: number) => void;
  onModeChange: (mode: "sentence" | "paragraph" | "auto") => void;
  onSettings: () => void;
  onClose: () => void;
}

type IconSpec = { size: number; stroke?: boolean; shapes: [string, Record<string, string>][] };

// Icons as element specs (built with createElementNS: no markup parsing, no innerHTML).
const ICON: Record<string, IconSpec> = {
  grip: { size: 16, shapes: [["circle", { cx: "9", cy: "6", r: "1.7" }], ["circle", { cx: "15", cy: "6", r: "1.7" }], ["circle", { cx: "9", cy: "12", r: "1.7" }], ["circle", { cx: "15", cy: "12", r: "1.7" }], ["circle", { cx: "9", cy: "18", r: "1.7" }], ["circle", { cx: "15", cy: "18", r: "1.7" }]] },
  play: { size: 22, shapes: [["path", { d: "M8 5.5v13a1 1 0 0 0 1.5.86l10-6.5a1 1 0 0 0 0-1.72l-10-6.5A1 1 0 0 0 8 5.5z" }]] },
  pause: { size: 22, shapes: [["rect", { x: "6", y: "5", width: "4.5", height: "14", rx: "1" }], ["rect", { x: "13.5", y: "5", width: "4.5", height: "14", rx: "1" }]] },
  prev: { size: 18, shapes: [["rect", { x: "5", y: "6", width: "2.5", height: "12", rx: "1" }], ["path", { d: "M19 6.8v10.4a1 1 0 0 1-1.55.83L9.6 12.83a1 1 0 0 1 0-1.66l7.85-5.2A1 1 0 0 1 19 6.8z" }]] },
  next: { size: 18, shapes: [["rect", { x: "16.5", y: "6", width: "2.5", height: "12", rx: "1" }], ["path", { d: "M5 6.8v10.4a1 1 0 0 0 1.55.83l7.85-5.2a1 1 0 0 0 0-1.66L6.55 5.97A1 1 0 0 0 5 6.8z" }]] },
  stop: { size: 16, shapes: [["rect", { x: "6", y: "6", width: "12", height: "12", rx: "2" }]] },
  download: { size: 18, stroke: true, shapes: [["path", { d: "M12 4v11m0 0-4-4m4 4 4-4M5 19h14" }]] },
  gear: { size: 18, stroke: true, shapes: [["circle", { cx: "12", cy: "12", r: "3" }], ["path", { d: "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" }]] },
  close: { size: 16, stroke: true, shapes: [["path", { d: "M6 6l12 12M18 6 6 18" }]] },
};

const SVG_NS = "http://www.w3.org/2000/svg";

/** Build an icon element directly in the SVG namespace. */
function svg(spec: IconSpec): SVGElement {
  const root = document.createElementNS(SVG_NS, "svg");
  root.setAttribute("viewBox", "0 0 24 24");
  root.setAttribute("width", String(spec.size));
  root.setAttribute("height", String(spec.size));
  root.setAttribute("aria-hidden", "true");
  if (spec.stroke) {
    root.setAttribute("fill", "none");
    root.setAttribute("stroke", "currentColor");
    root.setAttribute("stroke-width", "2");
    root.setAttribute("stroke-linecap", "round");
    root.setAttribute("stroke-linejoin", "round");
  } else {
    root.setAttribute("fill", "currentColor");
  }
  for (const [tag, attrs] of spec.shapes) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    root.append(el);
  }
  return root;
}

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.bar {
  position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
  z-index: 2147483647; display: flex; align-items: center; gap: 4px;
  padding: 6px 10px; border-radius: 999px;
  background: #ffffff; color: #1f2937; border: 1px solid #e5e7eb;
  box-shadow: 0 8px 30px rgba(0,0,0,.18);
  font: 13px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  user-select: none; -webkit-user-select: none; max-width: calc(100vw - 24px);
}
.bar.hidden { display: none; }
.handle { cursor: grab; padding: 0 2px 0 4px; color: #9ca3af; display: inline-flex; align-items: center; }
.handle:hover { color: #6b7280; }
.handle:active { cursor: grabbing; }
button svg { display: block; }
button { appearance: none; border: 0; background: transparent; color: inherit; cursor: pointer;
  width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  font: inherit; font-size: 15px; }
button:hover { background: #f3f4f6; }
button:disabled { opacity: .35; cursor: default; }
button.play { width: 40px; height: 40px; background: #4f46e5; color: #fff; font-size: 18px; }
button.play:hover { background: #4338ca; }
button.text { width: auto; border-radius: 999px; padding: 0 12px; font-size: 12px; font-weight: 600; background: #eef2ff; color: #3730a3; }
button.text:hover { background: #e0e7ff; }
.voice { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px 2px 2px; border-radius: 999px; }
.voice:hover { background: #f3f4f6; }
.avatar { width: 30px; height: 30px; border-radius: 50%; background: linear-gradient(135deg,#6366f1,#ec4899); color: #fff;
  display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; }
select { appearance: none; border: 0; background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer;
  max-width: 130px; text-overflow: ellipsis; padding-right: 12px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%236b7280' stroke-width='1.5'/></svg>");
  background-repeat: no-repeat; background-position: right 0 center; }
select.rate { max-width: 62px; font-weight: 500; color: #4b5563; }
select.mode { max-width: 96px; font-weight: 500; color: #4b5563; }
.counter { font-size: 11px; color: #6b7280; min-width: 54px; text-align: center; }
.time { font-variant-numeric: tabular-nums; color: #4b5563; min-width: 84px; text-align: center; }
.sep { width: 1px; height: 22px; background: #e5e7eb; margin: 0 4px; }
.status { position: absolute; left: 50%; top: 100%; transform: translateX(-50%); margin-top: 6px; white-space: nowrap;
  font-size: 11px; color: #6b7280; background: #fff; padding: 3px 10px; border-radius: 999px; border: 1px solid #e5e7eb; }
.status:empty { display: none; }
.status.error { color: #b91c1c; }
.dialog { position: absolute; left: 50%; top: 100%; transform: translateX(-50%); margin-top: 10px; width: min(560px, calc(100vw - 32px));
  background: #fff; color: #1f2937; border: 1px solid #e5e7eb; border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.2); padding: 14px 16px;
  font-size: 13px; user-select: text; }
.dialog h3 { margin: 0 0 8px; font-size: 14px; }
.dialog .row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
.dialog label { min-width: 46px; color: #6b7280; font-size: 12px; }
.dialog input[type=range] { flex: 1; }
.dialog .preview { font-size: 12px; color: #4b5563; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dialog .meta { font-size: 12px; color: #6b7280; }
.dialog .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.dialog .progress { height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; margin-top: 10px; }
.dialog .progress > div { height: 100%; background: #4f46e5; width: 0; transition: width .2s; }
.dialog button.text { height: 30px; }
.dialog .hidden { display: none; }
.dialog input[type=text] { flex: 1; padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 6px; font: inherit; background: transparent; color: inherit; min-width: 0; }
.dialog select.field { border: 1px solid #d1d5db; border-radius: 6px; padding: 4px 22px 4px 8px; font-weight: 500; max-width: none; background-color: transparent; }
.dialog input[type=color] { width: 36px; height: 28px; padding: 0; border: 1px solid #d1d5db; border-radius: 6px; background: transparent; }
.dialog .swatch { padding: 2px 6px; border-radius: 4px; }
.dialog .value { min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; color: #6b7280; font-size: 12px; }
.dialog .grid { display: grid; grid-template-columns: 120px 1fr; gap: 8px 12px; align-items: center; }
.dialog .grid label { min-width: 0; }
@media (prefers-color-scheme: dark) { .dialog input[type=text], .dialog select.field, .dialog input[type=color] { border-color: #4b5563; } }
@media (max-width: 720px) {
  .bar { left: 8px; right: 8px; transform: none; max-width: none; flex-wrap: wrap; justify-content: center; row-gap: 2px; border-radius: 18px; padding: 6px 8px; }
  .sep { display: none; }
  .time { min-width: 0; }
  .dialog { width: calc(100vw - 16px); left: 50%; }
}
@media (prefers-color-scheme: dark) {
  .bar, .status { background: #1f2937; color: #f3f4f6; border-color: #374151; }
  button:hover, .voice:hover { background: #374151; }
  button.text { background: #312e81; color: #e0e7ff; }
  .time, select.rate, select.mode, .counter { color: #d1d5db; } .sep { background: #374151; }
  .dialog { background: #1f2937; color: #f3f4f6; border-color: #374151; }
  .dialog .preview, .dialog .meta, .dialog label { color: #9ca3af; }
  .dialog .progress { background: #374151; }
}
`;

export class PlayerUI {
  readonly host: HTMLElement;
  private root: ShadowRoot;
  private bar: HTMLElement;
  private playBtn: HTMLButtonElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private voiceSel: HTMLSelectElement;
  private rateSel: HTMLSelectElement;
  private modeSel: HTMLSelectElement;
  private counterEl: HTMLElement;
  private avatar: HTMLElement;
  private timeEl: HTMLElement;
  private statusEl: HTMLElement;
  private readPageBtn: HTMLButtonElement;
  private dialog: HTMLElement | null = null;
  private state: PlayerState = "idle";

  constructor(private cb: PlayerCallbacks) {
    this.host = document.createElement("div");
    this.host.id = "vibevoice-reader-host";
    this.root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.root.append(style);

    this.bar = el("div", "bar hidden");
    const handle = el("span", "handle");
    handle.append(svg(ICON.grip));
    handle.title = "Drag to move";
    this.makeDraggable(handle);

    const voiceWrap = el("label", "voice");
    this.avatar = el("span", "avatar", "V");
    this.voiceSel = document.createElement("select");
    this.voiceSel.title = "Voice";
    this.voiceSel.addEventListener("change", () => {
      this.updateAvatar();
      cb.onVoiceChange(this.voiceSel.value);
    });
    voiceWrap.append(this.avatar, this.voiceSel);

    this.prevBtn = iconBtn(ICON.prev, "Previous sentence", cb.onPrev);
    this.playBtn = iconBtn(ICON.play, "Play / pause", cb.onPlayPause, "play");
    this.nextBtn = iconBtn(ICON.next, "Next sentence", cb.onNext);
    this.stopBtn = iconBtn(ICON.stop, "Stop", cb.onStop);
    this.timeEl = el("span", "time", "0:00 / 0:00");

    this.rateSel = document.createElement("select");
    this.rateSel.className = "rate";
    this.rateSel.title = "Speed";
    for (const r of [0.75, 1, 1.25, 1.5, 2]) this.rateSel.append(new Option(`${r}×`, String(r)));
    this.rateSel.addEventListener("change", () => cb.onRateChange(Number(this.rateSel.value)));

    this.modeSel = document.createElement("select");
    this.modeSel.className = "mode";
    this.modeSel.title = "How much text is sent to the model at once. Paragraph = more natural flow; sentence = exact highlighting.";
    this.modeSel.append(new Option("Paragraph", "paragraph"), new Option("Sentence", "sentence"), new Option("Auto", "auto"));
    this.modeSel.addEventListener("change", () => cb.onModeChange(this.modeSel.value as "sentence" | "paragraph" | "auto"));
    this.counterEl = el("span", "counter", "");

    const readSel = btn("Selection", "Read the selected text (Alt+Shift+S)", cb.onReadSelection, "text");
    this.readPageBtn = btn("Page", "Read the main text of this page", cb.onReadPage, "text");
    const pick = btn("Pick", "Click a block on the page to read from there (for chats and app-like pages)", cb.onPick, "text");
    const exportBtn = iconBtn(ICON.download, "Export as MP3 or WAV…", cb.onExport);
    const settings = iconBtn(ICON.gear, "Settings", cb.onSettings);
    const close = iconBtn(ICON.close, "Close", cb.onClose);

    this.statusEl = el("div", "status");
    this.bar.append(
      handle, voiceWrap, el("span", "sep"),
      this.prevBtn, this.playBtn, this.nextBtn, this.stopBtn, this.timeEl, this.counterEl, this.rateSel, this.modeSel,
      el("span", "sep"), readSel, this.readPageBtn, pick, exportBtn, settings, close, this.statusEl,
    );
    this.root.append(this.bar);
    this.setState("idle");
  }

  mount(): void {
    if (!this.host.isConnected) (document.body ?? document.documentElement).append(this.host);
  }
  show(): void {
    this.mount();
    this.bar.classList.remove("hidden");
  }
  hide(): void {
    this.bar.classList.add("hidden");
  }
  get visible(): boolean {
    return this.host.isConnected && !this.bar.classList.contains("hidden");
  }

  /** Show a single disabled entry in the voice dropdown (server down, no voices). */
  setVoicesPlaceholder(text: string): void {
    this.voiceSel.replaceChildren(new Option(text, "", true, true));
    this.voiceSel.disabled = true;
    this.avatar.textContent = "!";
  }

  setVoices(voices: VoiceInfo[], selected: string | null, serverDefault: string): void {
    if (voices.length === 0) {
      this.setVoicesPlaceholder("No voices for this model");
      return;
    }
    this.voiceSel.disabled = false;
    this.voiceSel.replaceChildren();
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const v of voices) {
      const key = v.lang_label + (v.experimental ? " (experimental)" : "");
      let g = groups.get(key);
      if (!g) {
        g = document.createElement("optgroup");
        g.label = key;
        groups.set(key, g);
        this.voiceSel.append(g);
      }
      g.append(new Option(`${v.name} (${v.gender === "woman" ? "F" : "M"})`, v.id));
    }
    this.voiceSel.value = selected && voices.some((v) => v.id === selected) ? selected : serverDefault;
    this.updateAvatar();
  }
  get voice(): string {
    return this.voiceSel.value;
  }
  setRate(rate: number): void {
    this.rateSel.value = String(rate);
  }
  setMode(mode: string): void {
    this.modeSel.value = mode;
  }
  setCounter(index: number, total: number): void {
    this.counterEl.textContent = total > 0 ? `${Math.min(index + 1, total)} / ${total}` : "";
  }
  setNavEnabled(prev: boolean, next: boolean): void {
    this.prevBtn.disabled = !prev;
    this.nextBtn.disabled = !next;
  }
  setReadPageEnabled(enabled: boolean): void {
    this.readPageBtn.disabled = !enabled;
    this.readPageBtn.title = enabled ? "Read the main text of this page" : "Coming in the next step";
  }
  setTime(posSec: number, totalSec: number, buffering: boolean): void {
    this.timeEl.textContent = `${fmt(posSec)} / ${buffering ? "~" : ""}${fmt(totalSec)}`;
  }
  setStatus(text: string, isError = false): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("error", isError);
  }
  setState(state: PlayerState): void {
    this.state = state;
    this.playBtn.replaceChildren(svg(state === "playing" ? ICON.pause : ICON.play));
    this.playBtn.disabled = state === "loading";
    this.stopBtn.disabled = state === "idle";
    if (state === "idle") {
      this.setTime(0, 0, false);
      this.setCounter(0, 0);
    }
  }
  get currentState(): PlayerState {
    return this.state;
  }

  /** Rendered widths of the icons in the bar (self-test aid). */
  iconWidths(): number[] {
    return Array.from(this.bar.querySelectorAll("svg")).map((el) => {
      const shape = el.firstElementChild as SVGGraphicsElement | null;
      const bbox = shape && typeof shape.getBBox === "function" ? shape.getBBox().width : 0;
      return Math.round(el.getBoundingClientRect().width * 100 + bbox) / 100; // boxWidth.shapeWidth
    });
  }

  // ------------------------------------------------------------ export dialog
  showExportDialog(
    sentences: { text: string }[],
    sourceLabel: string,
    formats: { value: string; label: string }[],
    defaultFormat: string,
    onStart: (from: number, to: number, format: string) => void,
  ): void {
    this.closeDialog();
    const d = el("div", "dialog");
    d.addEventListener("mousedown", (e) => e.stopPropagation());
    d.addEventListener("click", (e) => e.stopPropagation());
    const n = sentences.length;
    d.append(el("h3", "", `Export audio — ${sourceLabel}`));
    const fromRow = el("div", "row");
    const toRow = el("div", "row");
    const from = document.createElement("input");
    const to = document.createElement("input");
    for (const [inp, v] of [[from, 0], [to, n - 1]] as const) {
      inp.type = "range";
      inp.min = "0";
      inp.max = String(n - 1);
      inp.value = String(v);
    }
    const fromPrev = el("div", "preview");
    const toPrev = el("div", "preview");
    const meta = el("div", "meta");
    fromRow.append(el("label", "", "Start"), from);
    toRow.append(el("label", "", "End"), to);
    const update = () => {
      let a = Number(from.value), b = Number(to.value);
      if (a > b) [a, b] = [b, a];
      fromPrev.textContent = `▶ ${a + 1}: ${sentences[a].text}`;
      toPrev.textContent = `■ ${b + 1}: ${sentences[b].text}`;
      const chars = sentences.slice(a, b + 1).reduce((s, x) => s + x.text.length, 0);
      meta.textContent = `${b - a + 1} of ${n} sentences · about ${fmt(chars * 0.065)} of audio · takes roughly ${fmt(chars * 0.065 * 0.8)} to generate`;
    };
    from.addEventListener("input", update);
    to.addEventListener("input", update);
    update();
    const fmtRow = el("div", "row");
    const fmtSel = document.createElement("select");
    fmtSel.className = "mode";
    fmtSel.style.maxWidth = "none";
    for (const f of formats) fmtSel.append(new Option(f.label, f.value));
    fmtSel.value = defaultFormat;
    fmtRow.append(el("label", "", "Format"), fmtSel);
    const progress = el("div", "progress hidden");
    const bar = el("div", "");
    progress.append(bar);
    const status = el("div", "meta");
    const actions = el("div", "actions");
    const cancel = btn("Cancel", "Close", () => this.closeDialog(), "text");
    const start = btn("Export", "Synthesize the range and save it", () => {
      let a = Number(from.value), b = Number(to.value);
      if (a > b) [a, b] = [b, a];
      from.disabled = to.disabled = start.disabled = fmtSel.disabled = true;
      progress.classList.remove("hidden");
      onStart(a, b, fmtSel.value);
    }, "text");
    actions.append(cancel, start);
    d.append(fromRow, fromPrev, toRow, toPrev, fmtRow, meta, progress, status, actions);
    this.bar.append(d);
    this.dialog = d;
    (d as any).__progress = (frac: number, text: string, done: boolean) => {
      bar.style.width = `${Math.round(frac * 100)}%`;
      status.textContent = text;
      if (done) {
        start.classList.add("hidden");
        cancel.textContent = "Close";
      }
    };
  }

  // ------------------------------------------------------------ settings panel
  showSettingsDialog(
    current: { serverUrl: string; model: string | null; candidates: number; inferenceSteps: number; cfgScale: number; highlightColor: string; transport: string },
    models: { default: string; models: { id: string; label: string; description: string; loaded: boolean; available?: boolean; vram_gb: number }[] } | null,
    cb: {
      onChange: (patch: Record<string, unknown>) => void;
      onPreviewColor: (css: string) => void;
      onTestServer: (url: string) => Promise<string>;
      onOpenExtensionSettings: () => void;
    },
  ): void {
    this.closeDialog();
    const d = el("div", "dialog");
    d.addEventListener("mousedown", (e) => e.stopPropagation());
    d.addEventListener("click", (e) => e.stopPropagation());
    d.append(el("h3", "", "Settings"));
    const grid = el("div", "grid");
    const row = (label: string, ...nodes: (HTMLElement | string)[]) => {
      grid.append(el("label", "", label));
      const wrap = el("div", "row");
      wrap.style.margin = "0";
      wrap.append(...nodes);
      grid.append(wrap);
    };
    const select = (values: [string, string][], value: string, onChange: (v: string) => void) => {
      const sel = document.createElement("select");
      sel.className = "mode field";
      for (const [v, l] of values) sel.append(new Option(l, v));
      sel.value = value;
      sel.addEventListener("change", () => onChange(sel.value));
      return sel;
    };

    // server
    const url = document.createElement("input");
    url.type = "text";
    url.value = current.serverUrl;
    const test = btn("Test", "Check the server", () => {
      status.textContent = "Testing…";
      void cb.onTestServer(url.value).then((r) => (status.textContent = r));
    }, "text");
    const status = el("div", "meta");
    url.addEventListener("change", () => cb.onChange({ serverUrl: url.value }));
    row("Server URL", url, test);
    grid.append(el("span", ""), status);
    const hint = el("div", "meta", "Access to a server outside localhost must be granted in the ");
    const link = btn("extension settings", "Open the extension settings page", cb.onOpenExtensionSettings, "text");
    link.style.height = "22px";
    hint.append(link);
    grid.append(el("span", ""), hint);

    if (models) {
      const opts: [string, string][] = [["", `Server default (${models.default})`]];
      for (const m of models.models) opts.push([m.id, `${m.label} — ~${m.vram_gb} GB${m.loaded ? " · loaded" : m.available === false ? " · not installed" : ""}`]);
      const modelSel = select(opts, current.model ?? "", (v) => cb.onChange({ model: v || null }));
      for (const o of Array.from(modelSel.options)) {
        if (models.models.find((m) => m.id === o.value)?.available === false) o.disabled = true;
      }
      row("Model", modelSel);
      const desc = el("div", "meta", models.models.find((m) => m.id === (current.model ?? models.default))?.description ?? "");
      modelSel.addEventListener("change", () => (desc.textContent = models.models.find((m) => m.id === (modelSel.value || models.default))?.description ?? ""));
      grid.append(el("span", ""), desc);
    }
    row("Glitch filter", select([["1", "Off"], ["2", "2 takes (default)"], ["3", "3 takes"]], String(current.candidates), (v) => cb.onChange({ candidates: Number(v) })));
    row("Diffusion steps", select([["5", "5 (default)"], ["10", "10"], ["15", "15"], ["20", "20"]], String(current.inferenceSteps), (v) => cb.onChange({ inferenceSteps: Number(v) })));

    const cfg = document.createElement("input");
    cfg.type = "range";
    cfg.min = "1";
    cfg.max = "2.5";
    cfg.step = "0.05";
    cfg.value = String(current.cfgScale);
    const cfgVal = el("span", "value", current.cfgScale.toFixed(2));
    cfg.addEventListener("input", () => (cfgVal.textContent = Number(cfg.value).toFixed(2)));
    cfg.addEventListener("change", () => cb.onChange({ cfgScale: Number(cfg.value) }));
    row("Guidance scale", cfg, cfgVal);

    // highlight colour with live preview
    const { hex, alpha } = parseColor(current.highlightColor);
    const color = document.createElement("input");
    color.type = "color";
    color.value = hex;
    const op = document.createElement("input");
    op.type = "range";
    op.min = "0.1";
    op.max = "0.9";
    op.step = "0.05";
    op.value = String(alpha);
    const opVal = el("span", "value", `${Math.round(alpha * 100)}%`);
    const swatch = el("span", "swatch", "preview");
    const css = () => hexToRgba(color.value, Number(op.value));
    const preview = () => {
      swatch.style.backgroundColor = css();
      opVal.textContent = `${Math.round(Number(op.value) * 100)}%`;
      cb.onPreviewColor(css());
    };
    const commit = () => cb.onChange({ highlightColor: css() });
    color.addEventListener("input", preview);
    op.addEventListener("input", preview);
    color.addEventListener("change", commit);
    op.addEventListener("change", commit);
    preview();
    row("Highlight", color, op, opVal, swatch);

    row("Connection", select([["relay", "Through the extension (default)"], ["direct", "Directly from the page"]], current.transport, (v) => cb.onChange({ transport: v })));

    d.append(grid);
    const actions = el("div", "actions");
    actions.append(btn("Close", "Close", () => this.closeDialog(), "text"));
    d.append(actions);
    this.bar.append(d);
    this.dialog = d;
  }

  setExportProgress(frac: number, text: string, done = false): void {
    (this.dialog as any)?.__progress?.(frac, text, done);
  }

  closeDialog(): void {
    this.dialog?.remove();
    this.dialog = null;
  }

  private updateAvatar(): void {
    const opt = this.voiceSel.selectedOptions[0];
    this.avatar.textContent = (opt?.textContent ?? "V").trim().charAt(0).toUpperCase();
  }

  private makeDraggable(handle: HTMLElement): void {
    let startX = 0, startY = 0, origX = 0, origY = 0;
    const onMove = (e: MouseEvent) => {
      this.bar.style.left = `${origX + e.clientX - startX}px`;
      this.bar.style.top = `${Math.max(0, origY + e.clientY - startY)}px`;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
    };
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const r = this.bar.getBoundingClientRect();
      this.bar.style.transform = "none";
      this.bar.style.left = `${r.left}px`;
      this.bar.style.top = `${r.top}px`;
      startX = e.clientX; startY = e.clientY; origX = r.left; origY = r.top;
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    });
  }
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label: string, title: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}
function iconBtn(icon: IconSpec, title: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = btn("", title, onClick, cls);
  b.append(svg(icon));
  return b;
}
function parseColor(css: string): { hex: string; alpha: number } {
  const m = /rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\)/.exec(css);
  if (m) {
    const h = (n: string) => Number(n).toString(16).padStart(2, "0");
    return { hex: `#${h(m[1])}${h(m[2])}${h(m[3])}`, alpha: m[4] !== undefined ? Number(m[4]) : 1 };
  }
  if (/^#[0-9a-f]{6}$/i.test(css)) return { hex: css, alpha: 0.3 };
  return { hex: "#6366f1", alpha: 0.28 };
}
function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha.toFixed(2)})`;
}
function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
