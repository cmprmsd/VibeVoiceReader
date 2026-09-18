/**
 * TextIndex: a whitespace-normalised view of the visible text under a root
 * node, with a per-character map back to the original DOM text nodes.  It is
 * what lets us take text that came from Readability (or from the selection),
 * find it, and turn any [start, end) slice back into a live DOM Range for
 * highlighting.
 *
 * Normalisation: runs of whitespace (incl. NBSP) collapse to one space, and a
 * "\n" is inserted whenever the nearest block ancestor changes.
 */

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "MATH", "IFRAME", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "CANVAS", "VIDEO", "AUDIO"]);
const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "TD", "TH", "DT", "DD", "SECTION",
  "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "NAV", "FIGCAPTION", "FIGURE", "DETAILS", "SUMMARY", "UL", "OL",
  "TABLE", "TR", "BODY", "FORM", "FIELDSET", "ADDRESS", "HR", "CAPTION",
]);

export interface TextRun {
  node: Text;
  block: Element;
  /** global normalised start offset */
  start: number;
  /** normalised length */
  length: number;
  /** normalised index -> offset in node.data */
  map: Uint32Array;
}

export function normalizeText(s: string): string {
  return s.replace(/[\s ​﻿]+/g, " ").trim();
}

export class TextIndex {
  readonly runs: TextRun[] = [];
  text = "";
  private byNode = new Map<Text, TextRun>();

  constructor(root: Node, private skipElement?: (el: Element) => boolean) {
    this.build(root);
  }

  private build(root: Node): void {
    const doc = root.ownerDocument ?? document;
    const visible = new Map<Element, boolean>();
    const isVisible = (el: Element): boolean => {
      let v = visible.get(el);
      if (v === undefined) {
        v = !SKIP_TAGS.has(el.tagName) && !(this.skipElement?.(el) ?? false) && (el.parentElement ? isVisible(el.parentElement) : true);
        if (v && el instanceof HTMLElement) {
          if (el.hidden || el.getAttribute("aria-hidden") === "true") v = false;
          else if (typeof el.checkVisibility === "function" && !el.checkVisibility()) v = false;
        }
        visible.set(el, v);
      }
      return v;
    };
    const blockOf = (el: Element): Element => {
      let e: Element | null = el;
      while (e && !BLOCK_TAGS.has(e.tagName)) e = e.parentElement;
      return e ?? doc.body ?? el;
    };

    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = (n as Text).parentElement;
        return p && isVisible(p) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const parts: string[] = [];
    let total = 0;
    let lastBlock: Element | null = null;
    let endsWithSpace = true; // suppress leading spaces
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const data = n.data;
      if (!data) continue;
      const block = blockOf(n.parentElement!);
      if (lastBlock && block !== lastBlock && !endsWithSpace) {
        parts.push("\n");
        total += 1;
        endsWithSpace = true;
      } else if (lastBlock && block !== lastBlock && parts.length && parts[parts.length - 1] === " ") {
        // replace trailing space by a block separator
        parts[parts.length - 1] = "\n";
      }
      lastBlock = block;
      const map: number[] = [];
      let out = "";
      for (let i = 0; i < data.length; i++) {
        const c = data[i];
        if (/[\s ​﻿]/.test(c)) {
          if (!endsWithSpace) {
            out += " ";
            map.push(i);
            endsWithSpace = true;
          }
        } else {
          out += c;
          map.push(i);
          endsWithSpace = false;
        }
      }
      if (!out) continue;
      const run: TextRun = { node: n, block, start: total, length: out.length, map: Uint32Array.from(map) };
      this.runs.push(run);
      this.byNode.set(n, run);
      parts.push(out);
      total += out.length;
    }
    this.text = parts.join("");
  }

  /** Blocks in document order: [globalStart, globalEnd) slices of `text`. */
  blocks(): { block: Element; start: number; end: number }[] {
    const out: { block: Element; start: number; end: number }[] = [];
    for (const r of this.runs) {
      const last = out[out.length - 1];
      if (last && last.block === r.block) last.end = r.start + r.length;
      else out.push({ block: r.block, start: r.start, end: r.start + r.length });
    }
    return out;
  }

  find(needle: string, from = 0): number {
    return needle ? this.text.indexOf(needle, from) : -1;
  }

  private runAt(g: number): TextRun | null {
    let lo = 0, hi = this.runs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.runs[mid];
      if (g < r.start) hi = mid - 1;
      else if (g >= r.start + r.length) lo = mid + 1;
      else return r;
    }
    return null;
  }

  /** DOM Range covering normalised [start, end); null if outside any run. */
  rangeFor(start: number, end: number): Range | null {
    // skip separators / spaces at the edges
    while (start < end && (this.text[start] === "\n" || this.text[start] === " ")) start++;
    while (end > start && (this.text[end - 1] === "\n" || this.text[end - 1] === " ")) end--;
    if (start >= end) return null;
    const a = this.runAt(start);
    const b = this.runAt(end - 1);
    if (!a || !b) return null;
    const range = (a.node.ownerDocument ?? document).createRange();
    range.setStart(a.node, a.map[start - a.start]);
    range.setEnd(b.node, b.map[end - 1 - b.start] + 1);
    return range;
  }

  /** Normalised global offset for a DOM boundary point (best effort). */
  offsetFor(node: Node, offset: number, side: "start" | "end"): number {
    if (node.nodeType === Node.TEXT_NODE) {
      const run = this.byNode.get(node as Text);
      if (run) {
        // first normalised index whose original offset >= offset
        let i = 0;
        while (i < run.length && run.map[i] < offset) i++;
        return run.start + i;
      }
    }
    // Element boundary: find the first run at/after (start) or last run before (end) the point.
    const r = (node.ownerDocument ?? document).createRange();
    r.setStart(node, offset);
    r.setEnd(node, offset);
    for (let i = 0; i < this.runs.length; i++) {
      const run = this.runs[i];
      const cmp = r.comparePoint(run.node, 0);
      if (cmp >= 0) return side === "start" ? run.start : run.start;
    }
    return this.text.length;
  }
}
