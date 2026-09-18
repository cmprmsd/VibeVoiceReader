/** Sentence highlighting via the CSS Custom Highlight API, with a <mark> fallback. */

const STYLE_ID = "vibevoice-reader-highlight-style";
const NAME = "vibevoice-sentence";

export class Highlighter {
  private supported = typeof CSS !== "undefined" && "highlights" in CSS && typeof (globalThis as any).Highlight === "function";
  private mark: HTMLElement | null = null;
  private color = "rgba(99, 102, 241, 0.28)";

  constructor() {
    this.injectStyle();
  }

  setColor(css: string): void {
    this.color = css;
    this.injectStyle(true);
  }

  private injectStyle(replace = false): void {
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (style && !replace) return;
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.append(style);
    }
    style.textContent = `::highlight(${NAME}) { background-color: ${this.color}; }
mark.vibevoice-mark { background-color: ${this.color}; color: inherit; }`;
  }

  set(range: Range | null): void {
    this.clear();
    if (!range) return;
    if (this.supported) {
      const H = (globalThis as any).Highlight as { new (...r: Range[]): unknown };
      (CSS as any).highlights.set(NAME, new H(range));
      return;
    }
    // Fallback: only when the range lives in a single text node.
    if (range.startContainer === range.endContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
      const mark = document.createElement("mark");
      mark.className = "vibevoice-mark";
      try {
        range.surroundContents(mark);
        this.mark = mark;
      } catch {
        /* ignore */
      }
    }
  }

  clear(): void {
    if (this.supported) (CSS as any).highlights.delete(NAME);
    if (this.mark) {
      const parent = this.mark.parentNode;
      if (parent) {
        while (this.mark.firstChild) parent.insertBefore(this.mark.firstChild, this.mark);
        parent.removeChild(this.mark);
        parent.normalize();
      }
      this.mark = null;
    }
  }

  /** Scroll so the range is comfortably visible (only if it is off-screen). */
  reveal(range: Range): void {
    const r = range.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    const margin = 120;
    if (r.top >= margin && r.bottom <= window.innerHeight - margin) return;
    window.scrollBy({ top: r.top - window.innerHeight * 0.35, behavior: "smooth" });
  }

  destroy(): void {
    this.clear();
    document.getElementById(STYLE_ID)?.remove();
  }
}
