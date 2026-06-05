// Deterministic Han (Chinese characters) → tone-marked pinyin with proper
// orthographic word spacing.
//
// Two libraries, each doing what it's best at:
//   - pinyin-pro romanizes characters WITH SENTENCE CONTEXT, so polyphones
//     resolve correctly (了 → "le" as an aspect particle, "liǎo" in 了解).
//   - @node-rs/jieba segments the text into WORDS, so we know which syllables
//     to join ("fùqīn", not "fù qīn").
//
// romanizeWithMap() is the core: it romanizes the whole string in context AND
// returns, per source character, the [start,end) span its pinyin occupies in
// the output. That lets the aligner SLICE a chunk's pinyin straight out of the
// pair's pinyin (instead of romanizing the chunk in isolation, which would
// lose polyphone context — e.g. an isolated 了 → "liǎo"). Sliced chunk pinyin
// is therefore always an exact substring of the pair pinyin.

import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict.js";
import { pinyin } from "pinyin-pro";

const jieba = Jieba.withDict(dict);

const HAN_CHAR = /[㐀-䶿一-鿿]/;

// Convert full-width Chinese punctuation to ASCII; drop bracket-style quotes.
function normalizeNonHan(s) {
  return s
    .replace(/[，、]/g, ", ")
    .replace(/。/g, ". ")
    .replace(/！/g, "! ")
    .replace(/？/g, "? ")
    .replace(/；/g, "; ")
    .replace(/：/g, ": ")
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[《》【】「」（）]/g, " ");
}

/**
 * Romanize a string (Han + Latin + punctuation), returning:
 *   pinyin — the full tone-marked, word-spaced pinyin string
 *   spans  — array indexed by SOURCE code-point; spans[i] = [start,end) of that
 *            character's pinyin within `pinyin` (null if it produced nothing)
 *   srcChars — the source split into code points (so callers can map offsets)
 */
export function romanizeWithMap(text) {
  const srcChars = [...String(text || "")];
  const spans = new Array(srcChars.length).fill(null);
  let out = "";
  const sep = () => { if (out && !out.endsWith(" ")) out += " "; };

  let i = 0;
  while (i < srcChars.length) {
    if (HAN_CHAR.test(srcChars[i])) {
      // Gather the contiguous Han run.
      let j = i;
      while (j < srcChars.length && HAN_CHAR.test(srcChars[j])) j++;
      const run = srcChars.slice(i, j).join("");
      const syllables = pinyin(run, { toneType: "symbol", type: "array", nonZh: "consecutive" });
      const words = jieba.cut(run);
      let ci = 0;          // char index within the run
      let firstWord = true;
      for (const w of words) {
        const wlen = [...w].length;
        if (!firstWord) sep();           // space between words
        else { sep(); }                  // and space before the run if needed
        firstWord = false;
        for (let k = 0; k < wlen; k++) {
          const start = out.length;
          out += syllables[ci] ?? "";
          spans[i + ci] = [start, out.length];
          ci++;
        }
      }
      i = j;
    } else {
      // Non-Han run: normalize, emit as one unit.
      let j = i;
      while (j < srcChars.length && !HAN_CHAR.test(srcChars[j])) j++;
      const run = srcChars.slice(i, j).join("");
      const norm = normalizeNonHan(run).replace(/\s+/g, " ").trim();
      if (norm) {
        sep();
        const start = out.length;
        out += norm;
        const end = out.length;
        for (let k = i; k < j; k++) spans[k] = [start, end];
      }
      i = j;
    }
  }
  return { pinyin: out, spans, srcChars };
}

/** Plain romanization (no map). Identical output to romanizeWithMap().pinyin. */
export function romanize(text) {
  return romanizeWithMap(text).pinyin;
}

/**
 * Given a pair's Hanzi and the result of romanizeWithMap(pairHanzi), return the
 * context-correct pinyin for a chunk (a Hanzi substring of the pair) by slicing
 * the pair's pinyin. Falls back to isolated romanization if the chunk can't be
 * located (e.g. duplicate handling edge cases).
 */
export function chunkPinyinFromPair(pairHanzi, chunkHanzi, map) {
  const chunk = (chunkHanzi || "").trim();
  if (!chunk) return "";
  const utf16Idx = pairHanzi.indexOf(chunk);
  if (utf16Idx === -1) return romanize(chunk);
  const cpStart = [...pairHanzi.slice(0, utf16Idx)].length;
  const cpLen = [...chunk].length;
  const startSpan = map.spans[cpStart];
  const endSpan = map.spans[cpStart + cpLen - 1];
  if (!startSpan || !endSpan) return romanize(chunk);
  return map.pinyin.slice(startSpan[0], endSpan[1]).trim();
}

/** True if the string contains any Han character (for validation/guards). */
export function hasHan(text) {
  return HAN_CHAR.test(String(text || ""));
}
