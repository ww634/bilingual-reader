// Build app/data/zh-levels.tsv — a level (1–6) for ~30k Chinese words, used by
// the app for chapter-quiz difficulty, "how much of this chapter you already
// know", and practice-story levels.
//
//   1–6  = HSK 2.0 level (hsk2.tsv: the official HSK 2.0 word lists, levels 1–6,
//          as published in the `@leonsilicon/hsk2.0` npm package; patterns like
//          不但……而且…… are split into their words).
//   Words outside HSK (from the top 30,000 of the jieba dictionary that ships
//   with @node-rs/jieba in tools/translate — the pipeline's frequency source)
//   get the easier of: a frequency level (top 2,000 → 4, top 6,000 → 5, else 6)
//   and a character-based level (see below). Unlisted words are "beyond" (7).
//
// Run from the repo root:  node tools/wordfreq/build-zh-levels.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../translate/package.json", import.meta.url));
const { dict } = require("@node-rs/jieba/dict.js");

const TOP_N = 30000;
const HAN_ONLY = /^[㐀-鿿]+$/;

const levels = new Map();
for (const line of readFileSync(new URL("./hsk2.tsv", import.meta.url), "utf8").split("\n")) {
  const [word, lvl] = line.split("\t");
  if (!word || !lvl) continue;
  // Some HSK entries list variants ("那（那儿）") — keep the plain headword(s).
  for (const w of word.split(/[（）()|｜/]/)) {
    const clean = w.trim();
    if (HAN_ONLY.test(clean) && !levels.has(clean)) levels.set(clean, parseInt(lvl, 10));
  }
}
const hskCount = levels.size;

const rows = [];
for (const line of dict.toString("utf8").split("\n")) {
  const [word, freqStr] = line.split(" ");
  const freq = parseInt(freqStr, 10);
  if (word && HAN_ONLY.test(word) && Number.isFinite(freq)) rows.push([word, freq]);
}
rows.sort((a, b) => b[1] - a[1]);
// A character's level = the earliest HSK level of any word containing it
// (色 is level 2 because 颜色 is). Used for non-HSK words that can't be split
// into HSK words: placed one level above their hardest character (红色 → 3),
// unless their frequency already says they're easier.
const charLevel = new Map();
for (const [w, l] of levels) {
  for (const ch of w) if (!charLevel.has(ch) || l < charLevel.get(ch)) charLevel.set(ch, l);
}
// Split a word into HSK words, longest first (放进 → 放 + 进). Returns the part
// levels, or null if some part isn't an HSK word.
const hsk = new Map(levels);
function hskParts(word) {
  const chars = [...word];
  const out = [];
  for (let i = 0; i < chars.length;) {
    let len = Math.min(4, chars.length - i);
    for (; len >= 1; len--) {
      const part = chars.slice(i, i + len).join("");
      if (len < chars.length && hsk.has(part)) { out.push(hsk.get(part)); break; }
    }
    if (!len) return null;
    i += len;
  }
  return out.length >= 2 ? out : null;
}

rows.slice(0, TOP_N).forEach(([word], i) => {
  if (levels.has(word)) return;
  const byRank = i < 2000 ? 4 : i < 6000 ? 5 : 6;
  // Made of HSK words (verb + complement, number + measure word…): as hard as
  // its hardest part. Otherwise made of known characters: one level above them.
  const parts = hskParts(word);
  const chars = [...word];
  const byParts = parts ? Math.max(...parts)
    : chars.every((c) => charLevel.has(c))
      ? Math.min(6, Math.max(...chars.map((c) => charLevel.get(c))) + (chars.length > 1 ? 1 : 0))
      : 7;
  levels.set(word, Math.min(byRank, byParts));
});

const out = [...levels].map(([w, l]) => `${w}\t${l}`).join("\n") + "\n";
writeFileSync(new URL("../../app/data/zh-levels.tsv", import.meta.url), out);
console.log(`Wrote ${levels.size} words (${hskCount} from HSK) to app/data/zh-levels.tsv`);
console.log("Samples:", ["我", "的", "颜色", "红色", "门", "螺丝", "卷帘门", "父亲", "零件", "白色", "大意", "茶叶", "上", "从", "后面", "往", "一半", "放进", "拆下", "一枚"].map((w) => `${w}=${levels.get(w) ?? "beyond"}`).join(" "));
