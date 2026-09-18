/**
 * Turns a page (or the current selection) into a list of paragraphs whose
 * text can be mapped back to DOM ranges.
 */
import { Readability } from "@mozilla/readability";
import { TextIndex, normalizeText } from "./text-index";

export interface Paragraph {
  /** normalised paragraph text */
  text: string;
  /** DOM range for [start, end) within `text`, or null if it cannot be located */
  locate: (start: number, end: number) => Range | null;
  kind: "heading" | "text";
}

export interface Extraction {
  title: string;
  paragraphs: Paragraph[];
  source: "article" | "selection" | "body";
  unlocated: number;
  unlocatedSamples: string[];
  skippedCaptions?: number;
}

const HOST_ID = "vibevoice-reader-host";
const skipOurs = (el: Element) => el.id === HOST_ID;
const CAPTION_TAGS = new Set(["FIGURE", "FIGCAPTION", "TABLE", "VIDEO", "AUDIO"]);
const CAPTION_CLASS = /^(.*caption.*|thumb.*|gallery.*|infobox.*|navbox.*|sidebar.*|mw-tmh.*|media-?player.*|hatnote|mw-indicator.*)$/i;

/** True when the element sits inside a figure, table, infobox, gallery or similar non-prose container. */
function isCaptionLike(el: Element): boolean {
  const stop = el.ownerDocument.body;
  for (let e: Element | null = el; e && e !== stop; e = e.parentElement) {
    if (CAPTION_TAGS.has(e.tagName) || e.getAttribute("role") === "figure") return true;
    for (const c of e.classList) if (CAPTION_CLASS.test(c)) return true;
  }
  return false;
}

/** Live block element containing normalised offset `pos`, if any. */
function blockAt(index: TextIndex, pos: number): Element | null {
  const range = index.rangeFor(pos, pos + 1);
  const node = range?.startContainer ?? null;
  return node ? (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)) : null;
}

function paragraphsFromSlices(index: TextIndex, slices: { start: number; end: number; kind: Paragraph["kind"] }[]): Paragraph[] {
  return slices
    .filter((s) => s.end > s.start)
    .map((s) => ({
      text: index.text.slice(s.start, s.end),
      kind: s.kind,
      locate: (a: number, b: number) => index.rangeFor(s.start + a, s.start + b),
    }))
    .filter((p) => normalizeText(p.text).length > 0);
}

/** Main article text via Readability, mapped back onto the live DOM. */
export function extractArticle(doc: Document = document): Extraction {
  const index = new TextIndex(doc.body, skipOurs);
  const clone = doc.cloneNode(true) as Document;
  clone.getElementById(HOST_ID)?.remove();
  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(clone, { charThreshold: 200 }).parse();
  } catch {
    article = null;
  }
  if (!article?.content) return extractBody(doc, index);

  const parsed = new DOMParser().parseFromString(article.content, "text/html");
  const blocks = Array.from(parsed.body.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, dd, dt"));
  const slices: { start: number; end: number; kind: Paragraph["kind"] }[] = [];
  let cursor = 0;
  let unlocated = 0;
  let skippedCaptions = 0;
  const unlocatedSamples: string[] = [];
  const seen = new Set<Element>();
  for (const el of blocks) {
    // skip blocks that contain other listed blocks (e.g. li > p) to avoid duplicates
    if (el.querySelector("p, li, blockquote, pre, h1, h2, h3, h4, h5, h6")) continue;
    if (seen.has(el)) continue;
    seen.add(el);
    const text = normalizeText(el.textContent ?? "");
    if (text.length < 2) continue;
    const kind: Paragraph["kind"] = /^H[1-6]$/.test(el.tagName) ? "heading" : "text";
    let pos = index.find(text, cursor);
    let len = text.length;
    if (pos < 0) {
      // Readability may have altered the block slightly; anchor on its head.
      const head = text.slice(0, Math.min(60, text.length));
      pos = index.find(head, cursor);
      if (pos >= 0) {
        const nl = index.text.indexOf("\n", pos);
        len = Math.min(text.length, (nl < 0 ? index.text.length : nl) - pos);
      }
    }
    if (pos < 0) {
      // Search from the beginning as a last resort (order changed).
      pos = index.find(text, 0);
      if (pos < 0) {
        unlocated++;
        if (unlocatedSamples.length < 5) unlocatedSamples.push(text.slice(0, 50));
        continue;
      }
    }
    cursor = pos + len;
    // Media captions, infoboxes and tables are not article prose.
    const live = blockAt(index, pos);
    if (live && isCaptionLike(live)) {
      skippedCaptions++;
      continue;
    }
    slices.push({ start: pos, end: pos + len, kind });
  }
  // Leading short blocks before the first real paragraph are usually captions or bylines.
  while (slices.length > 1 && slices[0].kind === "text" && slices[0].end - slices[0].start < 80) {
    slices.shift();
    skippedCaptions++;
  }
  if (slices.length === 0) return extractBody(doc, index);
  // App-like pages (chats, dashboards): Readability often keeps a sliver.  If
  // it covers little of the content root's text, read the content root instead.
  const covered = slices.reduce((n, sl) => n + (sl.end - sl.start), 0);
  const rootLen = new TextIndex(contentRoot(doc), skipChrome).text.length;
  if (rootLen > 400 && covered < rootLen * 0.35) return extractBody(doc);
  return { title: article.title ?? doc.title, paragraphs: paragraphsFromSlices(index, slices), source: "article", unlocated, unlocatedSamples, skippedCaptions };
}

// Page chrome for the automatic fallback.  Editors (contenteditable, e.g.
// Notion-style documents and chat composers' history) and forms are NOT
// excluded: many apps wrap their whole content in them.
const CHROME_SELECTOR = "nav, aside, header, footer, textarea, input, select, [role=navigation], [role=complementary], [role=banner], [role=contentinfo], [role=toolbar], [role=menu], [role=menubar], [role=tablist], button";

/** Elements that are page chrome rather than content (skipped by the fallback). */
const skipChrome = (el: Element) => el.id === HOST_ID || el.matches(CHROME_SELECTOR);

/** The element most likely to hold the page's content, for app-like pages. */
function contentRoot(doc: Document): Element {
  const candidates = Array.from(doc.querySelectorAll("main, [role=main], article, #content, .content"));
  let best: Element = doc.body;
  let bestLen = 0;
  for (const c of candidates) {
    const len = (c.textContent ?? "").length;
    if (len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  return best;
}

/** Fallback: every visible block under the content root, minus page chrome. */
export function extractBody(doc: Document = document, _index?: TextIndex): Extraction {
  const root = contentRoot(doc);
  const index = new TextIndex(root, skipChrome);
  const slices = index
    .blocks()
    .filter((b) => b.end - b.start >= 2)
    .map((b) => ({ start: b.start, end: b.end, kind: /^H[1-6]$/.test(b.block.tagName) ? ("heading" as const) : ("text" as const) }));
  return { title: doc.title, paragraphs: paragraphsFromSlices(index, slices), source: "body", unlocated: 0, unlocatedSamples: [] };
}

/** Read from a user-picked block to the end of its container.  The user chose
 *  the block, so only our own UI is skipped, never "chrome". */
export function extractFromElement(el: Element, doc: Document = document): Extraction {
  const container = el.closest("main, [role=main], article, section, [role=log], [role=feed], [contenteditable]") ?? contentRoot(doc);
  const index = new TextIndex(container.contains(el) ? container : el, skipOurs);
  const blocks = index.blocks();
  const startIdx = blocks.findIndex((b) => b.block === el || el.contains(b.block) || b.block.contains(el));
  const slices = blocks
    .slice(Math.max(0, startIdx))
    .filter((b) => b.end - b.start >= 2)
    .map((b) => ({ start: b.start, end: b.end, kind: /^H[1-6]$/.test(b.block.tagName) ? ("heading" as const) : ("text" as const) }));
  return { title: doc.title, paragraphs: paragraphsFromSlices(index, slices), source: "body", unlocated: 0, unlocatedSamples: [] };
}

/** The current selection, split at block boundaries. */
export function extractSelection(sel: Selection | null = window.getSelection()): Extraction | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const slices: { start: number; end: number; kind: Paragraph["kind"] }[] = [];
  const paragraphs: Paragraph[] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    let root: Node = range.commonAncestorContainer;
    if (root.nodeType === Node.TEXT_NODE) root = root.parentNode ?? root;
    const index = new TextIndex(root, skipOurs);
    let start = index.offsetFor(range.startContainer, range.startOffset, "start");
    let end = index.offsetFor(range.endContainer, range.endOffset, "end");
    // The model is unstable on inputs of three words or fewer: widen a tiny
    // selection to the sentence(s) containing it, within the same block.
    const words = index.text.slice(start, end).split(/\s+/).filter(Boolean).length;
    if (words < 4) {
      const t = index.text;
      let a = start;
      while (a > 0 && t[a - 1] !== "\n" && !/[.!?]/.test(t[a - 1] ?? "")) a--;
      while (a < start && /\s/.test(t[a])) a++;
      let b = end;
      while (b < t.length && t[b] !== "\n" && !/[.!?]/.test(t[b])) b++;
      if (b < t.length && /[.!?]/.test(t[b])) b++;
      start = a;
      end = b;
    }
    for (const b of index.blocks()) {
      const s = Math.max(b.start, start);
      const e = Math.min(b.end, end);
      if (e > s) slices.push({ start: s, end: e, kind: /^H[1-6]$/.test(b.block.tagName) ? "heading" : "text" });
    }
    paragraphs.push(...paragraphsFromSlices(index, slices.splice(0)));
  }
  if (paragraphs.length === 0) return null;
  return { title: document.title, paragraphs, source: "selection", unlocated: 0, unlocatedSamples: [] };
}
