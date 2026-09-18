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
import { speakWord } from "./speech.js";

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

// Conversation state. `transcript` is the single source of truth: a list of
// display records ({ role, text, contexts? }) that is BOTH rendered in the panel
// and turned into the API messages. It's persisted per book (localStorage) so
// the conversation survives closing the panel, switching chapters, and even
// relaunching the app — restored when the same book is reopened.
let transcript = [];
let pendingContext = [];       // book snippets the user attached for the NEXT message
let lastSelectionRaw = "";     // the literal selection (both languages) — used for Copy + fallback
let busy = false;
let greeted = false;
let currentLang = "";          // language code of the currently open book
let currentBookId = "";        // scopes the conversation to one book

const STORE_PREFIX = "bilingual-reader.assistant.";
const MAX_STORED = 80;         // cap persisted turns so storage stays small

function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ── Persistence (per book) ──

function saveConversation() {
  if (!currentBookId) return;
  try {
    localStorage.setItem(STORE_PREFIX + currentBookId, JSON.stringify(transcript.slice(-MAX_STORED)));
  } catch { /* storage full / unavailable — non-fatal */ }
}

function loadConversation(bookId) {
  transcript = [];
  try {
    const raw = localStorage.getItem(STORE_PREFIX + bookId);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) transcript = parsed;
  } catch { /* ignore corrupt / unavailable storage */ }
  greeted = transcript.length > 0;   // don't greet over a restored conversation
  pendingContext = [];
  renderTranscript();
  renderContextChips();
}

function renderTranscript() {
  const list = $("assistant-messages");
  if (!list) return;
  list.innerHTML = "";
  for (const m of transcript) renderMessage(m.role, m.text, m.contexts);
}

// Build the API message list from the transcript (plus the system prompt).
// A user turn's attached book context is folded into its content here.
function apiMessages() {
  const msgs = [{ role: "system", content: buildSystemPrompt(currentLang) }];
  for (const m of transcript.slice(-16)) {
    if (m.role === "user") {
      const content = (m.contexts && m.contexts.length)
        ? `The reader highlighted this from the book they're reading:\n"""\n${m.contexts.join("\n---\n")}\n"""\n\nQuestion: ${m.text}`
        : m.text;
      msgs.push({ role: "user", content });
    } else {
      msgs.push({ role: "assistant", content: m.text });
    }
  }
  return msgs;
}

// ── Panel open/close ──

function openPanel() {
  hideToolbar();
  $("assistant-backdrop").hidden = false;
  const panel = $("assistant-panel");
  panel.hidden = false;
  void panel.offsetHeight; // force layout so the transition fires
  panel.classList.add("open");
  if (!greeted && transcript.length === 0) {
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

  if (!auto) $("assistant-text").value = "";
  // Record + render the user turn, and persist immediately.
  transcript.push({ role: "user", text: question, contexts });
  renderMessage("user", question, contexts);
  saveConversation();

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

  const isNewFamily = /^gpt-5|^o1|^o3/i.test(ASSISTANT_MODEL);
  const payload = {
    model: ASSISTANT_MODEL,
    messages: apiMessages(),                 // full transcript → continuity
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
    transcript.push({ role: "assistant", text: answer });
    saveConversation();
    bodyEl.textContent = answer;
  } catch (err) {
    bodyEl.textContent = `Couldn't reach the assistant:\n${err.message}`;
    // Keep the user turn (persisted) so it's still visible and retryable; the
    // error bubble itself isn't stored, so it won't reappear on reload.
  } finally {
    bodyEl.parentElement.classList.remove("loading");
    busy = false;
    $("assistant-send").disabled = false;
  }
}

// ── Selection toolbar ──

// Is there a text selection inside the reader right now? Returns the Selection
// or null. Cheap — safe to call on every selectionchange. Checks the anchor/
// focus nodes directly (contains() accepts text nodes) since a block-spanning
// selection's commonAncestorContainer can resolve above #reader-pages.
function currentReaderSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const pages = $("reader-pages");
  if (!pages) return null;
  const within =
    (sel.anchorNode && pages.contains(sel.anchorNode)) ||
    (sel.focusNode && pages.contains(sel.focusNode));
  return within ? sel : null;
}

const cleanText = (s) => String(s || "").replace(/\s+/g, " ").trim();

// Target-language-only text of a selection (English gloss lines stripped).
// Each block is `<p class="target">` (pinyin/hanzi) + `<p class="english">`, so
// we clone the selected DOM and drop `.english`. Done LAZILY at action time —
// never during the drag — so the DOM cloning can't interfere with the native
// selection gesture on iOS.
function selectionTargetText(sel) {
  try {
    const holder = document.createElement("div");
    holder.appendChild(sel.getRangeAt(0).cloneContents());
    holder.querySelectorAll(".english").forEach((el) => el.remove());
    return cleanText(holder.textContent);
  } catch { return ""; }
}

// Reconstruct the HANZI of the current selection (for text-to-speech, which must
// read characters not pinyin). Every word span in the target line carries a
// data-hanzi attribute; the English line has none — so collecting data-hanzi
// from the spans the selection touches gives just the Chinese, across lines, in
// order. A partially-touched word contributes its whole character(s).
function selectionHanzi() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return "";
  const pages = $("reader-pages");
  if (!pages) return "";
  const range = sel.getRangeAt(0);
  let han = "";
  for (const el of pages.querySelectorAll("[data-hanzi]")) {
    let hit = false;
    try { hit = range.intersectsNode(el); } catch { hit = false; }
    if (hit) han += el.getAttribute("data-hanzi") || "";
  }
  return han.trim();
}

function positionToolbar(rect) {
  const bar = $("sel-toolbar");
  bar.hidden = false;
  const bw = bar.offsetWidth || 220;
  const bh = bar.offsetHeight || 40;
  let left = rect.left + rect.width / 2 - bw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
  // Prefer BELOW the selection — iOS's own callout menu (Copy / Look Up / …)
  // sits above the selection, so putting ours below keeps them from colliding.
  // Drop back above only if there isn't room below.
  let top = rect.bottom + 10;
  if (top + bh > window.innerHeight - 8) top = rect.top - bh - 10;
  bar.style.left = `${Math.round(left)}px`;
  bar.style.top = `${Math.round(top)}px`;
}

function hideToolbar() {
  $("sel-toolbar").hidden = true;
}

function onSelectionChange() {
  // Don't fight the panel's own text field selection.
  if (document.activeElement === $("assistant-text")) return;
  let sel = null;
  try { sel = currentReaderSelection(); } catch { sel = null; }
  if (!sel) { hideToolbar(); return; }
  const raw = cleanText(sel.toString());
  if (!raw) { hideToolbar(); return; }
  lastSelectionRaw = raw;
  try { positionToolbar(sel.getRangeAt(0).getBoundingClientRect()); }
  catch { hideToolbar(); }
}

// ── Wiring ──

/**
 * Open the assistant with some text attached as context (used by the tap-to-
 * learn popover's "Ask Assistant" handoff). The user then asks a follow-up and
 * the attached context rides along with it.
 */
export function askWithContext(text) {
  addContext(text);
  openPanel();
}

export function initAssistant() {
  // Follow the language of whichever book is opened, and restore that book's
  // saved conversation when the book changes.
  window.addEventListener("reader:opened", (e) => {
    const { language, bookId } = e.detail || {};
    currentLang = language || "";
    if (bookId && bookId !== currentBookId) {
      currentBookId = bookId;
      if (isOpen()) closePanel();
      loadConversation(bookId);
    }
  });

  $("assistant-btn")?.addEventListener("click", openPanel);
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
    if (act === "pronounce") {
      // Read the selection aloud in the book's language. Speak the HANZI (never
      // the displayed pinyin), with English excluded even across lines. Runs
      // inside this gesture so iOS allows the audio.
      const han = selectionHanzi();
      hideToolbar();
      if (han) speakWord(han, currentLang || "zh");
      return;
    }
    // Compute the target-only text now (pointerdown's preventDefault keeps the
    // selection alive), falling back to the raw selection if nothing's left.
    const sel = currentReaderSelection();
    const text = (sel && (selectionTargetText(sel) || cleanText(sel.toString()))) || lastSelectionRaw;
    hideToolbar();
    if (!text) return;
    addContext(text);
    openPanel();
    if (act === "explain") {
      // Give the panel a tick to open, then auto-ask for an explanation.
      setTimeout(() => send("Explain this: pronunciation (pinyin + tones), meaning, and any grammar notes.", { auto: true }), 300);
    }
  });
}
