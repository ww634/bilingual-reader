// Memory Vault: save words from the reader and review them with spaced
// repetition. Correct/wrong is auto-graded (multiple-choice or type-in), so we
// use a simple Leitner scheme — a right answer promotes the word to a longer
// interval, a wrong answer sends it back. Once a word reaches the "mastered"
// box, the reader stops showing its English (see reader.js).
//
// Everything is local (IndexedDB). Review audio reuses the cached TTS.

import { getSettings, putSettings, putVaultItem, getVaultItem, getAllVaultItems, deleteVaultItem } from "./db.js";
import { speakWord } from "./speech.js";

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── Spaced-repetition (Leitner) ──
const DAY = 86400000;
const BOX_INTERVAL = [0, 1 * DAY, 3 * DAY, 7 * DAY, 16 * DAY, 35 * DAY, 90 * DAY];
const MAX_BOX = BOX_INTERVAL.length - 1;
const MASTERED_BOX = 4;      // ≈16-day interval — several spaced correct answers
const SESSION_MAX = 20;      // cards per review session

function newSrs() { return { box: 0, due: Date.now(), reps: 0, lapses: 0, last: null }; }
function schedule(srs, correct) {
  const s = { ...(srs || newSrs()) };
  s.reps += 1;
  s.last = Date.now();
  if (correct) s.box = Math.min(MAX_BOX, s.box + 1);
  else { s.box = 0; s.lapses += 1; }
  s.due = Date.now() + BOX_INTERVAL[s.box];
  return s;
}
const isMastered = (item) => (item?.srs?.box || 0) >= MASTERED_BOX;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Mastered-word set (for the reader's auto-hide) ──
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

// ── Save a word from the tap-to-learn popover ──
// Returns { ok, already?, reason? }.
export async function saveWord(chunk, chapter) {
  const hanzi = (chunk?.hanzi || "").trim();
  // Only aligned words carry a clean per-word hanzi (uncovered taps fall back to
  // the whole sentence, which isn't a flashcard).
  if (!hanzi || chunk.chunkIdx == null) return { ok: false, reason: "not-a-word" };
  const id = hanzi;
  const existing = await getVaultItem(id);
  if (existing) return { ok: true, already: true };
  const pair = chapter?.pairs?.[chunk.pairIdx];
  await putVaultItem({
    id, hanzi,
    pinyin: chunk.pinyin || chunk.target || "",
    english: (chunk.english || "").trim(),
    category: chunk.category || null,
    frequency_band: chunk.frequency_band || null,
    lang: chapter?.language || "zh",
    context: pair ? { hanzi: pair.hanzi || "", target: pair.target || "", english: pair.english || "" } : null,
    createdAt: Date.now(),
    srs: newSrs(),
  });
  _masteredDirty = true;
  return { ok: true };
}

export async function isWordSaved(hanzi) {
  if (!hanzi) return false;
  return !!(await getVaultItem(hanzi.trim()));
}

// ── Vault screen ──
export async function openVault() {
  const items = await getAllVaultItems();
  const now = Date.now();
  const mastered = items.filter(isMastered).length;
  const due = items.filter((i) => (i.srs?.due ?? 0) <= now).length;
  $("vault-due").textContent = due;
  $("vault-learning").textContent = items.length - mastered;
  $("vault-mastered").textContent = mastered;
  $("vault-start").disabled = items.length === 0;
  $("vault-start").textContent = due > 0 ? `Review ${Math.min(due, SESSION_MAX)} due` : (items.length ? "Review ahead" : "Nothing saved yet");

  const s = await getSettings();
  $("review-answer-mode").value = s.reviewAnswerMode || "mix";
  $("review-direction").value = s.reviewDirection || "mix";

  const list = $("vault-list");
  const empty = $("vault-empty");
  list.innerHTML = "";
  if (!items.length) { empty.hidden = false; return; }
  empty.hidden = true;
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const it of items) {
    const li = document.createElement("li");
    li.className = "vault-row";
    const status = isMastered(it) ? "mastered" : (it.srs?.reps ? "learning" : "new");
    li.innerHTML = `
      <div class="vault-word">
        <div class="vault-hanzi">${escape(it.hanzi)}</div>
        <div class="vault-pinyin">${escape(it.pinyin)}</div>
        <div class="vault-english">${escape(it.english)}</div>
      </div>
      <span class="vault-status vault-status-${status}">${status}</span>
      <button class="vault-del" aria-label="Remove">×</button>`;
    li.querySelector(".vault-del").addEventListener("click", async () => {
      await deleteVaultItem(it.id);
      _masteredDirty = true;
      openVault();
    });
    list.appendChild(li);
  }
}

// ── Review engine ──
let review = null;

async function startReview() {
  const all = await getAllVaultItems();
  if (!all.length) return;
  const now = Date.now();
  let due = all.filter((i) => (i.srs?.due ?? 0) <= now);
  if (!due.length) due = all.slice();          // nothing due → let them review ahead
  shuffle(due);
  due = due.slice(0, SESSION_MAX);
  const s = await getSettings();
  review = {
    queue: due, idx: 0, correct: 0, total: due.length, allWords: all,
    answerMode: s.reviewAnswerMode || "mix", direction: s.reviewDirection || "mix", current: null,
  };
  $("review-card").hidden = false;
  $("review-done").hidden = true;
  window.dispatchEvent(new CustomEvent("app:setview", { detail: "review" }));
  renderCard();
}

const answerText = (item, dir) => (dir === "t2e" ? item.english : item.hanzi);

function renderCard() {
  const item = review.queue[review.idx];
  const dir = review.direction === "mix" ? (Math.random() < 0.5 ? "t2e" : "e2t") : review.direction;
  let mode = review.answerMode === "mix" ? (Math.random() < 0.5 ? "choice" : "type") : review.answerMode;
  if (mode === "choice" && review.allWords.length < 4) mode = "type"; // need distractors
  review.current = { item, dir, mode };

  $("review-progress-text").textContent = `${review.idx + 1} / ${review.total}`;
  $("review-prompt-label").textContent = dir === "t2e" ? "What does this mean?" : "How do you say this?";
  $("review-prompt").textContent = dir === "t2e" ? item.hanzi : item.english;
  $("review-prompt").className = "review-prompt" + (dir === "t2e" ? " is-hanzi" : "");

  const area = $("review-answer-area");
  area.innerHTML = "";
  area.hidden = false;
  $("review-reveal").hidden = true;
  $("review-reveal").innerHTML = "";
  $("review-next").hidden = true;

  if (mode === "choice") renderChoices(item, dir, area);
  else renderType(item, dir, area);
}

function renderChoices(item, dir, area) {
  const correct = answerText(item, dir);
  const others = shuffle(review.allWords.filter((w) => w.id !== item.id));
  const distractors = [];
  for (const w of others) {
    const t = answerText(w, dir);
    if (t && t !== correct && !distractors.includes(t)) distractors.push(t);
    if (distractors.length === 3) break;
  }
  const options = shuffle([correct, ...distractors]);
  for (const opt of options) {
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
    const ans = norm(item.english);
    return given === ans || (ans && (ans.includes(given) || given.includes(ans)));
  }
  const han = norm(item.hanzi);
  const py = stripTones(norm(item.pinyin));
  const g = stripTones(given);
  return given === han || g === py || (py && (py.includes(g) || g.includes(py)));
}

function renderType(item, dir, area) {
  const form = document.createElement("form");
  form.className = "review-type";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = dir === "t2e" ? "Type the English…" : "Type the Chinese (hanzi or pinyin)…";
  input.autocomplete = "off"; input.autocapitalize = "off"; input.spellcheck = false;
  const submit = document.createElement("button");
  submit.type = "submit"; submit.className = "btn-primary"; submit.textContent = "Check";
  form.appendChild(input);
  form.appendChild(submit);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    onAnswer(gradeType(input.value, item, dir), answerText(item, dir));
  });
  area.appendChild(form);
  setTimeout(() => input.focus(), 120);
}

async function onAnswer(correct, correctText) {
  const { item, mode } = review.current;
  const area = $("review-answer-area");
  if (mode === "choice") {
    for (const b of area.querySelectorAll(".review-choice")) {
      b.disabled = true;
      if (b.textContent === correctText) b.classList.add("correct");
      else b.classList.add(correct ? "dim" : "wrong");
    }
  } else {
    const form = area.querySelector("form");
    if (form) {
      form.querySelector("input").disabled = true;
      form.querySelector("button").disabled = true;
      form.classList.add(correct ? "correct" : "wrong");
    }
  }
  if (correct) review.correct++;
  item.srs = schedule(item.srs, correct);
  await putVaultItem(item);
  _masteredDirty = true;
  renderReveal(item, correct);
  const next = $("review-next");
  next.hidden = false;
  next.textContent = review.idx + 1 >= review.total ? "Finish" : "Next";
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
  if (!review) return;
  review.idx++;
  if (review.idx >= review.queue.length) return endReview();
  renderCard();
}

function endReview() {
  const done = $("review-done");
  $("review-card").hidden = true;
  done.hidden = false;
  done.innerHTML = `
    <p class="empty-title">Review complete</p>
    <p class="empty-sub">${review.correct} / ${review.total} correct</p>
    <button class="btn-primary" id="review-done-btn">Back to Vault</button>`;
  done.querySelector("#review-done-btn").addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("app:setview", { detail: "vault" }));
  });
  review = null;
}

export async function initVault() {
  await ensureMastered();           // preload the mastered set for the reader
  $("vault-start")?.addEventListener("click", startReview);
  $("review-next")?.addEventListener("click", nextCard);
  $("review-answer-mode")?.addEventListener("change", async (e) => {
    await putSettings({ ...(await getSettings()), reviewAnswerMode: e.target.value });
  });
  $("review-direction")?.addEventListener("change", async (e) => {
    await putSettings({ ...(await getSettings()), reviewDirection: e.target.value });
  });
}
