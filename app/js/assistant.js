// Language Assistant: a slide-up chat panel, always reachable from a button in
// the reader. It answers ONLY Chinese-language / language-learning questions
// (the system prompt refuses anything else). Uses the same OpenAI key as the
// tap-to-learn "See explanation" feature (stored locally in Settings).
//
// The user can highlight text in the book and, from a floating toolbar, either
// see an explanation, add the selection as context for a question, or copy it.
// The book stays visible and interactive above the panel, so more context can
// be added mid-conversation.

import { getSettings } from "./db.js";

const $ = (id) => document.getElementById(id);

// A conversational tutor benefits from a bit more capability than the one-shot
// popover explainer (gpt-5.4-nano). Change here if you want a cheaper/pricier
// model — it uses the same API key.
const ASSISTANT_MODEL = "gpt-5.4-mini";

// The assistant follows the language of the book it was opened from. Map the
// book's language code (from the chapter/library metadata) to a display name
// and any script/pronunciation guidance worth giving. Unknown codes fall back
// to a generic phrasing so the assistant still works for any language.
const LANGUAGES = {
  zh: { name: "Mandarin Chinese", pron: "Always give pinyin with tone marks for any Chinese you mention, and show the Chinese characters too when it helps (the reader is learning to read them)." },
  ja: { name: "Japanese", pron: "Give readings in hiragana/katakana and rōmaji, and show the kanji when relevant." },
  ko: { name: "Korean", pron: "Show Hangul and a Revised-Romanization reading." },
  es: { name: "Spanish", pron: "Note stress and accent marks where useful." },
  fr: { name: "French", pron: "Note pronunciation, liaisons, and accents where useful." },
  de: { name: "German", pron: "Note gender, cases, and pronunciation where useful." },
  it: { name: "Italian", pron: "" },
  pt: { name: "Portuguese", pron: "" },
  ru: { name: "Russian", pron: "Show Cyrillic and a romanized reading, and mark the stressed syllable." },
  ar: { name: "Arabic", pron: "Show the Arabic script and a romanized reading; note that short vowels are usually unwritten." },
  hi: { name: "Hindi", pron: "Show Devanagari and a romanized reading." },
};

function langMeta(code) {
  return LANGUAGES[String(code || "").toLowerCase()] || { name: "the language of this book", pron: "" };
}

function buildSystemPrompt(code) {
  const { name, pron } = langMeta(code);
  return (
    `You are a friendly, expert ${name} tutor embedded in a bilingual reading app ` +
    `for an English speaker who is learning ${name}. You ONLY help with the ${name} ` +
    `language and learning it: vocabulary, meaning, translation, pronunciation, ` +
    `grammar, writing system, usage, nuance, synonyms, and explaining ${name} text ` +
    `the reader is reading. If the user asks about anything NOT related to ${name} or ` +
    `language learning (general knowledge, coding, maths, news, personal advice, ` +
    `unrelated topics, etc.), politely decline in one sentence and invite a ${name} ` +
    `question instead — do not answer the off-topic part. Keep answers concise and ` +
    `learner-friendly. Write your explanations in English. ` +
    (pron ? pron + " " : "") +
    `Use short example sentences where useful. Plain text, minimal markdown.`
  );
}

// In-memory per-session state (cleared on reload — fine for a reading session).
let history = [];              // [{ role, content }] sent to the API
let pendingContext = [];       // book snippets the user attached for the NEXT message
let lastSelectionText = "";    // most recent non-empty selection inside the reader
let busy = false;
let greeted = false;
let currentLang = "";          // language code of the currently open book
let currentBookId = "";        // scopes the conversation to one book

function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ── Panel open/close ──

function openPanel() {
  document.body.classList.add("assistant-open");
  $("assistant-backdrop").hidden = false;
  const panel = $("assistant-panel");
  panel.hidden = false;
  void panel.offsetHeight; // force layout so the transition fires
  panel.classList.add("open");
  if (!greeted) {
    const name = langMeta(currentLang).name;
    renderMessage("assistant",
      `Hi! I'm your language assistant for ${name}. Ask me anything — a word, a sentence, grammar, pronunciation. Highlight text in the book and tap “Ask Assistant” to bring it in as context.`);
    greeted = true;
  }
  renderContextChips();
  setTimeout(() => $("assistant-text").focus(), 260);
}

function closePanel() {
  const panel = $("assistant-panel");
  panel.classList.remove("open");
  document.body.classList.remove("assistant-open");
  setTimeout(() => {
    panel.hidden = true;
    $("assistant-backdrop").hidden = true;
  }, 240);
}

function isOpen() {
  return !$("assistant-panel").hidden;
}

// ── Context chips ──

function addContext(text) {
  const t = (text || "").trim();
  if (!t) return;
  pendingContext.push(t);
  if (isOpen()) renderContextChips();
}

function renderContextChips() {
  const wrap = $("assistant-context");
  wrap.innerHTML = "";
  if (pendingContext.length === 0) { wrap.hidden = true; return; }
  wrap.hidden = false;
  pendingContext.forEach((text, i) => {
    const chip = document.createElement("span");
    chip.className = "assist-chip";
    const label = document.createElement("span");
    label.className = "assist-chip-text";
    label.textContent = text.length > 40 ? text.slice(0, 40) + "…" : text;
    const x = document.createElement("button");
    x.className = "assist-chip-x";
    x.setAttribute("aria-label", "Remove context");
    x.textContent = "×";
    x.addEventListener("click", () => { pendingContext.splice(i, 1); renderContextChips(); });
    chip.appendChild(label);
    chip.appendChild(x);
    wrap.appendChild(chip);
  });
}

// ── Messages ──

function renderMessage(role, text, contexts) {
  const list = $("assistant-messages");
  const msg = document.createElement("div");
  msg.className = `assist-msg assist-${role}`;
  if (Array.isArray(contexts) && contexts.length) {
    const ctx = document.createElement("div");
    ctx.className = "assist-msg-context";
    ctx.textContent = contexts.map((c) => `“${c}”`).join("\n");
    msg.appendChild(ctx);
  }
  const body = document.createElement("div");
  body.className = "assist-msg-body";
  body.textContent = text;
  msg.appendChild(body);
  list.appendChild(msg);
  list.scrollTop = list.scrollHeight;
  return body;
}

async function send(text, { auto = false } = {}) {
  const question = (text || "").trim();
  if (!question || busy) return;

  const contexts = pendingContext.slice();
  pendingContext = [];
  renderContextChips();

  // Compose the API user message (context + question), but show them separately.
  const apiContent = contexts.length
    ? `The user highlighted this from the book they're reading:\n"""\n${contexts.join("\n---\n")}\n"""\n\nQuestion: ${question}`
    : question;

  if (!auto) $("assistant-text").value = "";
  renderMessage("user", question, contexts);

  const settings = await getSettings();
  if (!settings.openaiKey) {
    renderMessage("assistant", "Add your OpenAI API key in Settings to use the assistant. (It's stored only on this device.)");
    return;
  }
  if (!navigator.onLine) {
    renderMessage("assistant", "Offline — connect to the internet to ask the assistant.");
    return;
  }

  busy = true;
  $("assistant-send").disabled = true;
  const bodyEl = renderMessage("assistant", "…");
  bodyEl.parentElement.classList.add("loading");

  history.push({ role: "user", content: apiContent });

  const isNewFamily = /^gpt-5|^o1|^o3/i.test(ASSISTANT_MODEL);
  const payload = {
    model: ASSISTANT_MODEL,
    messages: [{ role: "system", content: buildSystemPrompt(currentLang) }, ...history.slice(-12)],
    [isNewFamily ? "max_completion_tokens" : "max_tokens"]: 900,
  };
  if (!isNewFamily) payload.temperature = 0.4;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.openaiKey}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content?.trim() || "(no response)";
    history.push({ role: "assistant", content: answer });
    bodyEl.textContent = answer;
  } catch (err) {
    bodyEl.textContent = `Couldn't reach the assistant:\n${err.message}`;
    history.pop(); // drop the unanswered user turn so retries stay clean
  } finally {
    bodyEl.parentElement.classList.remove("loading");
    busy = false;
    $("assistant-send").disabled = false;
  }
}

// ── Selection toolbar ──

function readerSelectionText() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const pages = $("reader-pages");
  if (!pages) return null;
  // Selection must touch the reader content. Check the anchor/focus nodes
  // directly (contains() accepts text nodes) — commonAncestorContainer can
  // resolve above #reader-pages for a block-spanning selection and give a
  // false negative.
  const within =
    (sel.anchorNode && pages.contains(sel.anchorNode)) ||
    (sel.focusNode && pages.contains(sel.focusNode));
  if (!within) return null;
  const text = sel.toString().trim();
  return text ? { text, rect: sel.getRangeAt(0).getBoundingClientRect() } : null;
}

function positionToolbar(rect) {
  const bar = $("sel-toolbar");
  bar.hidden = false;
  const bw = bar.offsetWidth || 220;
  const bh = bar.offsetHeight || 40;
  let left = rect.left + rect.width / 2 - bw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
  // Prefer above the selection; drop below if there isn't room.
  let top = rect.top - bh - 8;
  if (top < 8) top = rect.bottom + 8;
  bar.style.left = `${Math.round(left)}px`;
  bar.style.top = `${Math.round(top)}px`;
}

function hideToolbar() {
  $("sel-toolbar").hidden = true;
}

function onSelectionChange() {
  // Don't fight the panel's own text field selection.
  if (document.activeElement === $("assistant-text")) return;
  const found = readerSelectionText();
  if (!found) { hideToolbar(); return; }
  lastSelectionText = found.text;
  positionToolbar(found.rect);
}

// ── Wiring ──

function resetConversation() {
  history = [];
  pendingContext = [];
  greeted = false;
  const list = $("assistant-messages");
  if (list) list.innerHTML = "";
  renderContextChips();
}

export function initAssistant() {
  // Follow the language of whichever book is opened; start a fresh conversation
  // when the book changes (a different book may be a different language).
  window.addEventListener("reader:opened", (e) => {
    const { language, bookId } = e.detail || {};
    currentLang = language || "";
    if (bookId && bookId !== currentBookId) {
      currentBookId = bookId;
      resetConversation();
      if (!$("assistant-panel").hidden) closePanel();
    }
  });

  $("assistant-fab")?.addEventListener("click", openPanel);
  $("assistant-close")?.addEventListener("click", closePanel);
  $("assistant-backdrop")?.addEventListener("click", closePanel);

  const form = $("assistant-form");
  form?.addEventListener("submit", (e) => { e.preventDefault(); send($("assistant-text").value); });

  const textEl = $("assistant-text");
  textEl?.addEventListener("keydown", (e) => {
    // Enter sends; Shift+Enter makes a newline.
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(textEl.value); }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) closePanel();
  });

  // Selection toolbar: track selection changes (debounced), reposition on scroll.
  let selTimer = null;
  document.addEventListener("selectionchange", () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(onSelectionChange, 120);
  });
  $("reader-pages")?.addEventListener("scroll", hideToolbar, { passive: true });

  const bar = $("sel-toolbar");
  // Use pointerdown + preventDefault so tapping a button doesn't clear the
  // selection before we read it.
  bar?.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    e.preventDefault();
    const act = btn.dataset.act;
    const text = lastSelectionText;
    hideToolbar();
    if (!text) return;
    if (act === "copy") {
      navigator.clipboard?.writeText(text).catch(() => {});
      window.getSelection()?.removeAllRanges();
    } else if (act === "ask") {
      addContext(text);
      openPanel();
    } else if (act === "explain") {
      addContext(text);
      openPanel();
      // Give the panel a tick to open, then auto-ask for an explanation.
      setTimeout(() => send("Explain this: pronunciation (pinyin + tones), meaning, and any grammar notes.", { auto: true }), 300);
    }
  });
}
