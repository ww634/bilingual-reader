import { requestAI, friendlyError } from "./ai-request.js";
import { addKeyButton } from "./ui.js";
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
import { getSelectedSpans, clearSelection, wordHanzi, wordPinyin } from "./selection.js";
import { getReaderContext } from "./reader.js";
import { saveSentence, sentenceRange } from "./vault.js";
import { openFeedback } from "./feedback.js";

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
  zh: { name: "Mandarin Chinese", pron: "Always give pinyin with tone marks for any Chinese you mention, and show the Chinese characters too when it helps (the reader is learning to read them). Highlighted Chinese text from the book arrives as the characters followed by their pinyin in parentheses — use the characters to tell apart words that share the same pinyin." },
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
let sessions = [];
let currentSessionId = null;
let requestVersion = 0;
let requestController = null;
let pendingContext = [];       // book snippets the user attached for the NEXT message
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

function resetRequest() {
  requestController?.abort(); requestVersion++; busy = false;
  $("assistant-send").disabled = false; $("assistant-cancel").hidden = true;
}
function sessionId() { return crypto.randomUUID(); }
function renderSessions() {
  const select = $("assistant-sessions"); select.replaceChildren();
  const empty=document.createElement("option");empty.value="";empty.textContent="Past conversations";select.append(empty);
  for (const session of sessions.slice().reverse()) { const option=document.createElement("option");option.value=session.id;option.textContent=session.title;select.append(option); }
  select.value=currentSessionId || "";
}
function saveConversation() {
  if (!currentBookId) return;
  const session=sessions.find(s=>s.id===currentSessionId);
  if(session) { session.turns=transcript.slice(-MAX_STORED); const first=transcript.find(m=>m.role==='user');if(first)session.title=first.text.slice(0,54); }
  sessions=sessions.slice(-20);
  try { localStorage.setItem(STORE_PREFIX+currentBookId,JSON.stringify({schema:2,sessions})); } catch {}
  renderSessions();
}
function startSession() {
  resetRequest();
  if(currentSessionId)saveConversation();
  currentSessionId=sessionId();transcript=[];pendingContext=[];greeted=false;
  sessions.push({id:currentSessionId,title:'New conversation',createdAt:new Date().toISOString(),turns:[]});
  saveConversation();renderTranscript();renderContextChips();
}
function loadConversation(bookId) {
  resetRequest();transcript=[];sessions=[];currentSessionId=null;
  try {
    const data=JSON.parse(localStorage.getItem(STORE_PREFIX+bookId)||'null');
    if(Array.isArray(data)&&data.length)sessions=[{id:sessionId(),title:'Earlier conversation',turns:data.slice(-MAX_STORED)}];
    else if(data?.schema===2&&Array.isArray(data.sessions))sessions=data.sessions.filter(s=>typeof s.id==='string'&&Array.isArray(s.turns)).slice(-20).map(s=>({...s,turns:s.turns.filter(m=>['user','assistant'].includes(m.role)&&typeof m.text==='string').slice(-MAX_STORED)}));
  } catch {}
  pendingContext=[];greeted=false;renderTranscript();renderContextChips();renderSessions();
}
function reopenSession(id) {
  const session=sessions.find(s=>s.id===id);if(!session)return;
  resetRequest();if(currentSessionId)saveConversation();currentSessionId=id;transcript=session.turns.slice();pendingContext=[];greeted=transcript.length>0;renderTranscript();renderContextChips();renderSessions();
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
        ? `The reader highlighted this from the book they're reading:\n"""\n${m.contexts.slice(-4).map(c=>String(c).slice(0,1000)).join("\n---\n")}\n"""\n\nQuestion: ${m.text.slice(0,4000)}`
        : m.text.slice(0,4000);
      msgs.push({ role: "user", content });
    } else {
      msgs.push({ role: "assistant", content: m.text.slice(0,4000) });
    }
  }
  return msgs;
}

// ── Panel open/close ──

let closeTimer;
function openPanel() {
  clearTimeout(closeTimer);
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
  requestController?.abort();
  const panel = $("assistant-panel");
  panel.classList.remove("open");
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
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

async function send(text, { auto = false, retry = false } = {}) {
  const question=(text||'').trim().slice(0,4000);
  if(!question||busy)return;
  if(!currentSessionId)startSession();
  const token=++requestVersion, session=currentSessionId;
  const current=()=>token===requestVersion&&session===currentSessionId;
  const contexts=retry?[]:pendingContext.slice(-4);if(!retry)pendingContext=[];renderContextChips();
  if(!auto)$("assistant-text").value='';
  if(!retry){transcript.push({role:'user',text:question,contexts});renderMessage('user',question,contexts);saveConversation()}
  busy=true;requestController=new AbortController();const controller=requestController;
  $("assistant-send").disabled=true;$("assistant-cancel").hidden=false;
  let bodyEl;
  try {
    const settings=await getSettings();if(!current())return;
    if(!settings.openaiKey){bodyEl=renderMessage('assistant','Add your OpenAI key to use the assistant. It is sent directly to OpenAI for AI requests.');addKeyButton(bodyEl);return}
    if(!navigator.onLine)throw new TypeError('Offline');
    bodyEl=renderMessage('assistant','Thinking…');bodyEl.parentElement.classList.add('loading');
    const isNewFamily=/^gpt-5|^o1|^o3/i.test(ASSISTANT_MODEL);
    const payload={model:ASSISTANT_MODEL,messages:apiMessages(),[isNewFamily?'max_completion_tokens':'max_tokens']:900};if(!isNewFamily)payload.temperature=.4;
    const data=await requestAI('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${settings.openaiKey}`},body:JSON.stringify(payload)},{signal:controller.signal});
    if(!current())return;
    const answer=data.choices?.[0]?.message?.content?.trim();if(!answer)throw new Error('No answer came back. Please try again.');
    transcript.push({role:'assistant',text:answer});saveConversation();bodyEl.textContent=answer;
  } catch(error) {
    if(!current())return;
    if(!bodyEl)bodyEl=renderMessage('assistant','');bodyEl.textContent=friendlyError(error);
    const button=document.createElement('button');button.className='pop-act';button.textContent='Retry';button.onclick=()=>send(question,{auto:true,retry:true});bodyEl.append(button);
  } finally {
    bodyEl?.parentElement.classList.remove('loading');
    if(current()){busy=false;$("assistant-send").disabled=false;$("assistant-cancel").hidden=true}
  }
}

// ── Selection action bar ──
// The selection itself (highlight, handles, gestures) lives in selection.js — the
// reader draws its own so only the target-language lines are highlighted. This
// module just reads the chosen words and shows the action bar beside them.

// Chinese is written without spaces; languages like French need them between
// words (for speech and for reading).
const joinsWithoutSpaces = () => !currentLang || currentLang === "zh";

// The HANZI (target-script text) of the selection — what text-to-speech reads.
// Only target-line words are selectable, so the English gloss can never leak in.
function selectedDOMText() {
  const spans=getSelectedSpans();if(!spans.length)return '';
  const range=document.createRange();range.setStartBefore(spans[0]);range.setEndAfter(spans[spans.length-1]);
  const fragment=range.cloneContents();
  for(const el of fragment.querySelectorAll('.english,rt,.sel-hl,.listen-hl,.sel-knob'))el.remove();
  return (fragment.textContent||'').replace(/\s+/g,' ').trim();
}
function selectionHanzi() {
  if(currentLang&&currentLang!=='zh')return selectedDOMText();
  return getSelectedSpans().map(wordHanzi).join('');
}

// The pinyin of the selection (Chinese only), tidied: words spaced, no gap
// before punctuation.
function selectionPinyin() {
  const parts = getSelectedSpans().map((el) => wordPinyin(el).trim());
  return parts.join(" ").replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

// What to attach as context for the assistant. For Chinese we send BOTH the
// characters and the pinyin — different characters can share one pinyin
// spelling, so the characters are what disambiguates — formatted "他走了 (tā zǒu
// le)". Other languages send their target text.
function selectionContextText() {
  const hz = selectionHanzi();
  if (currentLang === "zh") {
    const py = selectionPinyin();
    if (hz && py && hz !== py) return `${hz} (${py})`;
  }
  return hz;
}

// Position the action bar from the selection's geometry: centred under the LAST
// selected line, below the whole block it ends in (English gloss included, so the
// bar never covers the guide text), with a caret pointing at the text. Flips
// above the selection if there's no room below.
function positionToolbar(g) {
  const bar = $("sel-toolbar");
  bar.hidden = false;
  const bw = bar.offsetWidth || 260;
  const bh = bar.offsetHeight || 56;
  const vw = window.innerWidth;
  const anchorX = Math.max(24, Math.min((g.last.left + g.last.right) / 2, vw - 24));
  const left = Math.max(8, Math.min(anchorX - bw / 2, vw - bw - 8));

  // Clear the end handle's dot (~14px below the last line) as well as the gloss.
  let top = Math.max(g.last.bottom + 22, g.blockBottom + 10);
  let above = false;
  const safeBottom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--selection-safe-bottom")) || 0;
  if (top + bh > window.innerHeight - safeBottom - 8) { top = g.first.top - bh - 22; above = true; }

  bar.classList.toggle("above", above);
  bar.style.setProperty("--caret-x", `${Math.round(Math.max(20, Math.min(anchorX - left, bw - 20)))}px`);
  bar.style.left = `${Math.round(left)}px`;
  bar.style.top = `${Math.round(Math.max(8, Math.min(top,window.innerHeight-safeBottom-bh-8)))}px`;
}

// Save the whole sentence(s) the highlight touches to the Memory Vault, as one
// item: partial highlights are widened to complete sentences.
async function saveSelectedSentences(btn) {
  const ctx = getReaderContext();
  const idx = getSelectedSpans()
    .map((el) => parseInt((el.closest("[data-pair]") || el).dataset.pair, 10))
    .filter(Number.isFinite);
  if (!ctx || !idx.length) return;
  const [lo, hi] = sentenceRange(ctx.chapter.pairs, Math.min(...idx), Math.max(...idx));
  const pairs = ctx.chapter.pairs.slice(lo, hi + 1);
  const res = await saveSentence(pairs, { ...ctx.chapter, book_id: ctx.bookId });
  const label = btn.querySelector("span");
  if (label) label.textContent = res.already ? "Already saved" : res.ok ? "Saved" : "Failed";
  setTimeout(() => {
    if (label) label.textContent = "Save";
    clearSelection();
    hideToolbar();
  }, 800);
}

function hideToolbar() {
  $("sel-toolbar").hidden = true;
}

// The bar has two pages (like iOS): Explain · Ask · Hear · Save › and ‹ Copy · Feedback.
let lastGeometry = null;
function showToolbarPage(n) {
  for (const page of document.querySelectorAll("#sel-toolbar .sel-page")) page.hidden = page.dataset.page !== String(n);
  if (lastGeometry) positionToolbar(lastGeometry);   // its width changed — re-centre
}

// Everything the feedback form needs about the highlighted words, captured now
// (the selection is cleared when the form opens).
function selectionForFeedback() {
  const ctx = getReaderContext();
  const spans = getSelectedSpans();
  const idx = spans.map((el) => parseInt((el.closest("[data-pair]") || el).dataset.pair, 10)).filter(Number.isFinite);
  const lo = idx.length ? Math.min(...idx) : null, hi = idx.length ? Math.max(...idx) : null;
  return {
    shown: selectionDisplayText(),
    hanzi: selectionHanzi(),
    pinyin: currentLang === "zh" ? selectionPinyin() : "",
    language: ctx?.language || currentLang || "",
    bookId: ctx?.bookId || null,
    chapterId: ctx?.chapterId || null,
    chapterTitle: ctx?.chapter?.title?.english || "",
    script: ctx?.script || "",
    pairs: lo === null ? [] : ctx.chapter.pairs.slice(lo, hi + 1).map((p, k) => ({
      index: lo + k,
      target: p.target,
      hanzi: p.hanzi || null,
      english: p.english,
      words: (p.alignment || []).map((a) => `${a.hanzi || a.target} = ${a.english}`).join(" · "),
    })),
  };
}

// Show the bar when a selection is settled; hide it while it's being dragged or
// once it's gone.
function onSelectionEvent(e) {
  const { active, dragging, geometry } = e.detail || {};
  if (!active || dragging || !geometry) { hideToolbar(); return; }
  // A freshly shown bar always opens on its first page.
  if ($("sel-toolbar").hidden) {
    for (const page of document.querySelectorAll("#sel-toolbar .sel-page")) page.hidden = page.dataset.page !== "1";
  }
  lastGeometry = geometry;
  positionToolbar(geometry);
}

// The selection as it appears on screen (pinyin or characters for Chinese,
// the words themselves otherwise) — what Copy puts on the clipboard.
function selectionDisplayText() {
  if(currentLang&&currentLang!=="zh")return selectedDOMText();
  // Words shown with pinyin above (ruby) copy as their characters only.
  const parts = getSelectedSpans()
    .map((el) => (el.querySelector("rt") ? wordHanzi(el) : el.textContent || "").trim())
    .filter(Boolean);
  const hasHan = parts.some((t) => /[\u3400-\u9fff]/.test(t));
  return parts.join(hasHan ? "" : " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?。，！？；：、])/g, "$1")
    .trim();
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers without the async clipboard API (or that refuse it).
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

// ── Wiring ──

/**
 * Open the assistant with some text attached as context (used by the tap-to-
 * learn popover's "Ask Assistant" handoff). The user then asks a follow-up and
 * the attached context rides along with it.
 */
export function askWithContext(text) {
  startSession();
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

  $("assistant-btn")?.addEventListener("click", () => { startSession(); openPanel(); });
  $("assistant-new").addEventListener("click", () => { startSession(); openPanel(); });
  $("assistant-sessions").addEventListener("change", e => reopenSession(e.target.value));
  $("assistant-cancel").addEventListener("click", () => requestController?.abort());
  window.addEventListener("ui:close-overlays", closePanel);
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

  // Action bar follows the reader's own selection (see selection.js).
  window.addEventListener("reader:selection", onSelectionEvent);

  const bar = $("sel-toolbar");
  // pointerdown + preventDefault so tapping a button doesn't steal focus.
  bar?.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    e.preventDefault();
    const act = btn.dataset.act;
    if (act === "copy") return;          // handled on click (Safari's clipboard rule)
    if (act === "save") { saveSelectedSentences(btn); return; }
    if (act === "more") { showToolbarPage(2); return; }
    if (act === "back") { showToolbarPage(1); return; }
    if (act === "feedback") {
      const sel = selectionForFeedback();
      clearSelection();
      hideToolbar();
      openFeedback(sel);
      return;
    }
    if (act === "pronounce") {
      // Read the selection aloud in the book's language. Speaks the HANZI (never
      // the displayed pinyin); runs inside this gesture so iOS allows the audio.
      // The selection and bar stay, so it can be replayed.
      const han = selectionHanzi();
      if (han) speakWord(han, currentLang || "zh");
      return;
    }
    const text = selectionContextText();
    clearSelection();            // dismiss the highlight + bar
    hideToolbar();
    if (!text) return;
    startSession();
    addContext(text);
    openPanel();
    if (act === "explain") {
      // Give the panel a tick to open, then auto-ask for an explanation.
      const ask = currentLang === "zh"
        ? "Explain this: pronunciation (pinyin + tones), meaning, and any grammar notes."
        : "Explain this: pronunciation, meaning, and any grammar notes.";
      send(ask, { auto: true });
    }
  });

  // Copy runs on click: Safari only allows clipboard writes from a completed tap.
  // (Save is handled on pointerdown above.)
  bar?.addEventListener("click", async (e) => {
    const btn = e.target.closest('button[data-act="copy"]');
    if (!btn) return;
    const text = selectionDisplayText();
    if (!text) return;
    const ok = await copyToClipboard(text);
    const label = btn.querySelector("span");
    if (label) label.textContent = ok ? "Copied" : "Failed";
    setTimeout(() => {
      if (label) label.textContent = "Copy";
      clearSelection();
      hideToolbar();
    }, 700);
  });
}
