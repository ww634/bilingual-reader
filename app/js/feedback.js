// Reader feedback: "this translation is wrong", "the pinyin here is off", …
//
// Highlight words → ‹ › → Feedback opens a short form. Each report is saved on
// the phone first (so nothing is lost offline), then sent to a PRIVATE GitHub
// repository as an issue, with everything needed to find and fix the spot: the
// book, chapter, sentence(s), their English and word-by-word glosses, the
// script shown and the app version. Unsent reports are retried when the app
// opens, comes back online, or from Settings.
//
// Settings hold the repository ("owner/name") and a fine-grained token limited
// to Issues on that one repository. The token never leaves this device except
// to api.github.com, and isn't included in backups.

import { getSettings, putFeedback, getAllFeedback } from "./db.js";
import { APP_VERSION } from "./version.js";
import { languageName } from "./languages.js";

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const KINDS = [
  { id: "translation", label: "Translation" },
  { id: "pinyin", label: "Pinyin / characters" },
  { id: "words", label: "Word grouping" },
  { id: "audio", label: "Audio" },
  { id: "other", label: "Something else" },
];
const kindLabel = (id) => KINDS.find((k) => k.id === id)?.label || id;

let draft = null;   // { selection, kind }

// ── The form ──
export function openFeedback(selection) {
  draft = { selection, kind: "translation" };
  const isZh = selection.language === "zh";
  $("feedback-quote").innerHTML = `
    <div class="fb-quote-main">${escape(selection.shown || selection.hanzi)}</div>
    ${isZh && selection.hanzi && selection.hanzi !== selection.shown ? `<div class="fb-quote-sub">${escape(selection.hanzi)}</div>` : ""}
    ${isZh && selection.pinyin && selection.pinyin !== selection.shown ? `<div class="fb-quote-sub">${escape(selection.pinyin)}</div>` : ""}
    ${selection.pairs?.length ? `<div class="fb-quote-en">${escape(selection.pairs.map((p) => p.english).join(" "))}</div>` : ""}`;
  const kinds = $("feedback-kinds");
  kinds.innerHTML = KINDS
    .filter((k) => isZh || k.id !== "pinyin")
    .map((k) => `<button class="chip${k.id === draft.kind ? " on" : ""}" data-kind="${k.id}">${k.label}</button>`).join("");
  kinds.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
    draft.kind = b.dataset.kind;
    kinds.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b));
  }));
  $("feedback-text").value = "";
  setStatus("");
  $("feedback-send").disabled = false;
  $("feedback-backdrop").hidden = false;
  const sheet = $("feedback-sheet");
  sheet.hidden = false;
  void sheet.offsetHeight;
  sheet.classList.add("open");
  setTimeout(() => $("feedback-text").focus(), 250);
}

function closeSheet() {
  const sheet = $("feedback-sheet");
  sheet.classList.remove("open");
  $("feedback-text").blur();
  setTimeout(() => { sheet.hidden = true; $("feedback-backdrop").hidden = true; }, 240);
}

function setStatus(text, cls = "") {
  const el = $("feedback-status");
  el.textContent = text;
  el.className = `story-status ${cls}`;
  el.hidden = !text;
}

async function submit() {
  if (!draft) return;
  const message = $("feedback-text").value.trim();
  if (!message) { setStatus("Add a few words about what's wrong.", "error"); return; }
  $("feedback-send").disabled = true;
  const item = {
    id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    kind: draft.kind,
    message,
    selection: draft.selection,
    appVersion: APP_VERSION,
    status: "pending",
  };
  await putFeedback(item);
  const result = await send(item);
  if (result === "sent") {
    setStatus("Thanks! Feedback sent.", "ok");
  } else if (result === "no-setup") {
    setStatus("Saved on this phone. Set up feedback in Settings to send it.", "busy");
  } else {
    setStatus("Saved on this phone. It'll be sent when you're back online.", "busy");
  }
  window.dispatchEvent(new CustomEvent("feedback:changed"));
  setTimeout(closeSheet, result === "sent" ? 900 : 1800);
  draft = null;
}

// ── Sending (GitHub Issues) ──
function issueTitle(item) {
  const sel = item.selection || {};
  const words = (sel.hanzi || sel.shown || "").replace(/\s+/g, " ").slice(0, 40);
  const where = [sel.bookId, sel.chapterId].filter(Boolean).join(" ");
  return `[${kindLabel(item.kind)}] ${where}${words ? ` · “${words}”` : ""}`;
}

function issueBody(item) {
  const sel = item.selection || {};
  const lines = [
    item.message,
    "",
    "---",
    `**Kind:** ${kindLabel(item.kind)}`,
    `**Book / chapter:** \`${sel.bookId || "?"}\` / \`${sel.chapterId || "?"}\`${sel.chapterTitle ? ` (${sel.chapterTitle})` : ""}`,
    `**Language:** ${languageName(sel.language)} · shown as ${sel.script || "text"}`,
    `**Highlighted:** ${sel.shown || ""}`,
  ];
  if (sel.hanzi && sel.hanzi !== sel.shown) lines.push(`**Characters:** ${sel.hanzi}`);
  if (sel.pinyin && sel.pinyin !== sel.shown) lines.push(`**Pinyin:** ${sel.pinyin}`);
  for (const p of sel.pairs || []) {
    lines.push("", `**Sentence ${p.index}** (pairs[${p.index}])`, "");
    if (p.hanzi) lines.push(`- ${p.hanzi}`);
    lines.push(`- ${p.target}`, `- ${p.english}`);
    if (p.words) lines.push(`- Words: ${p.words}`);
  }
  lines.push("", `<sub>App v${item.appVersion} · ${item.createdAt} · id ${item.id}</sub>`);
  return lines.join("\n");
}

/** Try to send one report. Returns "sent" | "no-setup" | "offline" | "failed". */
async function send(item) {
  const s = await getSettings();
  const repo = (s.feedbackRepo || "").trim();
  const token = (s.feedbackToken || "").trim();
  if (!repo || !token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return "no-setup";
  if (!navigator.onLine) return "offline";
  const post = (labels) => fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: issueTitle(item), body: issueBody(item), ...(labels ? { labels } : {}) }),
  });
  try {
    let res = await post(["feedback", item.kind]);
    if (res.status === 422) res = await post(null);   // labels refused — send without them
    if (!res.ok) {
      item.lastError = `HTTP ${res.status}`;
      await putFeedback(item);
      return "failed";
    }
    const issue = await res.json();
    item.status = "sent";
    item.sentAt = new Date().toISOString();
    item.issue = { number: issue.number, url: issue.html_url };
    delete item.lastError;
    await putFeedback(item);
    return "sent";
  } catch (err) {
    item.lastError = err.message;
    await putFeedback(item);
    return "failed";
  }
}

let _flushing = false;
/** Send every unsent report. Returns { sent, waiting, setup } for Settings. */
export async function flushFeedback() {
  if (_flushing) return null;
  _flushing = true;
  try {
    const pending = (await getAllFeedback()).filter((f) => f.status !== "sent");
    let sent = 0, setup = true;
    for (const item of pending) {
      const r = await send(item);
      if (r === "sent") sent++;
      if (r === "no-setup") { setup = false; break; }
      if (r === "offline") break;
    }
    if (sent) window.dispatchEvent(new CustomEvent("feedback:changed"));
    return { sent, waiting: pending.length - sent, setup };
  } finally {
    _flushing = false;
  }
}

/** Summary + recent reports, for the Settings screen. */
export async function feedbackSummary() {
  const all = (await getAllFeedback()).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return { all, sent: all.filter((f) => f.status === "sent").length, waiting: all.filter((f) => f.status !== "sent").length };
}

export function initFeedback() {
  $("feedback-close")?.addEventListener("click", closeSheet);
  $("feedback-backdrop")?.addEventListener("click", closeSheet);
  $("feedback-send")?.addEventListener("click", submit);
  window.addEventListener("online", () => flushFeedback());
  window.addEventListener("view:changed", () => { if (!$("feedback-sheet").hidden) closeSheet(); });
  setTimeout(() => flushFeedback(), 4000);   // retry anything left from last time
}
