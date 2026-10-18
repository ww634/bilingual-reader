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

import { getSettings, updateSettings, bumpActivity, putVaultItem, getVaultItem, getAllVaultItems, deleteVaultItem } from "./db.js";
import { speakWord } from "./speech.js";
import { getLearningLanguage, languageName } from "./languages.js";

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
function bucketOf(item) {
  const p = masteryPct(item);
  if (p <= 25) return "new";
  if (p <= 90) return "learning";
  return "mastered";
}
const isMastered = (item) => bucketOf(item) === "mastered";
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
  const out = { total: items.length, due: 0, new: 0, learning: 0, mastered: 0 };
  const now = Date.now();
  for (const it of items) { out[bucketOf(it)]++; if (isDue(it, now)) out.due++; }
  return out;
}

/** Saved, not-yet-mastered words that appear in a chapter: [{ item, bucket }]. */
export async function chapterWatchWords(chapter) {
  const lang = chapter?.language || "zh";
  const keys = new Set();
  for (const p of chapter?.pairs || []) {
    for (const c of p.alignment || []) {
      const k = (c.hanzi || c.target || "").trim();
      if (k) keys.add(k);
    }
  }
  const items = (await getAllVaultItems())
    .filter((it) => (it.lang || "zh") === lang && keys.has(it.id) && !isMastered(it));
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
    _masteredSet = new Set(items.filter(isMastered).map((i) => i.id));
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
  const id = word;
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
    context: pair ? { hanzi: pair.hanzi || pair.target || "", target: pair.target || "", english: pair.english || "" } : null,
    createdAt: Date.now(),
    attempts: [],
  });
  _masteredDirty = true;
  refineMeaning(id);   // background — fetch the true dictionary meaning
  return { ok: true };
}

export async function removeWord(hanzi) {
  if (!hanzi) return;
  await deleteVaultItem(hanzi.trim());
  _masteredDirty = true;
}

export async function isWordSaved(hanzi) {
  if (!hanzi) return false;
  return !!(await getVaultItem(hanzi.trim()));
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
    const fresh = await getVaultItem(id);
    if (!fresh) return;
    fresh.english = meaning;
    fresh.meaningRefined = true;
    await putVaultItem(fresh);
  } catch { /* keep the story gloss */ }
}

// ── Vault screen ──
const BUCKET_LABEL = { new: "New", learning: "Learning", mastered: "Mastered" };

export async function openVault() {
  const lang = getLearningLanguage();
  const items = (await getAllVaultItems()).filter((it) => (it.lang || "zh") === lang);
  const counts = { new: 0, learning: 0, mastered: 0 };
  for (const it of items) counts[bucketOf(it)]++;
  $("vault-new").textContent = counts.new;
  $("vault-learning").textContent = counts.learning;
  $("vault-mastered").textContent = counts.mastered;
  $("vault-start").disabled = items.length === 0;

  const list = $("vault-list");
  const empty = $("vault-empty");
  list.innerHTML = "";
  if (!items.length) { empty.hidden = false; return; }
  empty.hidden = true;
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const it of items) {
    const b = bucketOf(it);
    const li = document.createElement("li");
    li.className = "vault-row";
    li.innerHTML = `
      <div class="vault-word">
        <div class="vault-hanzi">${escape(it.hanzi)}</div>
        <div class="vault-pinyin">${escape(it.pinyin)}</div>
        <div class="vault-english">${escape(it.english)}</div>
      </div>
      <span class="vault-status vault-status-${b}">${BUCKET_LABEL[b]} · ${masteryPct(it)}%</span>
      <button class="vault-del" aria-label="Remove">×</button>`;
    li.querySelector(".vault-del").addEventListener("click", async () => {
      if (!confirm(`Remove “${it.hanzi}” from your Memory Vault?`)) return;
      await removeWord(it.id);
      openVault();
    });
    list.appendChild(li);
  }
}

// ── Quiz setup sheet ──
async function openQuizSetup() {
  const s = await getSettings();
  $("review-answer-mode").value = s.reviewAnswerMode || "mix";
  $("review-direction").value = s.reviewDirection || "mix";
  const buckets = s.reviewBuckets || ["new", "learning"];
  for (const btn of document.querySelectorAll("#quiz-setup .bucket-toggle")) {
    btn.classList.toggle("on", buckets.includes(btn.dataset.bucket));
  }
  const length = s.reviewLength || "20";
  for (const btn of document.querySelectorAll("#quiz-setup .length-toggle")) {
    btn.classList.toggle("on", btn.dataset.len === length);
  }
  const script = s.reviewScript || "both";
  for (const btn of document.querySelectorAll("#quiz-setup .script-toggle")) {
    btn.classList.toggle("on", btn.dataset.script === script);
  }
  // Language-aware setup: name the language in the direction options, and hide
  // the pinyin/characters choice for languages with a single written form.
  const lang = getLearningLanguage();
  const lname = languageName(lang);
  $("dir-opt-t2e").textContent = `${lname} → English`;
  $("dir-opt-e2t").textContent = `English → ${lname}`;
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

async function beginQuiz() {
  const s = await getSettings();
  const buckets = s.reviewBuckets || ["new", "learning"];
  if (!buckets.length) { $("quiz-setup-note").textContent = "Pick at least one group to include."; return; }
  const lang = getLearningLanguage();
  const all = (await getAllVaultItems()).filter((it) => (it.lang || "zh") === lang);
  const pool = all.filter((it) => buckets.includes(bucketOf(it)));
  if (!pool.length) { $("quiz-setup-note").textContent = "No saved words in the selected groups yet."; return; }

  const length = s.reviewLength || "20";
  const mode = length === "endless" ? "endless" : "fixed";
  let queue = null, total = 0;
  if (length === "all") { queue = shuffle(pool.slice()); total = queue.length; }
  else if (mode === "fixed") { total = parseInt(length, 10) || 20; }

  quiz = {
    mode, length, queue, total, answered: 0, correct: 0, pool, lastId: null,
    distractors: all,
    answerMode: s.reviewAnswerMode || "mix", direction: s.reviewDirection || "mix",
    script: lang === "zh" ? (s.reviewScript || "both") : "hanzi", lang, current: null,
  };
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
 * due words), using the learner's saved answer/direction/script preferences.
 */
export async function startQuizWithItems(items, { title = "" } = {}) {
  if (!items?.length) return;
  const s = await getSettings();
  const lang = items[0].lang || getLearningLanguage();
  const all = (await getAllVaultItems()).filter((it) => (it.lang || "zh") === lang);
  const queue = shuffle(items.slice());
  quiz = {
    mode: "fixed", length: "all", queue, total: queue.length, answered: 0, correct: 0,
    pool: queue, lastId: null, distractors: all, title,
    answerMode: s.reviewAnswerMode || "mix", direction: s.reviewDirection || "mix",
    script: lang === "zh" ? (s.reviewScript || "both") : "hanzi", lang, current: null,
  };
  showQuiz();
}

/** Today's review: the words that are due, most in need first (max 20). */
export async function startDailyReview() {
  const lang = getLearningLanguage();
  const due = (await getAllVaultItems()).filter((it) => (it.lang || "zh") === lang && isDue(it));
  due.sort((a, b) => weightFor(b) - weightFor(a));
  await startQuizWithItems(due.slice(0, 20), { title: "Daily review" });
}

// The Chinese side of a card rendered in the chosen script.
function chineseStr(item, script) {
  if (script === "pinyin") return item.pinyin || item.hanzi;
  if (script === "both") return item.pinyin ? `${item.hanzi} · ${item.pinyin}` : item.hanzi;
  return item.hanzi;
}
// The "answer" text for a card: English (t2e) or the word in the chosen script
// (e2t, and cloze — where the missing word is the answer).
const answerText = (item, dir, script) => (dir === "t2e" ? item.english : chineseStr(item, script));

// ── Fill-in-the-sentence (cloze) ──
// Blank the word out of the sentence it was saved from. Returns the HTML lines
// to show for the chosen script, or null if the word can't be found in them.
function blankOut(sentence, word) {
  if (!sentence || !word) return null;
  const i = sentence.toLowerCase().indexOf(word.toLowerCase());
  if (i < 0) return null;
  return `${escape(sentence.slice(0, i))}<span class="cloze-gap">${"＿".repeat(Math.min(Math.max([...word].length, 2), 4))}</span>${escape(sentence.slice(i + word.length))}`;
}
function clozeLines(item, script) {
  const c = item.context;
  if (!c) return null;
  const isZh = (item.lang || "zh") === "zh" && !!item.pinyin;
  const lines = [];
  if (!isZh) {
    const l = blankOut(c.target || c.hanzi, item.hanzi);
    if (l) lines.push({ html: l, cls: "" });
  } else {
    if (script !== "pinyin") { const l = blankOut(c.hanzi, item.hanzi); if (l) lines.push({ html: l, cls: "is-hanzi" }); }
    if (script !== "hanzi") { const l = blankOut(c.target, item.pinyin); if (l) lines.push({ html: l, cls: "is-pinyin" }); }
  }
  return lines.length ? lines : null;
}

function renderCard() {
  let item;
  if (quiz.length === "all") item = quiz.queue[quiz.answered];
  else item = pickWeighted(quiz.pool, quiz.lastId);
  if (!item) return endQuiz();
  quiz.lastId = item.id;

  const script = quiz.script;
  const cloze = clozeLines(item, script);
  let dir = quiz.direction;
  if (dir === "mix") {
    const dirs = cloze ? ["t2e", "e2t", "cloze"] : ["t2e", "e2t"];
    dir = dirs[Math.floor(Math.random() * dirs.length)];
  }
  if (dir === "cloze" && !cloze) dir = "e2t";   // no usable sentence for this word
  let mode = quiz.answerMode === "mix" ? (Math.random() < 0.5 ? "choice" : "type") : quiz.answerMode;
  if (mode === "choice" && (quiz.distractors || quiz.pool).length < 4) mode = "type";   // need distractors
  quiz.current = { item, dir, mode, script };

  $("review-progress-text").textContent = quiz.mode === "endless" ? `${quiz.answered} answered` : `${quiz.answered + 1} / ${quiz.total}`;
  $("review-finish").hidden = quiz.mode !== "endless";
  $("review-prompt-label").textContent = dir === "t2e" ? "What does this mean?"
    : dir === "cloze" ? "Fill in the missing word" : "How do you say this?";

  // Prompt: for Chinese→English, show the Chinese in the chosen script (with the
  // pinyin as a sub-line in "both"). For English→Chinese, show the English.
  const promptEl = $("review-prompt");
  const subEl = $("review-prompt-sub");
  subEl.hidden = true; subEl.textContent = "";
  if (dir === "cloze") {
    promptEl.className = "review-prompt is-sentence";
    promptEl.innerHTML = cloze.map((l) => `<div class="cloze-line ${l.cls}">${l.html}</div>`).join("")
      + (item.context.english ? `<div class="cloze-en">${escape(item.context.english)}</div>` : "");
  } else if (dir === "t2e") {
    if (script === "pinyin") { promptEl.textContent = item.pinyin || item.hanzi; promptEl.className = "review-prompt"; }
    else { promptEl.textContent = item.hanzi; promptEl.className = "review-prompt is-hanzi";
           if (script === "both" && item.pinyin) { subEl.textContent = item.pinyin; subEl.hidden = false; } }
  } else {
    promptEl.textContent = item.english; promptEl.className = "review-prompt";
  }

  const area = $("review-answer-area");
  area.innerHTML = ""; area.hidden = false;
  $("review-reveal").hidden = true; $("review-reveal").innerHTML = "";
  $("review-next").hidden = true;

  if (mode === "choice") renderChoices(item, dir, area, script);
  else renderType(item, dir, area, script);
}

function renderChoices(item, dir, area, script) {
  const correct = answerText(item, dir, script);
  const others = shuffle((quiz.distractors || quiz.pool).filter((w) => w.id !== item.id));
  const distractors = [];
  for (const w of others) {
    const t = answerText(w, dir, script);
    if (t && t !== correct && !distractors.includes(t)) distractors.push(t);
    if (distractors.length === 3) break;
  }
  for (const opt of shuffle([correct, ...distractors])) {
    const b = document.createElement("button");
    b.className = "review-choice";
    b.textContent = opt;
    b.addEventListener("click", () => onAnswer(opt === correct, correct));
    area.appendChild(b);
  }
}

const norm = (s) => String(s || "").toLowerCase().replace(/[\s,.!?;:'"()\[\]，。！？；：、]/g, "").trim();
const stripTones = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
function gradeType(input, item, dir) {
  const given = norm(input);
  if (!given) return false;
  if (dir === "t2e") {   // (cloze and e2t both expect the word itself)
    // Lenient: any listed sense counts (senses are semicolon-separated).
    const senses = String(item.english || "").split(/[;,/]/).map(norm).filter(Boolean);
    return senses.some((s) => s === given || s.includes(given) || given.includes(s));
  }
  const han = norm(item.hanzi);
  const py = stripTones(norm(item.pinyin));
  const g = stripTones(given);
  // For languages like French the headword itself is Latin script, so also accept
  // it without accents (eg. "ecole" for "école").
  return given === han || g === stripTones(han) || (py && (g === py || py.includes(g) || g.includes(py)));
}

function renderType(item, dir, area, script) {
  const form = document.createElement("form");
  form.className = "review-type";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = dir === "t2e" ? "Type the English…"
    : dir === "cloze" && quiz.lang !== "zh" ? "Type the missing word…"
    : (quiz.lang === "zh" ? "Type the Chinese (hanzi or pinyin)…" : `Type the ${languageName(quiz.lang)}…`);
  input.autocomplete = "off"; input.autocapitalize = "off"; input.spellcheck = false;
  const submit = document.createElement("button");
  submit.type = "submit"; submit.className = "btn-primary"; submit.textContent = "Check";
  form.appendChild(input); form.appendChild(submit);
  form.addEventListener("submit", (e) => { e.preventDefault(); onAnswer(gradeType(input.value, item, dir), answerText(item, dir, script)); });
  area.appendChild(form);
  setTimeout(() => input.focus(), 120);
}

async function onAnswer(correct, correctText) {
  const { item, mode } = quiz.current;
  const area = $("review-answer-area");
  if (mode === "choice") {
    for (const b of area.querySelectorAll(".review-choice")) {
      b.disabled = true;
      if (b.textContent === correctText) b.classList.add("correct");
      else b.classList.add(correct ? "dim" : "wrong");
    }
  } else {
    const form = area.querySelector("form");
    if (form) { form.querySelector("input").disabled = true; form.querySelector("button").disabled = true; form.classList.add(correct ? "correct" : "wrong"); }
  }
  quiz.answered++;
  if (correct) quiz.correct++;
  recordAttempt(item, correct);
  await putVaultItem(item);
  _masteredDirty = true;
  bumpActivity({ answers: 1 }).catch(() => {});
  renderReveal(item, correct);
  const next = $("review-next");
  next.hidden = false;
  next.textContent = (quiz.mode !== "endless" && quiz.answered >= quiz.total) ? "Finish" : "Next";
}

function renderReveal(item, correct) {
  const el = $("review-reveal");
  el.hidden = false;
  el.innerHTML = `
    <div class="reveal-verdict ${correct ? "ok" : "no"}">${correct ? "Correct" : "Not quite"}</div>
    <div class="reveal-hanzi">${escape(item.hanzi)}</div>
    <div class="reveal-pinyin">${escape(item.pinyin)}</div>
    <div class="reveal-english">${escape(item.english)}</div>
    ${item.context && item.context.hanzi ? `<div class="reveal-context">${escape(item.context.hanzi)}<span>${escape(item.context.english)}</span></div>` : ""}
    <div class="reveal-audio-row">
      <button id="reveal-audio" class="pop-act">▶ Hear it</button>
      ${item.context && item.context.hanzi ? `<button id="reveal-audio-sentence" class="pop-act">▶ Hear sentence</button>` : ""}
    </div>`;
  el.querySelector("#reveal-audio").addEventListener("click", () => speakWord(item.hanzi, item.lang || "zh"));
  el.querySelector("#reveal-audio-sentence")?.addEventListener("click", () => speakWord(item.context.hanzi, item.lang || "zh"));
}

function nextCard() {
  if (!quiz) return;
  if (quiz.mode !== "endless" && quiz.answered >= quiz.total) return endQuiz();
  if (quiz.length === "all" && quiz.answered >= quiz.queue.length) return endQuiz();
  renderCard();
}

function endQuiz() {
  const done = $("review-done");
  $("review-card").hidden = true;
  done.hidden = false;
  const acc = quiz && quiz.answered ? Math.round((quiz.correct / quiz.answered) * 100) : 0;
  done.innerHTML = `
    <p class="empty-title">${quiz?.title ? `${escape(quiz.title)} complete` : "Quiz complete"}</p>
    <p class="empty-sub">${quiz ? quiz.correct : 0} / ${quiz ? quiz.answered : 0} correct (${acc}%)</p>
    <button class="btn-primary" id="review-done-btn">Done</button>`;
  // Back to wherever the quiz was started from (vault, home, or the reader).
  done.querySelector("#review-done-btn").addEventListener("click", () => window.dispatchEvent(new CustomEvent("app:back")));
  window.dispatchEvent(new CustomEvent("vault:changed"));
  quiz = null;
}

export async function initVault() {
  await ensureMastered();
  window.addEventListener("vault:changed", () => { _masteredDirty = true; });
  // Re-render the vault for the newly chosen language (if it's the open view).
  window.addEventListener("language:changed", () => {
    if (document.body.getAttribute("data-view") === "vault") openVault();
  });
  $("vault-start")?.addEventListener("click", openQuizSetup);
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
