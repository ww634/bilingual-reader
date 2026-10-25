import { clozeRange } from "./learning-utils.js";
// End-of-chapter quizzes.
//
// Built from the chapter itself — no AI and no network — so they're ready the
// moment a chapter is read, for every book (including practice stories). Each
// level tests the chapter's words AT that level: a Newbie quiz asks about the
// HSK 1 words that appeared, Elementary about the HSK 3 ones, and so on, topped
// up from neighbouring levels when a chapter has too few.
//
// A quiz is seeded by book + chapter + level, so "the Elementary quiz for
// chapter 3" is always the same set of questions, like a stored quiz.
//
// Question types rotate through: meaning (word → English), say it
// (English → word), fill in the sentence (from the chapter), and dictation
// (hear the word, pick it). All multiple choice, with distractors drawn from the
// same chapter, preferring the same part of speech.

import { chunkLevel, NOT_VOCAB, DEFAULT_LEVEL } from "./levels.js";

export const QUIZ_SIZE = 8;
const TYPES = ["t2e", "cloze", "dictation", "e2t"];

// Small deterministic PRNG (mulberry32) + string hash, for stable quizzes.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * The chapter's distinct quiz-worthy words, as vault-style items:
 * { id, hanzi, pinyin, english, lang, category, level, context }.
 */
export function chapterWords(chapter) {
  const lang = chapter?.language || "zh";
  const seen = new Map();
  (chapter?.pairs || []).forEach((pair) => {
    for (const c of pair.alignment || []) {
      const key = (c.hanzi || c.target || "").trim();
      const english = (c.english || "").trim();
      if (!key || seen.has(key) || NOT_VOCAB.has(c.category)) continue;
      if (!english || english.length > 40 || /^[(\[]/.test(english)) continue;   // no gloss / "(grammar)"
      if (!/[\p{L}]/u.test(key)) continue;
      seen.set(key, {
        id: key,
        hanzi: key,
        pinyin: lang === "zh" && c.hanzi ? (c.target || "") : "",
        english,
        lang,
        category: c.category || null,
        frequency_band: c.frequency_band || null,
        level: chunkLevel(c, lang),
        context: { hanzi: pair.hanzi || pair.target || "", target: pair.target || "", english: pair.english || "" },
      });
    }
  });
  return [...seen.values()];
}

/** How many words a chapter has at each level (for the level picker). */
export function wordsPerLevel(chapter) {
  const counts = {};
  for (const w of chapterWords(chapter)) {
    const l = Math.min(w.level, 6);
    counts[l] = (counts[l] || 0) + 1;
  }
  return counts;
}

// Words at `level` first, then the nearest levels (easier before harder).
function pickWords(words, level, size, rand) {
  const atLevel = (l) => shuffled(words.filter((w) => Math.min(w.level, 6) === l), rand);
  let picked = atLevel(level);
  for (let d = 1; picked.length < size && d <= 5; d++) {
    for (const l of [level - d, level + d]) {
      if (l >= 1 && l <= 6 && picked.length < size) picked = picked.concat(atLevel(l).slice(0, size - picked.length));
    }
  }
  return picked.slice(0, size);
}

function distractorsFor(item, words, rand) {
  const others = words.filter((w) => w.id !== item.id && w.english.toLowerCase() !== item.english.toLowerCase());
  const same = shuffled(others.filter((w) => w.category === item.category), rand);
  const rest = shuffled(others.filter((w) => w.category !== item.category), rand);
  return same.concat(rest).slice(0, 3);
}

/**
 * Build the quiz for one chapter at one level.
 * Returns { cards: [{ item, dir, options }], level, available } where `options`
 * are distractor items (the quiz engine renders them in the learner's script).
 */
export function buildChapterQuiz(chapter, level, { bookId = "", size = QUIZ_SIZE } = {}) {
  const words = chapterWords(chapter);
  const rand = rng(hash(`${bookId}/${chapter?.id}/${level}`));
  const picked = pickWords(words, level, size, rand);
  const types = shuffled(TYPES, rand);
  const cards = picked.map((item, i) => {
    let dir = types[i % types.length];
    // Fill-in needs the word to be findable in its sentence in the shown script.
    if (dir === "cloze" && !clozeRange(item.context.hanzi, item.hanzi)) dir = "t2e";
    return { item, dir, options: distractorsFor(item, words, rand) };
  });
  return { cards: words.length >= 4 ? cards : [], level, available: words.length };
}

// ── Per-book quiz preferences (book page toggle + level) ──
// Stored in settings.bookQuiz[bookId] = { on, level }. Default: on, at the
// learner's own level.
export function bookQuizPrefs(settings, bookId) {
  const p = settings?.bookQuiz?.[bookId] || {};
  const myLevel = Math.min(6, Math.max(1, parseInt(settings?.myLevel, 10) || DEFAULT_LEVEL));
  return { on: p.on !== false, level: Math.min(6, Math.max(1, parseInt(p.level, 10) || myLevel)) };
}
