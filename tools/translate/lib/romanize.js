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

// The upstream lexicon misses the return verb 递还. Reuse the unambiguous
// reading from 归还 rather than hand-authoring syllables in chapter data.
const returnSyllable = pinyin("归还", { type: "array", toneType: "symbol" })[1];
// 系 also defaults to the relationship/system sense in explicit tying phrases.
// Select its other dictionary reading; never store authored pinyin in chapters.
const relationSyllable = pinyin("关系", { type: "array", toneType: "symbol" })[1];
const tieSyllable = pinyin("系", { type: "array", toneType: "symbol", multiple: true })
  .find(syllable => syllable !== relationSyllable);
const tyingWords = new Set(["系鞋带", "系扣子", "系紧", "系牢", "系绳"]);
// Anatomical bending and the back of the hand can be misread across a
// segmentation boundary (手 + 背包). Derive the readings from clear words.
const bendSyllable = pinyin("弯曲", { type: "array", toneType: "symbol" })[1];
const backSyllable = pinyin("背面", { type: "array", toneType: "symbol" })[0];
const againSyllable = pinyin("重新", { type: "array", toneType: "symbol" })[0];
const viscousSyllable = pinyin("粘度", { type: "array", toneType: "symbol" })[0];
const stickSyllable = pinyin("粘", { type: "array", toneType: "symbol", multiple: true })
  .find(syllable => syllable !== viscousSyllable);
const extortSyllable = pinyin("勒索", { type: "array", toneType: "symbol" })[0];
const cinchSyllable = pinyin("勒", { type: "array", toneType: "symbol", multiple: true })
  .find(syllable => syllable !== extortSyllable);
const nailSyllable = pinyin("钉子", { type: "array", toneType: "symbol" })[0];
const fastenSyllable = pinyin("钉", { type: "array", toneType: "symbol", multiple: true })
  .find(syllable => syllable !== nailSyllable);
const transmitSyllable = pinyin("传达", { type: "array", toneType: "symbol" })[0];
const negativeHaveSyllable = pinyin("没有", { type: "array", toneType: "symbol" })[0];
const countSyllable = pinyin("倒数", { type: "array", toneType: "symbol" })[1];
const tradeSyllable = pinyin("行业", { type: "array", toneType: "symbol" })[0];
const giveSyllable = pinyin("给你", { type: "array", toneType: "symbol" })[0];
const carrySyllable = pinyin("担任", { type: "array", toneType: "symbol" })[0];
const swellSyllable = pinyin("胀", { type: "array", toneType: "symbol" })[0];
const fallSyllable = pinyin("跌倒", { type: "array", toneType: "symbol" })[1];
const pourSyllable = pinyin("倒", { type: "array", toneType: "symbol", multiple: true })
  .find(syllable => syllable !== fallSyllable);
const scatterSyllable = pinyin("播撒", { type: "array", toneType: "symbol" })[1];
const aspectSyllable = pinyin("看着", { type: "array", toneType: "symbol" })[1];
const onlySyllable = pinyin("只有", { type: "array", toneType: "symbol" })[0];
const bandageSyllable = pinyin("包扎", { type: "array", toneType: "symbol" })[1];
const claspSyllable = pinyin("夹杂", { type: "array", toneType: "symbol" })[0];

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
      for (const match of run.matchAll(/手背/g)) syllables[match.index + 1] = backSyllable;
      // Elliptical self-tying question; exclude explicit needle/stabbing objects.
      for (const match of run.matchAll(/自己扎的$/g)) syllables[match.index + 2] = bandageSyllable;
      // Avoid a cross-word 外传 reading when the verb is 传来.
      for (const match of run.matchAll(/传来/g)) syllables[match.index] = transmitSyllable;
      // Explicit adverbial contexts, preserving the animal classifier.
      for (const match of run.matchAll(/只(?=擦出|摇头|让|记得|松松地|搁|看见|说|将|捏住|剩|想|把|等|听见|知道)/g)) syllables[match.index] = onlySyllable;
      // Negative 收回去 is not the confiscation verb 没收.
      for (const match of run.matchAll(/没(?=收回去)/g)) syllables[match.index] = negativeHaveSyllable;
      // Disambiguate body swelling, pouring beans, and the beans that spilled.
      for (const match of run.matchAll(/涨(?=得难受)/g)) syllables[match.index] = swellSyllable;
      for (const match of run.matchAll(/倒(?=豆子|沙)/g)) syllables[match.index] = pourSyllable;
      for (const match of run.matchAll(/撒(?=的豆子)/g)) syllables[match.index] = scatterSyllable;
      for (const match of run.matchAll(/(?:扶|顺)着/g)) syllables[match.index + 1] = aspectSyllable;
      // With an aspect marker and quantity, 担 is the verb for carrying.
      for (const match of run.matchAll(/担(?=了(?:满|一|两))/g)) syllables[match.index] = carrySyllable;
      for (const match of run.matchAll(/布(?:还|仍)?扎着/g)) syllables[match.index + match[0].length - 2] = bandageSyllable;
      for (const match of run.matchAll(/数(?=货|的也是|一遍|起)/g)) syllables[match.index] = countSyllable;
      if (run.endsWith("做过这行")) syllables[run.length - 1] = tradeSyllable;
      for (const match of run.matchAll(/给(?=水洇)/g)) syllables[match.index] = giveSyllable;
      const words = jieba.cut(run);
      let ci = 0;          // char index within the run
      let firstWord = true;
      for (const w of words) {
        const wlen = [...w].length;
        if (w === "曲" && run[ci + 1] === "指") syllables[ci] = bendSyllable;
        if (w === "重" && run[ci + 1] === "捆") syllables[ci] = againSyllable;
        if (w === "粘住") syllables[ci] = stickSyllable;
        // A verb before 回, not the nail noun in 铁钉回收/钉子回收.
        if (w === "钉" && run[ci + 1] === "回") syllables[ci] = fastenSyllable;
        if (w === "夹着" || (w === "夹" && run[ci + 1] === "着")) syllables[ci] = claspSyllable;
        // Explicit tightening contexts, without changing 勒索/勒马 readings.
        if ((w === "勒" && run[ci - 1] === "再") ||
            (w === "勒住" && /[线绳带]/.test(run[ci - 1] || ""))) {
          syllables[ci] = cinchSyllable;
        }
        // Respect the segment boundary: 传递还需… contains 传递 + 还, not 递还.
        if (w === "递还" || (w === "递" && srcChars[i + ci + 1] === "还")) {
          syllables[ci + 1] = returnSyllable;
        }
        if (tyingWords.has(w) || (w === "系" && /^(腰|鞋|扣|绳|紧|牢|好|上|住|在|着)/.test(run.slice(ci + 1)))) {
          syllables[ci] = tieSyllable;
        }
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

/**
 * Segment a string into words using the SHARED jieba instance (same dictionary
 * romanization uses). Exposed so the frequency module can band words without
 * loading a second 5 MB copy of the dict.
 */
export function segment(text) {
  return jieba.cut(String(text || ""));
}
