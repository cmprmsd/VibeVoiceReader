/** Sentence segmentation, TTS text clean-up and chunk building. */
import type { Paragraph } from "./extract";

export interface Sentence {
  id: number;
  /** index into the paragraphs array */
  para: number;
  /** [start, end) within the paragraph's normalised text */
  start: number;
  end: number;
  /** original text */
  text: string;
  /** text sent to the model */
  tts: string;
  range: Range | null;
}

export type ChunkMode = "sentence" | "paragraph" | "auto";

export interface Chunk {
  id: number;
  text: string;
  sentences: Sentence[];
  /** char offset of each sentence inside `text` */
  offsets: number[];
}

const MIN_WORDS = 4;
const MAX_SENTENCE_CHARS = 400;

export function cleanForTts(s: string): string {
  return s
    .replace(/https?:\/\/\S+|www\.\S+/gi, "")
    .replace(/\[(?:\d+(?:[,–-]\d+)*|[a-z][^\]]{0,40})\]/gi, "") // [12], [citation needed], [a]
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, ", ")
    .replace(/[•·●▪◦]/g, " ")
    .replace(/[\p{Extended_Pictographic}️]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function segmenter(lang: string): { segment: (s: string) => { index: number; segment: string }[] } {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter(lang || undefined, { granularity: "sentence" });
    return { segment: (s) => Array.from(seg.segment(s)).map((x) => ({ index: x.index, segment: x.segment })) };
  }
  return {
    segment: (s) => {
      const out: { index: number; segment: string }[] = [];
      const re = /[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) out.push({ index: m.index, segment: m[0] });
      return out;
    },
  };
}

/** Split an over-long sentence at clause punctuation or spaces. */
function splitLong(text: string, base: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let s = 0;
  while (text.length - s > MAX_SENTENCE_CHARS) {
    const window = text.slice(s, s + MAX_SENTENCE_CHARS);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
    if (cut < MAX_SENTENCE_CHARS / 3) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = MAX_SENTENCE_CHARS;
    else cut += 1;
    out.push({ start: base + s, end: base + s + cut });
    s += cut;
  }
  out.push({ start: base + s, end: base + text.length });
  return out;
}

export function splitSentences(paragraphs: Paragraph[], lang: string): Sentence[] {
  const seg = segmenter(lang);
  const out: Sentence[] = [];
  let id = 0;
  paragraphs.forEach((p, pi) => {
    const pieces: { start: number; end: number }[] = [];
    // Blank out bracketed citations (length-preserving) so "clarity.[3] For" splits.
    const segText = p.text.replace(/\[[^\]]{1,40}\]/g, (m) => " ".repeat(m.length));
    for (const s of seg.segment(segText)) {
      const raw = s.segment;
      const lead = raw.length - raw.trimStart().length;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const start = s.index + lead;
      const end = start + trimmed.length;
      if (trimmed.length > MAX_SENTENCE_CHARS) pieces.push(...splitLong(trimmed, start));
      else pieces.push({ start, end });
    }
    // Citation markers such as "[12]" confuse the segmenter: keep them with the
    // sentence they follow instead of starting the next one.
    for (const piece of pieces) {
      let m: RegExpExecArray | null;
      while ((m = /^(\[\d+(?:[,–-]\d+)*\]|\d+(?:[,–-]\d+)*\])\s*/.exec(p.text.slice(piece.start, piece.end)))) piece.start += m[0].length;
      while (/\[\s*$/.test(p.text.slice(piece.start, piece.end))) piece.end = p.text.lastIndexOf("[", piece.end - 1);
      while (piece.end > piece.start && p.text[piece.end - 1] === " ") piece.end--;
    }
    // merge tiny fragments into their predecessor (or successor)
    const merged: { start: number; end: number }[] = [];
    for (const piece of pieces) {
      if (piece.end <= piece.start) continue;
      const text = p.text.slice(piece.start, piece.end);
      const prev = merged[merged.length - 1];
      if (prev && (wordCount(text) < MIN_WORDS || wordCount(p.text.slice(prev.start, prev.end)) < MIN_WORDS)) prev.end = piece.end;
      else merged.push({ ...piece });
    }
    for (const m of merged) {
      const text = p.text.slice(m.start, m.end);
      let tts = cleanForTts(text);
      if (!tts || !/[\p{L}\p{N}]/u.test(tts)) continue;
      if (p.kind === "heading" && !/[.!?:]$/.test(tts)) tts += ".";
      out.push({ id: id++, para: pi, start: m.start, end: m.end, text, tts, range: p.locate(m.start, m.end) });
    }
  });
  return out;
}

export function buildChunks(sentences: Sentence[], mode: ChunkMode, maxChars = 1200): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  const flush = () => {
    if (cur) chunks.push(cur);
    cur = null;
  };
  // Short headings are unstable on their own: chunk them with the paragraph that follows.
  const groupOf = new Map<Sentence, number>();
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const next = sentences[i + 1];
    const isHeading = s.tts.split(/\s+/).length < 6 && next && next.para !== s.para && !sentences.some((o) => o !== s && o.para === s.para);
    groupOf.set(s, isHeading && mode !== "sentence" ? next.para : s.para);
  }
  const byPara = new Map<number, number>();
  for (const s of sentences) byPara.set(groupOf.get(s)!, (byPara.get(groupOf.get(s)!) ?? 0) + 1);

  for (const s of sentences) {
    const g = groupOf.get(s)!;
    const paragraphMode = mode === "paragraph" || (mode === "auto" && (byPara.get(g) ?? 0) >= 2);
    const canAppend =
      cur && paragraphMode && groupOf.get(cur.sentences[0]) === g && cur.text.length + 1 + s.tts.length <= maxChars;
    if (!canAppend) {
      flush();
      cur = { id: chunks.length, text: s.tts, sentences: [s], offsets: [0] };
      continue;
    }
    cur!.offsets.push(cur!.text.length + 1);
    cur!.text += " " + s.tts;
    cur!.sentences.push(s);
  }
  flush();
  return chunks;
}
