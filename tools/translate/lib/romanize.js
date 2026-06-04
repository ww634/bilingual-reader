// Deterministic Han (Chinese characters) → tone-marked pinyin with proper
// orthographic word spacing.
//
// Two libraries, each doing what it's best at:
//   - pinyin-pro romanizes characters WITH SENTENCE CONTEXT, so polyphones
//     resolve correctly (了 → "le" as an aspect particle, "liǎo" in 了解).
//   - @node-rs/jieba segments the text into WORDS, so we know which syllables
//     to join ("fùqīn", not "fù qīn").
//
// We romanize the whole Han run for context, then group the per-character
// pinyin by jieba's word boundaries. Romanizing each word in isolation would
// LOSE the polyphone context, so we deliberately don't do that.

import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict.js";
import { pinyin } from "pinyin-pro";

const jieba = Jieba.withDict(dict);

// Matches a run of CJK ideographs.
const HAN_RUN = /[㐀-䶿一-鿿]+/;
const HAN_CHAR = /[㐀-䶿一-鿿]/;

/**
 * Romanize one contiguous run of Han characters (no punctuation/Latin inside).
 * Returns space-separated pinyin words.
 */
function romanizeHanRun(han) {
  // Per-character pinyin, resolved in the run's context (polyphone-correct).
  const chars = pinyin(han, { toneType: "symbol", type: "array", nonZh: "consecutive" });
  // Word boundaries from jieba.
  const words = jieba.cut(han);
  const out = [];
  let ci = 0;
  for (const w of words) {
    const n = [...w].length;            // char count of this word
    const syl = chars.slice(ci, ci + n); // its per-char pinyin
    out.push(syl.join(""));              // join syllables → one orthographic word
    ci += n;
  }
  return out.join(" ");
}

// Convert full-width Chinese punctuation to ASCII so the pinyin line reads
// cleanly; drop bracket-style quotes that don't help a pinyin reader.
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
 * Romanize an arbitrary string that may mix Han, Latin (proper nouns kept in
 * the Latin alphabet), and punctuation. Latin and ASCII punctuation pass
 * through; Han runs are segmented + romanized; Chinese punctuation is ASCII-ised.
 */
export function romanize(text) {
  if (!text) return "";
  const runs = text.match(/[㐀-䶿一-鿿]+|[^㐀-䶿一-鿿]+/g) || [];
  const out = [];
  for (const run of runs) {
    out.push(HAN_CHAR.test(run) ? romanizeHanRun(run) : normalizeNonHan(run));
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/** True if the string contains any Han character (for validation/guards). */
export function hasHan(text) {
  return HAN_CHAR.test(String(text || ""));
}
