import { normalizePinyin, normalizedWords, englishAnswer, clozeRange, vocabularyKey, vocabularyUnits, distinctOptions, sentenceAnswer } from "./learning-utils.js";
// Memory Vault: save words from the reader and quiz them.
//
// Mastery is a rolling accuracy: each word keeps its last WINDOW (20) attempts,
// and the score is (correct in that window) / WINDOW — with unseen slots
// counting as 0, so a new word is 0/20 and one correct answer is 1/20 = 5%.
// Buckets by score: New 0-25%, Learning 26-90%, Mastered 91-100%. Mastered words
// have their English faded in the reader (see reader.js).
//
// Quizzing: the user picks answer mode, direction, which buckets to include, and
// a length (10/20/30, all-once, or endless). Words are chosen by a weighted
// draw that favours low-mastery and recently-wrong words, so it adapts. All
// local; review audio + meaning lookups reuse the existing helpers.

import { getSettings, updateSettings, bumpActivity, putVaultItem, updateVaultItem, getVaultItem, getAllVaultItems, deleteVaultItem } from "./db.js";
import { speakWord, unlockAudio } from "./speech.js";
import { getLearningLanguage, languageName } from "./languages.js";
import { openWriter } from "./write.js";

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

// ── Mastery model ──
const WINDOW = 20;                 // rolling window size / fixed denominator
const MEANING_MODEL = "gpt-5.4-nano";

function attemptsOf(item) {
  if (Array.isArray(item?.attempts)) return item.attempts;
  // Migrate words saved under the old Leitner-box model: approximate their
  // mastery as a number of correct answers out of the 20-slot window, so prior
  // progress (and the reader's auto-hide) carries over. Persisted on next answer.
  const box = item?.srs?.box;
  if (Number.isFinite(box)) {
    const CORRECT_BY_BOX = [0, 3, 7, 12, 16, 19, 20];
    return Array(CORRECT_BY_BOX[Math.min(Math.max(box, 0), 6)] || 0).fill(true);
  }
  return [];
}
function masteryPct(item) {
  const a = attemptsOf(item);
  const correct = a.reduce((n, x) => n + (x ? 1 : 0), 0);
  return Math.round((correct / WINDOW) * 100);
}
export function bucketOf(item) {
  const p = masteryPct(item);
  if (p <= 25) return "new";
  if (p <= 90) return "learning";
  return "mastered";
}
export const isMastered = (item) => bucketOf(item) === "mastered";
export const isSentence = (item) => item?.kind === "sentence";
function recordAttempt(item, correct) {
  const a = attemptsOf(item).slice();
  a.push(!!correct);
  while (a.length > WINDOW) a.shift();
  item.attempts = a;
  item.lastSeen = Date.now();
  return item;
}

// ── Due for review ──
// A light spacing rule on top of the accuracy model: a word comes back after a
// rest that grows with mastery, and sooner if the last answer was wrong.
const HOUR = 3600 * 1000;
const REST = { new: 12 * HOUR, learning: 20 * HOUR, mastered: 7 * 24 * HOUR };
function isDue(item, now = Date.now()) {
  const a = attemptsOf(item);
  if (!a.length || !item.lastSeen) return true;          // never quizzed
  const rest = a[a.length - 1] === false ? 4 * HOUR : REST[bucketOf(item)];
  return now - item.lastSeen >= rest;
}

/** Counts for the home screen: { total, due, new, learning, mastered }. */
export async function vaultStats(lang = getLearningLanguage()) {
  const items = (await getAllVaultItems()).filter((it) => (it.lang || "zh") === lang);
  const out = { total: items.length, due: 0, dueWords: 0, dueSentences: 0, new: 0, learning: 0, mastered: 0 };
  const now = Date.now();
  for (const it of items) { out[bucketOf(it)]++; if (isDue(it, now)) { out.due++; out[isSentence(it) ? "dueSentences" : "dueWords"]++; } }
  return out;
}

/** Map word -> bucket for the learner's saved words (sentences excluded). */
export async function vaultBucketMap(lang = getLearningLanguage()) {
  const map = new Map();
  for (const it of await getAllVaultItems()) {
    if ((it.lang || "zh") === lang && !isSentence(it)) map.set(vocabularyKey(it.id, lang), bucketOf(it));
  }
  return map;
}

/** Saved, not-yet-mastered words that appear in a chapter: [{ item, bucket }]. */
export async function chapterWatchWords(chapter) {
  const lang = chapter?.language || "zh";
  const keys = new Set();
  for (const p of chapter?.pairs || []) {
    for (const c of (p.alignment || []).flatMap(c => [c, ...(c.lookup || [])])) {
      const k = vocabularyKey(c.hanzi || c.target, lang);
      if (k) keys.add(k);
    }
  }
  const items = (await getAllVaultItems())
    .filter((it) => (it.lang || "zh") === lang && keys.has(vocabularyKey(it.id, lang)) && !isMastered(it));
  return items
    .map((item) => ({ item, bucket: bucketOf(item) }))
    .sort((a, b) => masteryPct(b.item) - masteryPct(a.item));
}

// ── Mastered set for the reader's auto-hide ──
let _masteredSet = new Set();
let _masteredDirty = true;
async function refreshMastered() {
  try {
    const items = await getAllVaultItems();
    _masteredSet = new Set(items.filter((i) => !isSentence(i) && isMastered(i)).map((i) => i.id));
  } catch { _masteredSet = new Set(); }
  _masteredDirty = false;
}
export function getMasteredHanziSync() { return _masteredSet; }
export async function ensureMastered() { if (_masteredDirty) await refreshMastered(); return _masteredSet; }

// ── Save / remove ──
export async function saveWord(chunk, chapter) {
  // The word in the target language's own script: hanzi for Chinese, the target
  // text for languages without a separate script (e.g. French).
  const word = (chunk?.hanzi || chunk?.target || "").trim();
  if (!word || chunk.chunkIdx == null) return { ok: false, reason: "not-a-word" };
  const lang = chapter?.language || getLearningLanguage();
  const id = vocabularyKey(word, lang);
  if (await getVaultItem(id)) return { ok: true, already: true };
  const pair = chapter?.pairs?.[chunk.pairIdx];
  const storyGloss = (chunk.english || "").trim();
  // Romanization only applies where the word differs from its reading (Chinese).
  const pinyin = chunk.hanzi ? (chunk.pinyin || chunk.target || "") : "";
  await putVaultItem({
    id,
    hanzi: word,            // the headword in its own script (name kept for compatibility)
    pinyin,
    english: storyGloss,
    storyGloss,
    meaningRefined: false,
    category: chunk.category || null,
    frequency_band: chunk.frequency_band || null,
    lang: chapter?.language || getLearningLanguage(),
    context: pair ? { hanzi: pair.hanzi || pair.target || "", target: pair.target || "", english: pair.english || "", targetStart: chunk.targetStart ?? null, targetEnd: chunk.targetEnd ?? null, hanziStart: chunk.hanziStart ?? null } : null,
    createdAt: Date.now(),
    attempts: [],
  });
  _masteredDirty = true;
  refineMeaning(id);   // background — fetch the true dictionary meaning
  window.dispatchEvent(new CustomEvent("vault:changed"));
  return { ok: true };
}

export async function removeWord(hanzi) {
  if (!hanzi) return;
  await deleteVaultItem(vocabularyKey(hanzi, getLearningLanguage()));
  _masteredDirty = true;
}

export async function isWordSaved(hanzi) {
  if (!hanzi) return false;
  return !!(await getVaultItem(vocabularyKey(hanzi, getLearningLanguage())));
}

// Books store sentences as clauses ("她蹲下来，" / "从轨道里…。"). Widen a clause
// range [lo, hi] to whole sentences: back to just after the previous full stop,
// forward to the next one (at most 8 clauses each way).
const SENTENCE_END = /[。！？!?….]["”’」』)»]*\s*$/;
export function sentenceRange(pairs, lo, hi) {
  const ends = (i) => SENTENCE_END.test((pairs[i]?.hanzi || pairs[i]?.target || "").trim());
  let a = lo, b = hi;
  for (let n = 0; a > 0 && !ends(a - 1) && n < 8; n++) a--;
  for (let n = 0; b < pairs.length - 1 && !ends(b) && n < 8; n++) b++;
  return [a, b];
}

/**
 * Save one or more consecutive sentences (reader pairs) as a single vault item.
 * Returns { ok, already, text }.
 */
export async function saveSentence(pairs, chapter) {
  if (!pairs?.length) return { ok: false };
  const lang = chapter?.language || getLearningLanguage();
  const isZh = lang === "zh" && pairs.every((p) => p.hanzi);
  const own = pairs.map((p) => (isZh ? p.hanzi : p.target || "").trim());
  const text = isZh ? own.join("") : own.join(" ");
  const id = `s:${text}`;
  if (await getVaultItem(id)) return { ok: true, already: true, text };
  const target = pairs.map((p) => (p.target || "").trim()).join(" ");
  const english = pairs.map((p) => (p.english || "").trim()).join(" ");
  await putVaultItem({
    id,
    kind: "sentence",
    hanzi: text,
    pinyin: isZh ? target : "",
    english,
    lang,
    context: { hanzi: text, target, english },
    source: { bookId: chapter?.book_id || null, chapterId: chapter?.id || null },
    createdAt: Date.now(),
    attempts: [],
  });
  window.dispatchEvent(new CustomEvent("vault:changed"));
  return { ok: true, text };
}

/** Save ready-made word items (e.g. words missed in a chapter quiz). */
export async function saveItems(items) {
  let added = 0;
  for (const it of items) {
    const id = isSentence(it) ? it?.id : vocabularyKey(it?.hanzi || it?.id, it?.lang || getLearningLanguage());
    if (!id || (await getVaultItem(id))) continue;
    await putVaultItem({
      id, hanzi: it.hanzi, pinyin: it.pinyin || "", english: it.english, storyGloss: it.english,
      meaningRefined: false, category: it.category || null, frequency_band: it.frequency_band || null,
      lang: it.lang || getLearningLanguage(), context: it.context || null, createdAt: Date.now(), attempts: [],
    });
    refineMeaning(id);
    added++;
  }
  _masteredDirty = true;
  window.dispatchEvent(new CustomEvent("vault:changed"));
  return added;
}

// ── Dictionary meaning (general, multi-sense) via the API ──
async function fetchMeaning(item, key) {
  const isNew = /^gpt-5|^o1|^o3/i.test(MEANING_MODEL);
  const lang = languageName(item.lang || "zh");
  const sys =
    `You are a concise ${lang}-English dictionary. Given a ${lang} word and the ` +
    "sentence it appeared in, return the word's GENERAL dictionary meaning in " +
    "English — NOT merely how it was translated in that one sentence. Include the " +
    "common distinct senses, separated by semicolons. Keep each sense short. For " +
    "compound or multi-part words give the full meaning (e.g. Chinese 吃完 → \"to " +
    'finish eating"). Output ONLY the meaning text — no transliteration, no ' +
    "examples, no quotes.";
  const usr = `Word: ${item.hanzi}\n${item.pinyin ? `Pronunciation: ${item.pinyin}\n` : ""}In-sentence translation used: ${item.storyGloss || item.english}\nSentence: ${item.context?.hanzi || ""}`;
  const body = { model: MEANING_MODEL, messages: [{ role: "system", content: sys }, { role: "user", content: usr }], [isNew ? "max_completion_tokens" : "max_tokens"]: 200 };
  if (!isNew) body.temperature = 0.2;
  const res = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "").trim();
}
async function refineMeaning(id) {
  try {
    const item = await getVaultItem(id);
    if (!item || item.meaningRefined) return;
    const settings = await getSettings();
    if (!settings.openaiKey || !navigator.onLine) return;
    const meaning = await fetchMeaning(item, settings.openaiKey);
    if (!meaning) return;
    await updateVaultItem(id, { english: meaning, meaningRefined: true });
  } catch { /* keep the story gloss */ }
}

// ── Vault screen ──
const BUCKET_LABEL = { new: "New", learning: "Learning", mastered: "Mastered" };
let vaultTab = "word";   // "word" | "sentence"

export async function openVault() {
  const lang = getLearningLanguage();
  const all = (await getAllVaultItems()).filter((it) => (it.lang || "zh") === lang);
  const nSentences = all.filter(isSentence).length;
  for (const btn of document.querySelectorAll("#vault-tabs button")) {
    const kind = btn.dataset.kind;
    btn.classList.toggle("on", kind === vaultTab);
    btn.querySelector("span").textContent = kind === "sentence" ? nSentences : all.length - nSentences;
  }
  const items = all.filter((it) => (vaultTab === "sentence") === isSentence(it));
  const counts = { new: 0, learning: 0, mastered: 0 };
  for (const it of items) counts[bucketOf(it)]++;
  $("vault-new").textContent = counts.new;
  $("vault-learning").textContent = counts.learning;
  $("vault-mastered").textContent = counts.mastered;
  $("vault-start").disabled = all.length === 0;
  $("vault-story").hidden = vaultTab === "sentence" || !items.length;

  const list = $("vault-list");
  const empty = $("vault-empty");
  list.innerHTML = "";
  $("vault-empty-title").textContent = vaultTab === "sentence" ? "No saved sentences yet" : "No saved words yet";
  $("vault-empty-sub").textContent = vaultTab === "sentence"
    ? "Highlight a sentence while reading, then tap Save."
    : "Tap a word while reading, then “Save to Memory Vault”.";
  if (!items.length) { empty.hidden = false; return; }
  empty.hidden = true;
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const it of items) {
    const b = bucketOf(it);
    const sentence = isSentence(it);
    const li = document.createElement("li");
    li.className = `vault-row${sentence ? " is-sentence" : ""}`;
    const canWrite = !sentence && (it.lang || "zh") === "zh" && /[㐀-鿿]/.test(it.hanzi);
    li.innerHTML = `
      <div class="vault-word">
        <div class="vault-hanzi">${escape(it.hanzi)}</div>
        <div class="vault-pinyin">${escape(it.pinyin)}</div>
        <div class="vault-english">${escape(it.english)}</div>
      </div>
      <div class="vault-side">
        <span class="vault-status vault-status-${b}">${b === "mastered" ? "Mastered" : `${BUCKET_LABEL[b]} · ${attemptsOf(it).filter(Boolean).length}/20 correct reviews`}</span>
        <div class="vault-tools">
          <button class="vault-tool vault-hear" aria-label="Hear it">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>
          </button>
          ${canWrite ? `<button class="vault-tool vault-write" aria-label="Practise writing">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
          </button>` : ""}
          <button class="vault-tool vault-del" aria-label="Remove">×</button>
        </div>
      </div>`;
    li.querySelector(".vault-hear").addEventListener("click", () => speakWord(it.hanzi, it.lang || "zh"));
    li.querySelector(".vault-write")?.addEventListener("click", () => openWriter(it.hanzi, it.pinyin));
    li.querySelector(".vault-del").addEventListener("click", async () => {
      const label = sentence ? "this sentence" : `“${it.hanzi}”`;
      if (!confirm(`Remove ${label} from your Memory Vault?`)) return;
      await removeWord(it.id);
      openVault();
    });
    list.appendChild(li);
  }
}

// ── Quiz setup sheet ──
const DIR_LABELS = (lname) => ({
  t2e: `Meaning: ${lname} → English`,
  e2t: `Say it: English → ${lname}`,
  cloze: "Fill in the sentence",
  dictation: "Dictation: listen and answer",
  mix: "Mix of everything",
});

async function openQuizSetup() {
  const s = await getSettings();
  $("review-answer-mode").value = s.reviewAnswerMode || "mix";
  $("review-direction").value = s.reviewDirection || "mix";
  const buckets = s.reviewBuckets || ["new", "learning"];
  for (const btn of document.querySelectorAll("#quiz-setup .bucket-toggle")) {
    btn.classList.toggle("on", buckets.includes(btn.dataset.bucket));
  }
  const kinds = s.reviewKinds || ["word", "sentence"];
  for (const btn of document.querySelectorAll("#quiz-setup .kind-toggle")) {
    btn.classList.toggle("on", kinds.includes(btn.dataset.kind));
  }
  const length = s.reviewLength || "20";
  for (const btn of document.querySelectorAll("#quiz-setup .length-toggle")) {
    btn.classList.toggle("on", btn.dataset.len === length);
  }
  const script = s.reviewScript || "both";
  for (const btn of document.querySelectorAll("#quiz-setup .script-toggle")) {
    btn.classList.toggle("on", btn.dataset.script === script);
  }
  // Language-aware setup: name the language in the question types, and hide the
  // pinyin/characters choice for languages with a single written form.
  const lang = getLearningLanguage();
  const labels = DIR_LABELS(languageName(lang));
  for (const opt of $("review-direction").options) opt.textContent = labels[opt.value] || opt.textContent;
  $("quiz-script-section").hidden = lang !== "zh";
  $("quiz-setup-note").textContent = "";
  $("quiz-setup-backdrop").hidden = false;
  const sheet = $("quiz-setup");
  sheet.hidden = false;
  void sheet.offsetHeight;
  sheet.classList.add("open");
}
function closeQuizSetup() {
  const sheet = $("quiz-setup");
  sheet.classList.remove("open");
  setTimeout(() => { sheet.hidden = true; $("quiz-setup-backdrop").hidden = true; }, 240);
}

// ── Quiz engine ──
//
// One engine for every quiz: vault quizzes (weighted or a fixed set), the daily
// review, chapter "words to watch", and end-of-chapter quizzes. A quiz walks a
// list of cards { item, dir?, options? } — `dir` and `options` are fixed for
// prepared quizzes (chapter quizzes) and chosen per card otherwise.
//
// Question types (dir): t2e meaning · e2t say it · cloze fill in the sentence ·
// dictation listen and answer. Answer modes: choice · type · self (show the
// answer, then "I got it" / "I missed it" — for whole sentences, which can't be
// graded reliably from typing).
let quiz = null;

function weightFor(item) {
  let w = 1 + (100 - masteryPct(item)) / 20;   // lower mastery → heavier
  const a = attemptsOf(item);
  if (a.length && a[a.length - 1] === false) w += 3;               // just got it wrong
  if (a.length >= 2 && a[a.length - 2] === false) w += 1;
  return w;
}
function pickWeighted(pool, excludeId) {
  let cands = pool;
  if (pool.length > 1 && excludeId) cands = pool.filter((w) => w.id !== excludeId);
  const weights = cands.map(weightFor);
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < cands.length; i++) { r -= weights[i]; if (r <= 0) return cands[i]; }
  return cands[cands.length - 1];
}

async function newQuiz(fields) {
  const s = await getSettings();
  const lang = fields.lang || getLearningLanguage();
  const all = (await getAllVaultItems()).filter((it) => (it.lang || "zh") === lang);
  return {
    mode: "fixed", total: 0, answered: 0, correct: 0, queue: null, pool: null, lastId: null,
    distractors: all, title: "", chapter: false, missed: [], counted: new Set(), finished: false,
    answerMode: s.reviewAnswerMode || "mix", direction: s.reviewDirection || "mix",
    script: lang === "zh" ? (s.reviewScript || "both") : "hanzi", lang, current: null,
    ...fields,
  };
}

async function beginQuiz() {
  unlockAudio();   // inside the tap, so dictation audio may play later
  const s = await getSettings();
  const buckets = s.reviewBuckets || ["new", "learning"];
  const kinds = s.reviewKinds || ["word", "sentence"];
  if (!buckets.length) { $("quiz-setup-note").textContent = "Pick at least one group to include."; return; }
  if (!kinds.length) { $("quiz-setup-note").textContent = "Pick words, sentences or both."; return; }
  const lang = getLearningLanguage();
  const all = (await getAllVaultItems()).filter((it) => (it.lang || "zh") === lang);
  const pool = all.filter((it) => buckets.includes(bucketOf(it)) && kinds.includes(isSentence(it) ? "sentence" : "word"));
  if (!pool.length) { $("quiz-setup-note").textContent = all.some(isMastered) ? "These words are mastered. Include Mastered to review them, or save some new words." : "Nothing saved in the selected groups yet."; return; }

  const length = s.reviewLength || "20";
  const fields = { lang, pool };
  if (length === "endless") fields.mode = "endless";
  else if (length === "all") { fields.queue = shuffle(pool.slice()).map((item) => ({ item })); fields.total = pool.length; }
  else { fields.total = Math.min(pool.length, parseInt(length, 10) || 20); fields.queue = shuffle(pool.slice()).slice(0, fields.total).map(item => ({ item })); }
  quiz = await newQuiz(fields);
  closeQuizSetup();
  showQuiz();
}

function showQuiz() {
  $("review-card").hidden = false;
  $("review-done").hidden = true;
  window.dispatchEvent(new CustomEvent("app:setview", { detail: "review" }));
  renderCard();
}

/**
 * Quiz a specific set of words once each (e.g. a chapter's words, or today's
 * due words), using the learner's saved answer/question-type/script preferences.
 */
export async function startQuizWithItems(items, { title = "" } = {}) {
  if (!items?.length) return;
  unlockAudio();
  quiz = await newQuiz({
    lang: items[0].lang || getLearningLanguage(),
    queue: shuffle(items.slice()).map((item) => ({ item })),
    total: items.length,
    title,
  });
  showQuiz();
}

/**
 * Run a prepared quiz (end-of-chapter): fixed question types and options, always
 * multiple choice. Words already in the vault count toward their mastery; words
 * missed that aren't saved yet are offered for saving at the end.
 */
export async function startCardQuiz(cards, { title = "", lang } = {}) {
  if (!cards?.length) return;
  unlockAudio();
  quiz = await newQuiz({ lang: lang || cards[0].item.lang, queue: cards, total: cards.length, title, chapter: true, answerMode: "choice" });
  showQuiz();
}

/** Today's review: the words and sentences that are due, most in need first (max 20). */
export async function startDailyReview() {
  const lang = getLearningLanguage();
  const due = (await getAllVaultItems()).filter((it) => (it.lang || "zh") === lang && isDue(it));
  due.sort((a, b) => weightFor(b) - weightFor(a));
  await startQuizWithItems(due.slice(0, 20), { title: "Daily review" });
}

// The target-language side of a card in the chosen script.
function chineseStr(item, script) {
  if (script === "pinyin") return item.pinyin || item.hanzi;
  if (script === "both") return item.pinyin ? `${item.hanzi} · ${item.pinyin}` : item.hanzi;
  return item.hanzi;
}
// The answer for a card: English (t2e) or the word/sentence itself.
const answerText = (item, dir, script) => (dir === "t2e" ? item.english : chineseStr(item, script));
// HTML label for a choice button (sentences in "both" put pinyin on a 2nd line).
function optionHtml(item, dir, script) {
  if (dir === "t2e") return escape(item.english);
  if (isSentence(item) && script === "both" && item.pinyin) {
    return `${escape(item.hanzi)}<small>${escape(item.pinyin)}</small>`;
  }
  return escape(chineseStr(item, script));
}

// ── Fill-in-the-sentence (cloze) ──
// Blank the word out of the sentence it was saved from. Returns the HTML lines
// to show for the chosen script, or null if the word can't be found in them.
function blankOut(sentence, word, offset = null) {
  const range = clozeRange(sentence, word, offset);
  if (!range) return null;
  const i = range.start;
  return `${escape(sentence.slice(0, i))}<span class="cloze-gap">${"＿".repeat(Math.min(Math.max([...word].length, 2), 4))}</span>${escape(sentence.slice(i + word.length))}`;
}
function clozeLines(item, script) {
  const c = item.context;
  if (!c || isSentence(item)) return null;
  const isZh = (item.lang || "zh") === "zh" && !!item.pinyin;
  const lines = [];
  if (!isZh) {
    const l = blankOut(c.target || c.hanzi, item.hanzi, c.targetStart);
    if (l) lines.push({ html: l, cls: "" });
  } else {
    if (script !== "pinyin") { const l = blankOut(c.hanzi, item.hanzi, c.hanziStart); if (l) lines.push({ html: l, cls: "is-hanzi" }); }
    if (script !== "hanzi") { const l = blankOut(c.target, item.pinyin, c.targetStart); if (l) lines.push({ html: l, cls: "is-pinyin" }); }
  }
  return lines.length ? lines : null;
}

// The sentence itself, in the chosen script, as prompt lines.
function sentenceLines(item, script) {
  const isZh = (item.lang || "zh") === "zh" && !!item.pinyin;
  if (!isZh) return `<div class="cloze-line">${escape(item.hanzi)}</div>`;
  const lines = [];
  if (script !== "pinyin") lines.push(`<div class="cloze-line is-hanzi">${escape(item.hanzi)}</div>`);
  if (script !== "hanzi") lines.push(`<div class="cloze-line is-pinyin">${escape(item.pinyin)}</div>`);
  return lines.join("");
}

// Same-kind items to draw wrong options from.
const peersOf = (item) => (quiz.distractors || []).filter((w) => w.id !== item.id && isSentence(w) === isSentence(item));

function nextSpec() {
  if (quiz.queue) return quiz.queue[quiz.answered] || null;
  const item = pickWeighted(quiz.pool, quiz.lastId);
  return item ? { item } : null;
}

function renderCard() {
  const spec = nextSpec();
  if (!spec) return endQuiz();
  const item = spec.item;
  quiz.lastId = item.id;
  const script = quiz.script;
  const sentence = isSentence(item);
  const cloze = clozeLines(item, script);

  // Question type.
  let dir = spec.dir || quiz.direction;
  if (dir === "mix") {
    const dirs = sentence ? ["t2e", "e2t", "dictation"] : ["t2e", "e2t", "dictation"].concat(cloze ? ["cloze"] : []);
    dir = dirs[Math.floor(Math.random() * dirs.length)];
  }
  if (dir === "cloze" && !cloze) dir = sentence ? "dictation" : "e2t";   // no usable sentence

  // Deduplicate before deciding whether a choice question is viable.
  let mode = spec.options ? "choice" : quiz.answerMode;
  if (mode === "mix") mode = Math.random() < 0.5 ? "choice" : "type";
  const wantedChoices = mode === "choice";
  const options = distinctOptions(item, spec.options || shuffle(peersOf(item)), dir).slice(0, 3);
  if (mode === "choice" && options.length < 3) mode = "type";
  if (sentence && mode === "type" && dir !== "dictation") mode = "self";
  $("review-mode-note").textContent = wantedChoices && mode !== "choice" ? "Not enough distinct choices for this item. " + (mode === "self" ? "Reveal the answer and check yourself." : "Type your answer instead.") : "";
  quiz.current = { item, dir, mode, script, options };

  $("review-progress-text").textContent = quiz.mode === "endless" ? `${quiz.answered} answered` : `${quiz.answered + 1} / ${quiz.total}`;
  $("review-finish").hidden = false;
  $("review-prompt-label").textContent =
    dir === "t2e" ? "What does this mean?"
    : dir === "cloze" ? "Fill in the missing word"
    : dir === "dictation" ? (sentence ? "What sentence do you hear?" : "What word do you hear?")
    : "How do you say this?";

  const promptEl = $("review-prompt");
  const subEl = $("review-prompt-sub");
  subEl.hidden = true; subEl.textContent = "";
  if (dir === "dictation") {
    promptEl.className = "review-prompt is-audio";
    promptEl.innerHTML = `<button class="dictation-play" aria-label="Play">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>
      </button><div class="dictation-hint">Tap to play again</div>`;
    const play = () => speakWord(item.hanzi, item.lang || "zh");
    promptEl.querySelector(".dictation-play").addEventListener("click", play);
    play();
  } else if (dir === "cloze") {
    promptEl.className = "review-prompt is-sentence";
    promptEl.innerHTML = cloze.map((l) => `<div class="cloze-line ${l.cls}">${l.html}</div>`).join("")
      + (item.context.english ? `<div class="cloze-en">${escape(item.context.english)}</div>` : "");
  } else if (dir === "t2e") {
    if (sentence) { promptEl.className = "review-prompt is-sentence"; promptEl.innerHTML = sentenceLines(item, script); }
    else if (script === "pinyin") { promptEl.textContent = item.pinyin || item.hanzi; promptEl.className = "review-prompt"; }
    else {
      promptEl.textContent = item.hanzi; promptEl.className = "review-prompt is-hanzi";
      if (script === "both" && item.pinyin) { subEl.textContent = item.pinyin; subEl.hidden = false; }
    }
  } else {
    promptEl.textContent = item.english;
    promptEl.className = `review-prompt${sentence ? " is-sentence" : ""}`;
  }

  const area = $("review-answer-area");
  area.innerHTML = ""; area.hidden = false;
  $("review-reveal").hidden = true; $("review-reveal").innerHTML = "";
  $("review-next").hidden = true;

  if (mode === "choice") renderChoices(item, dir, area, script, options);
  else if (mode === "self") renderSelf(item, dir, area);
  else renderType(item, dir, area, script);
}

function renderChoices(item, dir, area, script, fixedOptions) {
  const correct = answerText(item, dir, script);
  const pool = fixedOptions ? fixedOptions.slice() : shuffle(peersOf(item));
  const wrong = [];
  for (const w of pool) {
    const t = answerText(w, dir, script);
    const normOption = value => String(value || "").trim().toLowerCase();
    const same = x => normOption(x.english) === normOption(w.english) || normOption(x.hanzi || x.id) === normOption(w.hanzi || w.id);
    if (t && normOption(t) !== normOption(correct) && !same(item) && !wrong.some(same)) wrong.push(w);
    if (wrong.length === 3) break;
  }
  const options = shuffle([{ it: item, ok: true }, ...wrong.map((w) => ({ it: w, ok: false }))]);
  for (const o of options) {
    const b = document.createElement("button");
    b.className = "review-choice";
    b.innerHTML = optionHtml(o.it, dir, script);
    if (o.ok) b.dataset.correct = "1";
    b.addEventListener("click", () => onAnswer(o.ok));
    area.appendChild(b);
  }
}

// Self-graded: reveal the answer, then the learner says whether they had it.
function renderSelf(item, dir, area) {
  const show = document.createElement("button");
  show.className = "btn-primary btn-block";
  show.textContent = "Show answer";
  show.addEventListener("click", () => {
    area.innerHTML = `<p class="self-q">Did you get it?</p>`;
    const row = document.createElement("div");
    row.className = "self-row";
    for (const [label, ok] of [["I missed it", false], ["I got it", true]]) {
      const b = document.createElement("button");
      b.className = `self-btn ${ok ? "ok" : "no"}`;
      b.textContent = label;
      b.addEventListener("click", () => onAnswer(ok));
      row.appendChild(b);
    }
    area.appendChild(row);
    renderReveal(item, null);
  });
  area.appendChild(show);
}

const norm = (s) => String(s || "").toLowerCase().replace(/[\s,.!?;:'"“”‘’()\[\]，。！？；：、…—-]/g, "").trim();
const stripTones = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

// Similarity 0..1 between two strings (longest common subsequence / longer length).
function similarity(a, b) {
  const x = [...a], y = [...b];
  if (!x.length || !y.length) return 0;
  const prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    let diag = 0;
    for (let j = 1; j <= y.length; j++) {
      const tmp = prev[j];
      prev[j] = x[i - 1] === y[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = tmp;
    }
  }
  return prev[y.length] / Math.max(x.length, y.length);
}

export function gradeType(input, item, dir) {
  if (isSentence(item) && item.lang === "fr" && dir !== "t2e") return sentenceAnswer(input, item.hanzi);
  const given = norm(input);
  if (!given) return false;
  if (dir === "t2e") {
    return englishAnswer(input, item.english);
  }
  const han = norm(item.hanzi);
  const py = normalizePinyin(item.pinyin);
  const g = normalizePinyin(input);
  if (isSentence(item)) {
    // Whole-sentence dictation: close enough counts (a slip or two is fine).
    const vsHan = similarity(given, han);
    const vsPy = py ? similarity(g, py) : 0;
    return Math.max(vsHan, vsPy, similarity(g, stripTones(han))) >= 0.85;
  }
  // For languages like French the headword itself is Latin script, so also accept
  // it without accents (eg. "ecole" for "école").
  return given === han || g === stripTones(han) || (py && g === py);
}

function renderType(item, dir, area, script) {
  const form = document.createElement("form");
  form.className = "review-type";
  const input = document.createElement("input");
  input.type = "text";
  const lname = languageName(quiz.lang);
  input.placeholder = dir === "t2e" ? "Type the English…"
    : dir === "dictation" ? (quiz.lang === "zh" ? "Type what you hear (characters or pinyin)…" : "Type what you hear…")
    : dir === "cloze" && quiz.lang !== "zh" ? "Type the missing word…"
    : (quiz.lang === "zh" ? "Type the Chinese (hanzi or pinyin)…" : `Type the ${lname}…`);
  input.autocomplete = "off"; input.autocapitalize = "off"; input.spellcheck = false;
  const submit = document.createElement("button");
  submit.type = "submit"; submit.className = "btn-primary"; submit.textContent = "Check";
  form.appendChild(input); form.appendChild(submit);
  form.addEventListener("submit", (e) => { e.preventDefault(); onAnswer(gradeType(input.value, item, dir)); });
  area.appendChild(form);
  // Don't pop the keyboard over a dictation prompt before it has been heard.
  if (dir !== "dictation") setTimeout(() => input.focus(), 120);
}

async function onAnswer(correct) {
  if (!quiz?.current || quiz.finished || quiz.current.answered) return;
  const session = quiz;
  quiz.current.answered = true;
  const { item, mode } = quiz.current;
  const area = $("review-answer-area");
  if (mode === "choice") {
    for (const b of area.querySelectorAll(".review-choice")) {
      b.disabled = true;
      if (b.dataset.correct) b.classList.add("correct");
      else b.classList.add(correct ? "dim" : "wrong");
    }
  } else if (mode === "type") {
    const form = area.querySelector("form");
    if (form) { form.querySelector("input").disabled = true; form.querySelector("button").disabled = true; form.classList.add(correct ? "correct" : "wrong"); }
  } else {
    area.innerHTML = "";
  }
  quiz.answered++;
  if (correct) quiz.correct++;

  // Count toward mastery: the vault copy of the word (chapter quizzes use their
  // own word objects, so look the saved one up).
  if (!session.counted.has(item.id)) {
    const saved = await updateVaultItem(item.id, fresh => {
      const updated = recordAttempt(fresh, correct);
      return { attempts: updated.attempts, lastSeen: updated.lastSeen };
    });
    if (saved) { session.counted.add(item.id); _masteredDirty = true; }
  }
  if (quiz !== session || session.finished) return;
  if (!correct && !quiz.missed.some((m) => m.id === item.id)) {
    quiz.missed.push(item);
  }
  bumpActivity({ answers: 1 }).catch(() => {});
  renderReveal(item, correct);
  const next = $("review-next");
  next.hidden = false;
  next.textContent = (quiz.mode !== "endless" && quiz.answered >= quiz.total) ? "Finish" : "Next";
}

// correct: true / false, or null when revealing a self-graded answer.
function renderReveal(item, correct) {
  const el = $("review-reveal");
  el.hidden = false;
  const sentence = isSentence(item);
  const canWrite = !sentence && (item.lang || "zh") === "zh" && /[㐀-鿿]/.test(item.hanzi);
  const verdict = correct === null ? "" : `<div class="reveal-verdict ${correct ? "ok" : "no"}">${correct ? "Correct" : "Not quite"}</div>`;
  el.innerHTML = `
    ${verdict}
    <div class="reveal-hanzi${sentence ? " is-sentence" : ""}">${escape(item.hanzi)}</div>
    <div class="reveal-pinyin">${escape(item.pinyin)}</div>
    <div class="reveal-english">${escape(item.english)}</div>
    ${!sentence && item.context && item.context.hanzi ? `<div class="reveal-context">${escape(item.context.hanzi)}<span>${escape(item.context.english)}</span></div>` : ""}
    <div class="reveal-audio-row">
      <button id="reveal-audio" class="pop-act">▶ Hear it</button>
      ${!sentence && item.context && item.context.hanzi ? `<button id="reveal-audio-sentence" class="pop-act">▶ Hear sentence</button>` : ""}
      ${canWrite ? `<button id="reveal-write" class="pop-act">✎ Write it</button>` : ""}
    </div>`;
  el.querySelector("#reveal-audio").addEventListener("click", () => speakWord(item.hanzi, item.lang || "zh"));
  el.querySelector("#reveal-audio-sentence")?.addEventListener("click", () => speakWord(item.context.hanzi, item.lang || "zh"));
  el.querySelector("#reveal-write")?.addEventListener("click", () => openWriter(item.hanzi, item.pinyin));
}

function nextCard() {
  if (!quiz || !quiz.current?.answered) return;
  if (quiz.mode !== "endless" && quiz.answered >= quiz.total) return endQuiz();
  renderCard();
}

export function finishActiveQuiz() { if (!quiz || quiz.finished) return false; endQuiz(); return true; }
function endQuiz() {
  if (quiz) quiz.finished = true;
  const done = $("review-done");
  $("review-card").hidden = true;
  done.hidden = false;
  const q = quiz;
  const acc = q && q.answered ? Math.round((q.correct / q.answered) * 100) : 0;
  const missed = q?.missed || [];
  done.innerHTML = `
    <p class="empty-title">${q?.title ? `${escape(q.title)} complete` : "Quiz complete"}</p>
    <p class="empty-sub">${q ? q.correct : 0} / ${q ? q.answered : 0} correct (${acc}%)</p>
    ${missed.length ? `
      <div class="missed-box">
        <div class="missed-label">Words you missed</div>
        <div class="missed-words">${missed.map((m) => `<span>${escape(m.hanzi)}${m.pinyin ? ` <i>${escape(m.pinyin)}</i>` : ""} <em>${escape(m.english)}</em></span>`).join("")}</div>
        <button class="pop-act" id="review-save-missed">Save ${missed.length === 1 ? "it" : `all ${missed.length}`} to Memory Vault</button>
      </div>` : ""}
    <button class="btn-primary" id="review-done-btn">Done</button>`;
  done.querySelector("#review-save-missed")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const n = await saveItems(missed);
    btn.textContent = n ? `✓ Saved ${n} word${n === 1 ? "" : "s"}` : "✓ Already saved";
  });
  // Back to wherever the quiz was started from (vault, home, or the reader).
  done.querySelector("#review-done-btn").addEventListener("click", () => window.dispatchEvent(new CustomEvent("app:back")));
  window.dispatchEvent(new CustomEvent("vault:changed"));
  quiz = null;
}

async function migrateFrenchWordKeys() {
  for (const old of await getAllVaultItems()) {
    if (old.lang !== "fr" || isSentence(old)) continue;
    const id = vocabularyKey(old.hanzi || old.id, "fr");
    if (id === old.id) continue;
    const current = await getVaultItem(id);
    const preferred = current && (current.meaningRefined || (current.lastSeen || 0) >= (old.lastSeen || 0)) ? current : old;
    const attempts = attemptsOf(current).length > attemptsOf(old).length ? attemptsOf(current) : attemptsOf(old);
    await putVaultItem({ ...old, ...preferred, id, attempts: attempts.slice(-WINDOW), lastSeen: Math.max(old.lastSeen || 0, current?.lastSeen || 0) });
    await deleteVaultItem(old.id);
  }
}

export async function initVault() {
  await migrateFrenchWordKeys();
  await ensureMastered();
  window.addEventListener("vault:changed", () => { _masteredDirty = true; });
  // Re-render the vault for the newly chosen language (if it's the open view).
  window.addEventListener("language:changed", () => {
    if (document.body.getAttribute("data-view") === "vault") openVault();
  });
  $("vault-start")?.addEventListener("click", openQuizSetup);
  $("vault-story")?.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("stories:new", { detail: { words: "learning" } }));
  });
  for (const btn of document.querySelectorAll("#vault-tabs button")) {
    btn.addEventListener("click", () => { vaultTab = btn.dataset.kind; openVault(); });
  }
  $("quiz-setup-close")?.addEventListener("click", closeQuizSetup);
  $("quiz-setup-backdrop")?.addEventListener("click", closeQuizSetup);
  $("quiz-begin")?.addEventListener("click", beginQuiz);
  $("review-next")?.addEventListener("click", nextCard);
  $("review-finish")?.addEventListener("click", endQuiz);

  $("review-answer-mode")?.addEventListener("change", async (e) => { await updateSettings({ reviewAnswerMode: e.target.value }); });
  $("review-direction")?.addEventListener("change", async (e) => { await updateSettings({ reviewDirection: e.target.value }); });

  for (const btn of document.querySelectorAll("#quiz-setup .bucket-toggle")) {
    btn.addEventListener("click", async () => {
      btn.classList.toggle("on");
      const buckets = [...document.querySelectorAll("#quiz-setup .bucket-toggle.on")].map((b) => b.dataset.bucket);
      await updateSettings({ reviewBuckets: buckets });
    });
  }
  for (const btn of document.querySelectorAll("#quiz-setup .kind-toggle")) {
    btn.addEventListener("click", async () => {
      btn.classList.toggle("on");
      const kinds = [...document.querySelectorAll("#quiz-setup .kind-toggle.on")].map((b) => b.dataset.kind);
      await updateSettings({ reviewKinds: kinds });
    });
  }
  for (const btn of document.querySelectorAll("#quiz-setup .length-toggle")) {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("#quiz-setup .length-toggle").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      await updateSettings({ reviewLength: btn.dataset.len });
    });
  }
  for (const btn of document.querySelectorAll("#quiz-setup .script-toggle")) {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("#quiz-setup .script-toggle").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      await updateSettings({ reviewScript: btn.dataset.script });
    });
  }
}
