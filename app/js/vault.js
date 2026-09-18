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

import { getSettings, putSettings, putVaultItem, getVaultItem, getAllVaultItems, deleteVaultItem } from "./db.js";
import { speakWord } from "./speech.js";

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
  return item;
}

// ── Mastered set for the reader's auto-hide ──
let _masteredSet = new Set();
let _masteredDirty = true;
async function refreshMastered() {
  try {
    const items = await getAllVaultItems();
    _masteredSet = new Set(items.filter(isMastered).map((i) => i.hanzi));
  } catch { _masteredSet = new Set(); }
  _masteredDirty = false;
}
export function getMasteredHanziSync() { return _masteredSet; }
export async function ensureMastered() { if (_masteredDirty) await refreshMastered(); return _masteredSet; }

// ── Save / remove ──
export async function saveWord(chunk, chapter) {
  const hanzi = (chunk?.hanzi || "").trim();
  if (!hanzi || chunk.chunkIdx == null) return { ok: false, reason: "not-a-word" };
  const id = hanzi;
  if (await getVaultItem(id)) return { ok: true, already: true };
  const pair = chapter?.pairs?.[chunk.pairIdx];
  const storyGloss = (chunk.english || "").trim();
  await putVaultItem({
    id, hanzi,
    pinyin: chunk.pinyin || chunk.target || "",
    english: storyGloss,
    storyGloss,
    meaningRefined: false,
    category: chunk.category || null,
    frequency_band: chunk.frequency_band || null,
    lang: chapter?.language || "zh",
    context: pair ? { hanzi: pair.hanzi || "", target: pair.target || "", english: pair.english || "" } : null,
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
  const sys =
    "You are a concise Chinese-English dictionary. Given a Chinese word and the " +
    "sentence it appeared in, return the word's GENERAL dictionary meaning in " +
    "English — NOT merely how it was translated in that one sentence. Include the " +
    "common distinct senses, separated by semicolons (e.g. 有 → \"to have; there " +
    'is/are; to exist"). Keep each sense short. For verb-complement compounds or ' +
    'resultatives give the full meaning (e.g. 吃完 → "to finish eating"). Output ' +
    "ONLY the meaning text — no pinyin, no Chinese characters, no examples, no quotes.";
  const usr = `Word: ${item.hanzi}\nPinyin: ${item.pinyin}\nIn-sentence translation used: ${item.storyGloss || item.english}\nSentence: ${item.context?.hanzi || ""}`;
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
  const items = await getAllVaultItems();
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
  const all = await getAllVaultItems();
  const pool = all.filter((it) => buckets.includes(bucketOf(it)));
  if (!pool.length) { $("quiz-setup-note").textContent = "No saved words in the selected groups yet."; return; }

  const length = s.reviewLength || "20";
  const mode = length === "endless" ? "endless" : "fixed";
  let queue = null, total = 0;
  if (length === "all") { queue = shuffle(pool.slice()); total = queue.length; }
  else if (mode === "fixed") { total = parseInt(length, 10) || 20; }

  quiz = {
    mode, length, queue, total, answered: 0, correct: 0, pool, lastId: null,
    answerMode: s.reviewAnswerMode || "mix", direction: s.reviewDirection || "mix",
    script: s.reviewScript || "both", current: null,
  };
  closeQuizSetup();
  $("review-card").hidden = false;
  $("review-done").hidden = true;
  window.dispatchEvent(new CustomEvent("app:setview", { detail: "review" }));
  renderCard();
}

// The Chinese side of a card rendered in the chosen script.
function chineseStr(item, script) {
  if (script === "pinyin") return item.pinyin || item.hanzi;
  if (script === "both") return item.pinyin ? `${item.hanzi} · ${item.pinyin}` : item.hanzi;
  return item.hanzi;
}
// The "answer" text for a card: English (t2e) or Chinese in the chosen script (e2t).
const answerText = (item, dir, script) => (dir === "t2e" ? item.english : chineseStr(item, script));

function renderCard() {
  let item;
  if (quiz.length === "all") item = quiz.queue[quiz.answered];
  else item = pickWeighted(quiz.pool, quiz.lastId);
  if (!item) return endQuiz();
  quiz.lastId = item.id;

  const dir = quiz.direction === "mix" ? (Math.random() < 0.5 ? "t2e" : "e2t") : quiz.direction;
  let mode = quiz.answerMode === "mix" ? (Math.random() < 0.5 ? "choice" : "type") : quiz.answerMode;
  if (mode === "choice" && quiz.pool.length < 4) mode = "type";   // need distractors
  const script = quiz.script;
  quiz.current = { item, dir, mode, script };

  $("review-progress-text").textContent = quiz.mode === "endless" ? `${quiz.answered} answered` : `${quiz.answered + 1} / ${quiz.total}`;
  $("review-finish").hidden = quiz.mode !== "endless";
  $("review-prompt-label").textContent = dir === "t2e" ? "What does this mean?" : "How do you say this?";

  // Prompt: for Chinese→English, show the Chinese in the chosen script (with the
  // pinyin as a sub-line in "both"). For English→Chinese, show the English.
  const promptEl = $("review-prompt");
  const subEl = $("review-prompt-sub");
  subEl.hidden = true; subEl.textContent = "";
  if (dir === "t2e") {
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
  const others = shuffle(quiz.pool.filter((w) => w.id !== item.id));
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
  if (dir === "t2e") {
    // Lenient: any listed sense counts (senses are semicolon-separated).
    const senses = String(item.english || "").split(/[;,/]/).map(norm).filter(Boolean);
    return senses.some((s) => s === given || s.includes(given) || given.includes(s));
  }
  const han = norm(item.hanzi);
  const py = stripTones(norm(item.pinyin));
  const g = stripTones(given);
  return given === han || g === py || (py && (py.includes(g) || g.includes(py)));
}

function renderType(item, dir, area, script) {
  const form = document.createElement("form");
  form.className = "review-type";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = dir === "t2e" ? "Type the English…" : "Type the Chinese (hanzi or pinyin)…";
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
    <button id="reveal-audio" class="pop-act">▶ Hear it</button>`;
  el.querySelector("#reveal-audio").addEventListener("click", () => speakWord(item.hanzi, item.lang || "zh"));
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
    <p class="empty-title">Quiz complete</p>
    <p class="empty-sub">${quiz ? quiz.correct : 0} / ${quiz ? quiz.answered : 0} correct (${acc}%)</p>
    <button class="btn-primary" id="review-done-btn">Back to Vault</button>`;
  done.querySelector("#review-done-btn").addEventListener("click", () => window.dispatchEvent(new CustomEvent("app:setview", { detail: "vault" })));
  quiz = null;
}

export async function initVault() {
  await ensureMastered();
  $("vault-start")?.addEventListener("click", openQuizSetup);
  $("quiz-setup-close")?.addEventListener("click", closeQuizSetup);
  $("quiz-setup-backdrop")?.addEventListener("click", closeQuizSetup);
  $("quiz-begin")?.addEventListener("click", beginQuiz);
  $("review-next")?.addEventListener("click", nextCard);
  $("review-finish")?.addEventListener("click", endQuiz);

  $("review-answer-mode")?.addEventListener("change", async (e) => { await putSettings({ ...(await getSettings()), reviewAnswerMode: e.target.value }); });
  $("review-direction")?.addEventListener("change", async (e) => { await putSettings({ ...(await getSettings()), reviewDirection: e.target.value }); });

  for (const btn of document.querySelectorAll("#quiz-setup .bucket-toggle")) {
    btn.addEventListener("click", async () => {
      btn.classList.toggle("on");
      const buckets = [...document.querySelectorAll("#quiz-setup .bucket-toggle.on")].map((b) => b.dataset.bucket);
      await putSettings({ ...(await getSettings()), reviewBuckets: buckets });
    });
  }
  for (const btn of document.querySelectorAll("#quiz-setup .length-toggle")) {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("#quiz-setup .length-toggle").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      await putSettings({ ...(await getSettings()), reviewLength: btn.dataset.len });
    });
  }
  for (const btn of document.querySelectorAll("#quiz-setup .script-toggle")) {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("#quiz-setup .script-toggle").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      await putSettings({ ...(await getSettings()), reviewScript: btn.dataset.script });
    });
  }
}
