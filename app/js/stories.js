// Practice stories: short stories written on demand by OpenAI for the learner's
// topic, words and level, then turned into a normal chapter so every reader
// feature works on them (tap-to-learn, Listen, highlights, quizzes…).
//
// How a story becomes a chapter:
//   1. The model returns structured JSON: each sentence, its English, and the
//      sentence split into words with an English gloss and part of speech.
//   2. Pinyin is NOT trusted to the model — it's computed here with pinyin-pro
//      (the same library as the translation pipeline) over the whole sentence,
//      so polyphones resolve in context.
//   3. Word levels / frequency bands come from the bundled HSK list.
//   4. The chapter is stored in IndexedDB as part of a local "My practice
//      stories" book (one per language), shown in the Library like any book.
//
// Stories live only on this device (they're included in nothing else). The key
// is the same OpenAI key as the rest of the app.

import {
  getSettings, getBook, putBook, deleteBook, putChapter, deleteChapter, getAllVaultItems,
} from "./db.js";
import { getLearningLanguage, languageName } from "./languages.js";
import { LEVELS, levelName, loadLevels, chunkLevel, bandForLevel, clampLevel, segmentZh } from "./levels.js";
import { bucketOf, isSentence } from "./vault.js";
import { refreshCatalog } from "./library.js";

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STORY_MODEL = "gpt-5.4-mini";
const isNewFamily = (m) => /^gpt-5|^o1|^o3/i.test(m);

export const practiceBookId = (lang) => `practice-${lang}`;
export const isPracticeBook = (id) => String(id || "").startsWith("practice-");

const LENGTHS = { short: [8, 10], medium: [15, 18], long: [25, 30] };
const STYLES = {
  everyday: "a gentle slice-of-life story",
  funny: "a light, funny story with a small surprise at the end",
  mystery: "a small mystery that gets solved by the end",
  adventure: "a short adventure",
  dialogue: "a story told mostly through dialogue between two or three people",
};
const TOPIC_IDEAS = {
  zh: ["Colours", "Food & ordering", "Weather", "Family", "Shopping", "Time & dates", "Animals", "Travel", "Numbers"],
  fr: ["Colours", "Food & café", "Weather", "Family", "Shopping", "Time & dates", "Animals", "Travel", "Numbers"],
};
const CATEGORIES = ["noun", "verb", "adjective", "adverb", "idiom", "proper_noun", "measure_word", "function_word", "particle"];

// Maximum sentence length (Chinese characters) by level — short sentences for beginners.
const MAX_CHARS = { 1: 12, 2: 15, 3: 18, 4: 24, 5: 30, 6: 34 };

// ── Sheet state ──
const S = { words: "none", length: "short", style: "everyday", level: 2, busy: false };

function setStatus(text, cls = "") {
  const el = $("story-status");
  el.textContent = text;
  el.className = `story-status ${cls}`;
  el.hidden = !text;
}

function renderChips(container, options, current, onPick) {
  container.innerHTML = options.map(([v, label]) => `<button class="chip${v === current ? " on" : ""}" data-v="${v}">${escape(label)}</button>`).join("");
  container.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
    onPick(b.dataset.v);
    container.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b));
  }));
}

async function openSheet(preset = {}) {
  const s = await getSettings();
  const lang = getLearningLanguage();
  S.level = clampLevel(s.myLevel);
  if (preset.words) S.words = preset.words;
  $("story-title").textContent = `New ${languageName(lang)} practice story`;
  $("story-key-note").hidden = !!s.openaiKey;
  $("story-topic").value = preset.topic || "";
  $("story-custom").value = "";

  const ideas = $("story-ideas");
  ideas.innerHTML = (TOPIC_IDEAS[lang] || TOPIC_IDEAS.zh).map((t) => `<button class="chip" data-t="${escape(t)}">${escape(t)}</button>`).join("");
  ideas.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => { $("story-topic").value = b.dataset.t; }));

  const items = (await getAllVaultItems()).filter((it) => (it.lang || "zh") === lang && !isSentence(it));
  const learning = items.filter((it) => bucketOf(it) !== "mastered").length;
  renderChips($("story-words"), [
    ["none", "None"],
    ["learning", `My learning words${learning ? ` (${Math.min(learning, 12)})` : ""}`],
    ["custom", "Type my own"],
  ], S.words, (v) => { S.words = v; $("story-custom-wrap").hidden = v !== "custom"; });
  $("story-custom-wrap").hidden = S.words !== "custom";

  const sel = $("story-level");
  sel.innerHTML = LEVELS.map((l) => `<option value="${l.n}">${l.name}</option>`).join("");
  sel.value = String(S.level);
  renderChips($("story-length"), [["short", "Short"], ["medium", "Medium"], ["long", "Long"]], S.length, (v) => { S.length = v; });
  renderChips($("story-style"), [["everyday", "Everyday"], ["funny", "Funny"], ["mystery", "Mystery"], ["adventure", "Adventure"], ["dialogue", "Dialogue"]], S.style, (v) => { S.style = v; });

  setStatus("");
  $("story-generate").disabled = false;
  $("story-backdrop").hidden = false;
  const sheet = $("story-sheet");
  sheet.hidden = false;
  void sheet.offsetHeight;
  sheet.classList.add("open");
}

function closeSheet() {
  if (S.busy) return;   // don't lose a story mid-generation
  const sheet = $("story-sheet");
  sheet.classList.remove("open");
  setTimeout(() => { sheet.hidden = true; $("story-backdrop").hidden = true; }, 240);
}

// ── Prompt ──
function levelGuidance(lang, level) {
  if (lang === "zh") {
    return `Write for a learner at HSK ${level} (${levelName(level)}). Apart from the practice words and simple names, use only vocabulary from HSK levels 1–${level}. Keep every sentence under ${MAX_CHARS[level]} Chinese characters, with simple grammar for that level.`;
  }
  const cefr = ["A1", "A1", "A2", "B1", "B2", "C1"][level - 1];
  return `Write for a learner at CEFR ${cefr} (${levelName(level)}). Apart from the practice words, use vocabulary and grammar suitable for ${cefr}. Keep sentences short and clear.`;
}

function buildMessages({ lang, topic, words, level, length, style }) {
  const lname = languageName(lang);
  const [lo, hi] = LENGTHS[length];
  const sys = [
    `You write short graded-reader stories for an adult learning ${lname}.`,
    levelGuidance(lang, level),
    lang === "zh" ? "Use Simplified Chinese characters only in the story text: no pinyin, no English, no Latin letters. Use Chinese punctuation." : "Write natural, correct French.",
    "Make it a real little story with a beginning, middle and end, not a list of facts.",
    "For every sentence also give a natural English translation that stays close to the original.",
    `Then split the sentence into its words, in order. Every ${lang === "zh" ? "character" : "word"} of the sentence except punctuation must belong to exactly one word, and each word's "w" must be copied EXACTLY from the sentence. Group fixed expressions and names as one word.`,
    "For each word give \"english\": the words it corresponds to in YOUR English translation, copied exactly from it (e.g. \"red\", \"went to\"); for words with no direct English counterpart (particles, aspect markers) give a very short gloss in brackets like \"(done)\".",
    "Give each word's part of speech as one of: " + CATEGORIES.join(", ") + ". Punctuation marks are not words: leave them out of the word list.",
    lang === "zh" ? "" : "Give each word a frequency band: very_common, common, uncommon or rare.",
  ].filter(Boolean).join("\n");
  const usr = [
    `Topic: ${topic || "anything everyday"}.`,
    `Style: ${STYLES[style] || STYLES.everyday}.`,
    `Length: ${lo}–${hi} sentences.`,
    words.length ? `Practice words (use EACH of these at least twice, naturally, in the story): ${words.join("、")}.` : "",
    "Also give the story a short title (with its English).",
  ].filter(Boolean).join("\n");
  return [{ role: "system", content: sys }, { role: "user", content: usr }];
}

function storySchema(lang) {
  const word = {
    type: "object",
    additionalProperties: false,
    properties: {
      w: { type: "string" },
      english: { type: "string" },
      category: { type: "string", enum: CATEGORIES },
      ...(lang === "zh" ? {} : { band: { type: "string", enum: ["very_common", "common", "uncommon", "rare"] } }),
    },
    required: lang === "zh" ? ["w", "english", "category"] : ["w", "english", "category", "band"],
  };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      title_english: { type: "string" },
      sentences: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" }, english: { type: "string" }, words: { type: "array", items: word } },
          required: ["text", "english", "words"],
        },
      },
    },
    required: ["title", "title_english", "sentences"],
  };
}

/** The Chat Completions request body for a story (exported for the test harness). */
export function buildStoryRequest({ lang, topic = "", words = [], level = 2, length = "short", style = "everyday" }) {
  return {
    model: STORY_MODEL,
    messages: buildMessages({ lang, topic, words, level, length, style }),
    response_format: { type: "json_schema", json_schema: { name: "practice_story", strict: true, schema: storySchema(lang) } },
    [isNewFamily(STORY_MODEL) ? "max_completion_tokens" : "max_tokens"]: 16000,
  };
}

async function callModel(body, key) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(res.status === 401 ? "The OpenAI key was rejected. Check it in Settings." : `OpenAI error ${res.status}: ${msg.slice(0, 140)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(data.choices?.[0]?.message?.refusal || "The model returned no story.");
  return JSON.parse(content);
}

// ── Story → chapter ──
let _pinyinLoading = null;
function loadPinyin() {
  if (window.pinyinPro) return Promise.resolve();
  if (_pinyinLoading) return _pinyinLoading;
  _pinyinLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/pinyin-pro.js";
    s.onload = () => resolve();
    s.onerror = () => { _pinyinLoading = null; reject(new Error("Couldn't load the pinyin library.")); };
    document.head.appendChild(s);
  });
  return _pinyinLoading;
}

const HAN = /[㐀-鿿]/;
// Full-width punctuation → the ASCII forms the reader's pinyin lines use.
const PUNCT = { "，": ",", "、": ",", "。": ".", "！": "!", "？": "?", "；": ";", "：": ":", "“": "\"", "”": "\"", "‘": "'", "’": "'", "《": "\"", "》": "\"", "（": "(", "）": ")", "…": "…", "—": "—" };

/** Per-character pinyin for a sentence, in context. */
function sentenceSyllables(text) {
  const all = window.pinyinPro.pinyin(text, { type: "all", toneType: "symbol" });
  return all.map((x) => (x.isZh ? x.pinyin : ""));
}

// Pinyin for a run of characters: one word's syllables joined ("yánsè"); names
// keep a space after the surname ("lǐ míng").
function wordPinyin(chars, sylls, isName) {
  const s = sylls.filter(Boolean);
  if (isName && s.length >= 2) return `${s[0]} ${s.slice(1).join("")}`;
  return s.join("");
}

function nonHanText(str) {
  return [...str].map((c) => PUNCT[c] ?? c).join("");
}

function zhPair(sentence) {
  const text = sentence.text.trim();
  const chars = [...text];
  const sylls = sentenceSyllables(text);
  // Map code-unit offsets to code-point indexes (for slicing syllables).
  const cpAt = [];
  { let cu = 0; chars.forEach((c, i) => { cpAt[cu] = i; cu += c.length; }); cpAt[text.length] = chars.length; }

  const parts = [];        // pinyin pieces, in order
  const alignment = [];
  let cursor = 0;          // code-unit cursor in text
  const emitGap = (from, to) => {
    if (to <= from) return;
    const gap = text.slice(from, to);
    // Uncovered characters still get pinyin; punctuation becomes ASCII.
    let buf = "";
    for (const [k, c] of [...gap].entries()) {
      const ci = cpAt[from] + k;
      if (HAN.test(c)) { if (buf && !buf.endsWith(" ")) buf += " "; buf += sylls[ci] || ""; }
      else buf += nonHanText(c);
    }
    parts.push({ gap: buf });
  };
  for (const w of sentence.words || []) {
    const word = (w.w || "").trim();
    if (!word || !/[\p{L}\p{N}]/u.test(word)) continue;   // punctuation isn't a word
    const at = text.indexOf(word, cursor);
    if (at < 0) continue;                        // model mis-copied a word — leave it uncovered
    emitGap(cursor, at);
    const ci0 = cpAt[at], ci1 = cpAt[at + word.length];
    const py = HAN.test(word) ? wordPinyin(chars.slice(ci0, ci1), sylls.slice(ci0, ci1), w.category === "proper_noun") : nonHanText(word);
    parts.push({ word: py });
    const lvl = chunkLevel({ hanzi: word }, "zh");
    alignment.push({
      english: (w.english || "").trim(),
      target: py,
      hanzi: word,
      category: w.category || "other",
      frequency_band: bandForLevel(lvl),
      is_idiom: w.category === "idiom",
    });
    cursor = at + word.length;
  }
  emitGap(cursor, text.length);

  // Assemble the pinyin line: words separated by spaces, punctuation attached.
  let target = "";
  for (const p of parts) {
    const piece = p.word ?? p.gap;
    if (!piece) continue;
    const startsWithPunct = /^[,.!?;:)"'…]/.test(piece);
    if (target && !target.endsWith(" ") && !startsWithPunct && !target.endsWith("\"") && !target.endsWith("(")) target += " ";
    target += piece;
  }
  target = target.replace(/\s+/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
  return { target, hanzi: text, english: sentence.english.trim(), alignment };
}

function frPair(sentence) {
  const text = sentence.text.trim();
  const alignment = [];
  let cursor = 0;
  for (const w of sentence.words || []) {
    const word = (w.w || "").trim();
    if (!word || !/[\p{L}\p{N}]/u.test(word)) continue;   // punctuation isn't a word
    const at = text.indexOf(word, cursor);
    if (at < 0) continue;
    alignment.push({
      english: (w.english || "").trim(),
      target: word,
      category: w.category || "other",
      frequency_band: w.band || "common",
      is_idiom: w.category === "idiom",
    });
    cursor = at + word.length;
  }
  return { target: text, english: sentence.english.trim(), alignment };
}

function titleFor(story, lang) {
  if (lang !== "zh") return { target: story.title.trim(), english: story.title_english.trim() };
  const hz = story.title.trim();
  // Syllables in context, grouped into words ("yánsè lǎoshī", not "yán sè lǎo shī").
  const sylls = sentenceSyllables(hz);
  let i = 0;
  const target = segmentZh(hz).map((w) => {
    const n = [...w].length;
    const piece = HAN.test(w) ? sylls.slice(i, i + n).join("") : nonHanText(w);
    i += n;
    return piece;
  }).join(" ").replace(/\s+([,.!?;:])/g, "$1").trim();
  return { target, english: story.title_english.trim(), hanzi: hz };
}

export function storyToChapter(story, { lang, bookId, chapterId, level, topic, words }) {
  const pairs = (story.sentences || [])
    .filter((s) => s && s.text && s.text.trim())
    .map((s) => (lang === "zh" ? zhPair(s) : frPair(s)));
  if (pairs.length < 3) throw new Error("The story came back too short. Please try again.");
  return {
    id: chapterId,
    book_id: bookId,
    language: lang,
    version: 1,
    title: titleFor(story, lang),
    pairs,
    meta: { practice: true, topic, words, level, model: STORY_MODEL, created_at: new Date().toISOString() },
  };
}

// ── The practice book ──
function coverSvg(lang) {
  const glyph = lang === "zh" ? "练" : "Aa";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f3a66"/><stop offset="1" stop-color="#3b2a5c"/></linearGradient></defs>
    <rect width="400" height="600" fill="url(#g)"/>
    <circle cx="200" cy="250" r="120" fill="none" stroke="#ffd089" stroke-opacity="0.5" stroke-width="3"/>
    <text x="200" y="${lang === "zh" ? 300 : 285}" font-family="PingFang SC, Hiragino Sans GB, sans-serif" font-size="${lang === "zh" ? 150 : 120}" font-weight="700" fill="#ffd089" text-anchor="middle">${glyph}</text>
    <text x="200" y="470" font-family="-apple-system, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#f0f2f7" text-anchor="middle">Practice</text>
    <text x="200" y="512" font-family="-apple-system, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#f0f2f7" text-anchor="middle">stories</text>
  </svg>`;
  return new Blob([svg], { type: "image/svg+xml" });
}

async function ensureBook(lang) {
  const id = practiceBookId(lang);
  const existing = await getBook(id);
  if (existing) return existing;
  const book = {
    id,
    language: lang,
    version: 1,
    practice: true,
    title: lang === "zh"
      ? { target: "Wǒ de liànxí gùshì", english: "My practice stories", hanzi: "我的练习故事" }
      : { target: "Mes histoires d'entraînement", english: "My practice stories" },
    author: "Written for you",
    synopsis: "Short stories generated for your practice: your topics, your words, your level. They're stored only on this device.",
    genres: ["practice"],
    chapters: [],
    coverBlob: coverSvg(lang),
    addedAt: new Date().toISOString(),
  };
  await putBook(book);
  return book;
}

/** Delete one practice story (and the book once it's empty). */
export async function deletePracticeStory(bookId, chapterId) {
  const book = await getBook(bookId);
  if (!book) return;
  await deleteChapter(bookId, chapterId);
  book.chapters = book.chapters.filter((c) => c.id !== chapterId);
  if (book.chapters.length) await putBook(book);
  else await deleteBook(bookId);
  await refreshCatalog();
}

// ── Generate ──
async function practiceWords(lang) {
  if (S.words === "custom") {
    return $("story-custom").value.split(/[,，、;；\n]+/).map((w) => w.trim()).filter(Boolean).slice(0, 15);
  }
  if (S.words !== "learning") return [];
  const items = (await getAllVaultItems())
    .filter((it) => (it.lang || "zh") === lang && !isSentence(it) && bucketOf(it) !== "mastered")
    .sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
  return items.slice(0, 12).map((it) => it.hanzi);
}

async function generate() {
  if (S.busy) return;
  const s = await getSettings();
  if (!s.openaiKey) { setStatus("Add your OpenAI key in Settings first.", "error"); return; }
  if (!navigator.onLine) { setStatus("You're offline. Stories need an internet connection.", "error"); return; }
  const lang = getLearningLanguage();
  const level = clampLevel($("story-level").value);
  const topic = $("story-topic").value.trim();
  const words = await practiceWords(lang);
  if (S.words === "custom" && !words.length) { setStatus("Type at least one word to practise.", "error"); return; }

  S.busy = true;
  $("story-generate").disabled = true;
  const started = Date.now();
  const tick = setInterval(() => {
    setStatus(`Writing your story… ${Math.round((Date.now() - started) / 1000)}s. Keep the app open; this takes about half a minute.`, "busy");
  }, 1000);
  setStatus("Writing your story…", "busy");
  try {
    const [story] = await Promise.all([
      callModel(buildStoryRequest({ lang, topic, words, level, length: S.length, style: S.style }), s.openaiKey),
      lang === "zh" ? loadPinyin() : Promise.resolve(),
      loadLevels(),
    ]);
    const bookId = practiceBookId(lang);
    const chapterId = `story-${Date.now()}`;
    const chapter = storyToChapter(story, { lang, bookId, chapterId, level, topic, words });
    const book = await ensureBook(lang);
    await putChapter(bookId, chapterId, chapter);
    book.chapters.push({ id: chapterId, version: 1, title: chapter.title, url: null });
    await putBook(book);
    await refreshCatalog();
    clearInterval(tick);
    S.busy = false;
    closeSheet();
    window.dispatchEvent(new CustomEvent("nav:reader", { detail: { bookId, chapterId } }));
  } catch (err) {
    console.warn("Story generation failed:", err);
    clearInterval(tick);
    setStatus(err.message || "Something went wrong. Please try again.", "error");
  } finally {
    clearInterval(tick);
    S.busy = false;
    $("story-generate").disabled = false;
  }
}

export function initStories() {
  $("library-new-story")?.addEventListener("click", () => openSheet());
  $("book-detail-new-story")?.addEventListener("click", () => openSheet());
  $("story-close")?.addEventListener("click", closeSheet);
  $("story-backdrop")?.addEventListener("click", closeSheet);
  $("story-generate")?.addEventListener("click", generate);
  window.addEventListener("stories:new", (e) => openSheet(e.detail || {}));
}
