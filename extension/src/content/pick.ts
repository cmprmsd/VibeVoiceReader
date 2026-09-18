/**
 * "Read from here": let the user click a block on the page.  Used when the
 * automatic article detection picks the wrong thing (app-like pages, chats).
 */
const BLOCKISH = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, dd, dt, td, th, figcaption, article, section, div, main";

export function pickBlock(onPick: (el: Element | null) => void): () => void {
  const outline = document.createElement("div");
  outline.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #4f46e5;background:rgba(79,70,229,.08);border-radius:4px;transition:all .05s;display:none";
  document.documentElement.append(outline);
  let current: Element | null = null;

  const candidate = (target: Element | null): Element | null => {
    let el: Element | null = target?.closest(BLOCKISH) ?? null;
    // climb until the block has some text of its own
    while (el && el !== document.body && ((el.textContent ?? "").trim().length < 20 || el.id === "vibevoice-reader-host")) el = el.parentElement?.closest(BLOCKISH) ?? null;
    return el && el !== document.body ? el : null;
  };
  const move = (e: MouseEvent) => {
    const el = candidate(e.target as Element);
    current = el;
    if (!el) {
      outline.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    outline.style.display = "block";
    outline.style.left = `${r.left - 2}px`;
    outline.style.top = `${r.top - 2}px`;
    outline.style.width = `${r.width}px`;
    outline.style.height = `${r.height}px`;
  };
  const click = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    cleanup();
    onPick(current);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      cleanup();
      onPick(null);
    }
  };
  const cleanup = () => {
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("click", click, true);
    document.removeEventListener("keydown", key, true);
    outline.remove();
    document.documentElement.style.cursor = "";
  };
  document.addEventListener("mousemove", move, true);
  document.addEventListener("click", click, true);
  document.addEventListener("keydown", key, true);
  document.documentElement.style.cursor = "crosshair";
  return cleanup;
}
