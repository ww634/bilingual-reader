// Deterministic frequency banding for alignment chunks.
//
// The band answers "how common is this word in GENERAL Chinese" — the signal a
// learner needs to decide whether a word is worth memorising — NOT how common
// it is inside one particular book. We derive it from the frequency column of
// the jieba dictionary that already ships with @node-rs/jieba (MIT), so there
// is nothing to download and the vocabulary coverage is ~349k words. The
// absolute counts are corpus term-frequencies; their RELATIVE ordering is a
// good commonness proxy (是 796991 … 我 328841 … 量子 617 … 骈文 98).
//
// Bands map onto the reader's existing four labels: very_common / common /
// uncommon / rare. A multi-word chunk is banded by its RAREST constituent — a
// phrase is only as easy as its hardest word.

import { dict } from "@node-rs/jieba/dict.js";
import { segment, hasHan } from "./romanize.js";

// ── Parse "word freq pos" once into word → freq ──
const FREQ = new Map();
{
  const text = dict.toString("utf8");
  for (const line of text.split("\n")) {
    const a = line.indexOf(" ");
    if (a === -1) continue;
    const word = line.slice(0, a);
    const rest = line.slice(a + 1);
    const b = rest.indexOf(" ");
    const freq = parseInt(b === -1 ? rest : rest.slice(0, b), 10);
    if (word && Number.isFinite(freq)) FREQ.set(word, freq);
  }
}

// ── Rank-based thresholds ──
// Sort frequencies descending and read the value at fixed ranks, so the
// cut-offs are principled ("top ~1.5k words are very_common") rather than
// magic absolute numbers. Computed once at load.
const _sorted = [...FREQ.values()].sort((x, y) => y - x);
const _at = (rank) => _sorted[Math.min(rank, _sorted.length - 1)] ?? 0;
export const THRESHOLDS = {
  very_common: _at(1500),   // top ~1,500 words — everyday core
  common: _at(6000),        // next tier — roughly HSK-core breadth
  uncommon: _at(25000),     // mid tail
  // everything rarer → "rare"
};

const ORDER = { very_common: 0, common: 1, uncommon: 2, rare: 3 };

/** Band a single word by its dictionary frequency. null = not in the dict. */
export function bandForWord(word) {
  const f = FREQ.get(word);
  if (f === undefined) return null;
  if (f >= THRESHOLDS.very_common) return "very_common";
  if (f >= THRESHOLDS.common) return "common";
  if (f >= THRESHOLDS.uncommon) return "uncommon";
  return "rare";
}

// Chinese numerals + the units they combine with. A token made only of these
// is a number (两百, 五十, 三千) — foundational vocabulary — regardless of the
// low corpus frequency its specific spelling happens to have.
const NUMERAL = new Set([..."零一二两三四五六七八九十百千万亿〇壹贰叁肆伍陆柒捌玖拾佰仟"]);
function isNumber(word) {
  const chars = [...word].filter(hasHan);
  return chars.length > 0 && chars.every((c) => NUMERAL.has(c));
}

// Band one token, falling back to characters when the whole token isn't a
// dictionary word. jieba keeps some compounds whole that aren't dict entries;
// without this they'd wrongly read as rare even though their characters are
// common. Band such tokens by their rarest character. A genuinely unknown
// single character stays rare.
function bandForToken(word) {
  if (isNumber(word)) return "very_common";
  const direct = bandForWord(word);
  if (direct) return direct;
  const chars = [...word].filter(hasHan);
  if (chars.length <= 1) return "rare";
  let worst = null;
  for (const ch of chars) {
    const b = bandForWord(ch) || "rare";
    if (worst === null || ORDER[b] > ORDER[worst]) worst = b;
  }
  return worst;
}

/**
 * Band a chunk of Hanzi. Segments into words (shared jieba), looks each up, and
 * returns the RAREST constituent's band. Pure-punctuation / Latin chunks → null
 * (no Chinese word to learn). Han words absent from the dict (coined names,
 * unusual compounds) count as "rare" — which is correct: they ARE rare in
 * general Chinese, and the reader surfaces them by in-book recurrence anyway.
 */
export function bandForChunk(hanzi) {
  const s = String(hanzi || "").trim();
  if (!s || !hasHan(s)) return null;
  let worst = null;
  for (const w of segment(s)) {
    if (!hasHan(w)) continue; // skip punctuation / latin inside the chunk
    const band = bandForToken(w);
    if (worst === null || ORDER[band] > ORDER[worst]) worst = band;
  }
  return worst;
}

/**
 * Overwrite every alignment chunk's frequency_band deterministically, in place.
 * Proper nouns and idioms keep null (matches the reader's existing convention:
 * they aren't dictionary vocabulary a learner banks by frequency).
 */
export function applyFrequencyBands(pairs) {
  for (const p of pairs || []) {
    for (const c of p.alignment || []) {
      if (c.category === "proper_noun" || c.category === "idiom" || c.is_idiom) {
        c.frequency_band = null;
      } else {
        c.frequency_band = bandForChunk(c.hanzi);
      }
    }
  }
  return pairs;
}
