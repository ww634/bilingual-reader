import { vocabularyKey, vocabularyUnits } from "./learning-utils.js";
// Learner levels and word difficulty.
//
// Six levels, named for the learner but anchored to HSK 2.0 for Chinese
// (Newbie = HSK 1 … Advanced = HSK 6). Every Chinese word gets a level 1–7 from
// data/zh-levels.tsv (7 = beyond HSK 6); multi-word chunks take their hardest
// part. Other languages (French) have no HSK, so their level is approximated
// from the chapter's frequency band.
//
// Used by: end-of-chapter quizzes (which words a level tests), "how much of this
// chapter you already know", and practice-story difficulty.

export const LEVELS = [
  { n: 1, id: "newbie", name: "Newbie", zh: "HSK 1 · the first 150 words", other: "the most basic words" },
  { n: 2, id: "beginner", name: "Beginner", zh: "HSK 2 · about 300 words", other: "very common words" },
  { n: 3, id: "elementary", name: "Elementary", zh: "HSK 3 · about 600 words", other: "common everyday words" },
  { n: 4, id: "intermediate", name: "Intermediate", zh: "HSK 4 · about 1,200 words", other: "a wider everyday vocabulary" },
  { n: 5, id: "upper", name: "Upper-intermediate", zh: "HSK 5 · about 2,500 words", other: "less common words" },
  { n: 6, id: "advanced", name: "Advanced", zh: "HSK 6 · about 5,000 words", other: "rare words and idioms" },
];
export const DEFAULT_LEVEL = 2;
export const levelInfo = (n) => LEVELS.find((l) => l.n === n) || LEVELS[DEFAULT_LEVEL - 1];
export const levelName = (n) => levelInfo(n).name;
export const levelHint = (n, lang) => (lang === "zh" ? levelInfo(n).zh : levelInfo(n).other);

// ── Chinese word levels ──
const HAN = /[㐀-鿿]/;
let _words = null;       // word -> level
let _chars = null;       // char -> easiest level of a word containing it
let _loading = null;

/** Load data/zh-levels.tsv once. Safe to call repeatedly; resolves when ready. */
export function loadLevels() {
  if (_words) return Promise.resolve();
  if (_loading) return _loading;
  _loading = fetch("data/zh-levels.tsv")
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((text) => {
      const words = new Map();
      const chars = new Map();
      for (const line of text.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab < 1) continue;
        const w = line.slice(0, tab);
        const l = +line.slice(tab + 1);
        words.set(w, l);
        for (const c of w) if (!chars.has(c) || l < chars.get(c)) chars.set(c, l);
      }
      _words = words;
      _chars = chars;
    })
    .catch((err) => { console.warn("Word levels unavailable:", err.message); _loading = null; });
  return _loading;
}
export const levelsReady = () => !!_words;

// Split an unlisted Chinese string (e.g. a multi-word chunk like 抬到一半) into
// listed words, longest match first; it's as hard as its hardest part.
function zhLevel(word) {
  const w = String(word || "").trim();
  if (!w) return null;
  if (!HAN.test(w)) return 1;                 // digits / Latin inside a chunk
  if (_words.has(w)) return _words.get(w);
  const chars = [...w].filter((c) => HAN.test(c));
  let max = 0;
  for (let i = 0; i < chars.length;) {
    let matched = 0;
    for (let len = Math.min(4, chars.length - i); len >= 1; len--) {
      const part = chars.slice(i, i + len).join("");
      if (_words.has(part)) { max = Math.max(max, _words.get(part)); matched = len; break; }
    }
    if (!matched) { max = Math.max(max, _chars.get(chars[i]) ? Math.min(7, _chars.get(chars[i]) + 1) : 7); matched = 1; }
    i += matched;
  }
  return max || 7;
}

/**
 * Split Chinese text into words using the level list (longest match, up to 4
 * characters); non-Han runs stay as single pieces. Needs loadLevels() first.
 */
export function segmentZh(text) {
  const chars = [...String(text || "")];
  const out = [];
  for (let i = 0; i < chars.length;) {
    if (!HAN.test(chars[i])) {
      let j = i + 1;
      while (j < chars.length && !HAN.test(chars[j])) j++;
      out.push(chars.slice(i, j).join(""));
      i = j;
      continue;
    }
    let len = 1;
    for (let l = Math.min(4, chars.length - i); l > 1; l--) {
      const part = chars.slice(i, i + l).join("");
      if (HAN.test(part) && _words?.has(part)) { len = l; break; }
    }
    out.push(chars.slice(i, i + len).join(""));
    i += len;
  }
  return out;
}

const BAND_LEVEL = { very_common: 2, common: 3, uncommon: 5, rare: 6 };

/**
 * Level 1–7 of an alignment chunk (or any {hanzi, target, frequency_band}).
 * Chinese uses the HSK list when loaded; otherwise (or for other languages)
 * the frequency band.
 */
export function chunkLevel(chunk, lang = "zh") {
  if (lang === "zh" && _words && chunk?.hanzi) return zhLevel(chunk.hanzi);
  return BAND_LEVEL[chunk?.frequency_band] || 3;
}

/** Frequency band for a level (for generated content). */
export function bandForLevel(level) {
  return level <= 3 ? "very_common" : level === 4 ? "common" : level <= 6 ? "uncommon" : "rare";
}

// Categories that aren't vocabulary to know or test (names, grammar markers).
export const NOT_VOCAB = new Set(["proper_noun", "particle", "grammar"]);
const wordKey = (c, lang) => vocabularyKey(c.hanzi || c.target, lang);

/**
 * How much of a chapter the learner already knows, counting every word
 * occurrence (names excluded). A word counts as known when it's mastered in the
 * Memory Vault, or when it's at or below the learner's level and NOT sitting in
 * the vault as new/learning (saving a word says "I don't know this yet").
 *
 * `vaultBuckets`: Map word -> "new" | "learning" | "mastered".
 * Returns { pct, total, known, newWords: [{ key, chunk, level }] } (unique unknowns).
 */
export function chapterKnowledge(chapter, level, vaultBuckets = new Map()) {
  const lang = chapter?.language || "zh";
  let total = 0, known = 0;
  const unknown = new Map();
  for (const pair of chapter?.pairs || []) {
    for (const c of (pair.alignment || []).flatMap(vocabularyUnits)) {
      if (c.category === "proper_noun") continue;
      const key = wordKey(c, lang);
      if (!key || !/[\p{L}]/u.test(key)) continue;
      total++;
      const bucket = vaultBuckets.get(key);
      const lvl = chunkLevel(c, lang);
      const isKnown = bucket ? bucket === "mastered" : lvl <= level;
      if (isKnown) known++;
      else if (!unknown.has(key)) unknown.set(key, { key, chunk: c, level: lvl });
    }
  }
  return { pct: total ? Math.round((known / total) * 100) : 100, total, known, newWords: [...unknown.values()] };
}

// ── Per-learner level setting helpers ──
export function clampLevel(n) {
  const v = parseInt(n, 10);
  return Number.isFinite(v) ? Math.min(6, Math.max(1, v)) : DEFAULT_LEVEL;
}

export const learnerLevel = (settings, language = settings?.learningLanguage || "zh") => clampLevel(typeof settings?.myLevel === "object" ? settings.myLevel[language] : settings?.myLevel);
