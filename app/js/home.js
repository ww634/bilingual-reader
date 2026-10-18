// Home "Today" panel: continue reading, daily streak, and today's review.
//
// Everything here is derived from data other modules already keep: reading
// progress (reader), the activity record (pages turned / answers given per day),
// and the Memory Vault (due words). Re-rendered whenever Home is shown.

import { getAllBooks, getAllProgress, getActivity, dayKey } from "./db.js";
import { getLearningLanguage } from "./languages.js";
import { vaultStats, startDailyReview } from "./vault.js";

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let _coverUrl = null;   // object URL of the continue-card cover (revoked on re-render)
let _rendering = false;

// ── Continue reading ──
async function lastRead(lang) {
  const books = new Map((await getAllBooks()).filter((b) => b.language === lang).map((b) => [b.id, b]));
  let best = null;
  for (const { key, value } of await getAllProgress()) {
    const cut = key.indexOf("/");
    const bookId = key.slice(0, cut), chapterId = key.slice(cut + 1);
    const book = books.get(bookId);
    if (!book || !value?.updatedAt) continue;
    if (!best || value.updatedAt > best.updatedAt) best = { book, chapterId, updatedAt: value.updatedAt };
  }
  if (!best) return null;
  const idx = best.book.chapters.findIndex((c) => c.id === best.chapterId);
  return { ...best, chapterIndex: idx, chapter: best.book.chapters[idx] };
}

async function renderContinue(lang) {
  const card = $("home-continue");
  const r = await lastRead(lang);
  if (_coverUrl) { URL.revokeObjectURL(_coverUrl); _coverUrl = null; }
  if (!r || r.chapterIndex < 0) { card.hidden = true; return; }
  if (r.book.coverBlob) _coverUrl = URL.createObjectURL(r.book.coverBlob);
  const chTitle = r.chapter?.title?.english || r.chapterId;
  card.innerHTML = `
    <div class="continue-cover">${_coverUrl ? `<img src="${_coverUrl}" alt="" />` : ""}</div>
    <div class="continue-text">
      <span class="continue-label">Continue reading</span>
      <span class="continue-title">${escape(r.book.title?.english || r.book.id)}</span>
      <span class="continue-sub">Chapter ${r.chapterIndex + 1} · ${escape(chTitle)}</span>
    </div>
    <span class="continue-play" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
    </span>`;
  card.onclick = () => window.dispatchEvent(new CustomEvent("nav:reader", { detail: { bookId: r.book.id, chapterId: r.chapterId } }));
  card.hidden = false;
}

// ── Streak + this week ──
const active = (d) => !!d && ((d.pages || 0) > 0 || (d.answers || 0) > 0);

function streakFrom(days) {
  const d = new Date();
  // Today not done yet doesn't break the streak — count back from yesterday.
  if (!active(days[dayKey(d)])) d.setDate(d.getDate() - 1);
  let n = 0;
  while (active(days[dayKey(d)])) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function renderStreak(days) {
  const today = days[dayKey()] || {};
  const streak = streakFrom(days);
  $("home-streak").textContent = String(streak);
  const parts = [];
  if (today.pages) parts.push(`${today.pages} page${today.pages === 1 ? "" : "s"} read`);
  if (today.answers) parts.push(`${today.answers} answer${today.answers === 1 ? "" : "s"}`);
  $("home-today-stats").textContent = parts.length
    ? `Today: ${parts.join(" · ")}`
    : streak ? "Read or review today to keep your streak going" : "Read a page or review a few words to start a streak";

  // Last 7 days, oldest first.
  const week = $("home-week");
  const letters = ["S", "M", "T", "W", "T", "F", "S"];
  let html = "";
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const on = active(days[dayKey(d)]);
    html += `<span class="week-day${on ? " on" : ""}${i === 0 ? " today" : ""}"><i></i>${letters[d.getDay()]}</span>`;
  }
  week.innerHTML = html;
}

// ── Today's review ──
async function renderReview(lang) {
  const stats = await vaultStats(lang);
  const btn = $("home-review");
  const sub = $("home-review-sub");
  if (!stats.total) {
    btn.hidden = true;
    sub.textContent = "Save words while you read to start daily reviews.";
    return;
  }
  btn.hidden = false;
  if (stats.due) {
    const n = Math.min(stats.due, 20);
    btn.disabled = false;
    btn.textContent = `Review ${n} word${n === 1 ? "" : "s"}`;
    sub.textContent = stats.due > 20
      ? `${stats.due} words are due, so today's set is the 20 that need it most.`
      : `${stats.due} of your ${stats.total} saved words ${stats.due === 1 ? "is" : "are"} due.`;
  } else {
    btn.disabled = true;
    btn.textContent = "All caught up";
    sub.textContent = `Nothing due right now. ${stats.mastered} of ${stats.total} words mastered.`;
  }
}

export async function renderHome() {
  if (_rendering) return;
  _rendering = true;
  try {
    const lang = getLearningLanguage();
    const activity = await getActivity();
    renderStreak(activity.days);
    await Promise.all([renderContinue(lang), renderReview(lang)]);
  } catch (err) {
    console.warn("Home render failed:", err);
  } finally {
    _rendering = false;
  }
}

export function initHome() {
  $("home-review")?.addEventListener("click", () => startDailyReview());
  window.addEventListener("view:changed", (e) => { if (e.detail === "home") renderHome(); });
  window.addEventListener("language:changed", () => {
    if (document.body.getAttribute("data-view") === "home") renderHome();
  });
  // Coming back to the app (e.g. the next morning) — refresh due counts/streak.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && document.body.getAttribute("data-view") === "home") renderHome();
  });
}
