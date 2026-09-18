// Tap-to-learn popover: opens when the user taps a colored chunk in the
// reader. Shows pre-baked info (pinyin, English, POS, frequency, context
// sentence) instantly. The "See explanation" button calls OpenAI with the
// user's API key (stored in Settings) for a richer explanation.

import { getSettings } from "./db.js";
import { askWithContext } from "./assistant.js";
import { speakWord } from "./speech.js";
import { saveWord, removeWord, isWordSaved } from "./vault.js";

const $ = (id) => document.getElementById(id);

const CATEGORY_LABELS = {
  noun: "Noun",
  verb: "Verb",
  adjective: "Adjective",
  adverb: "Adverb",
  idiom: "Idiom",
  proper_noun: "Proper noun",
  measure_word: "Measure word",
  function_word: "Function word",
  particle: "Particle",
  grammar: "Grammar", // legacy alias for pre-realign chapters
};
const FREQUENCY_LABELS = {
  very_common: "Very common",
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
};

// Cache explanations in memory so a repeat tap is instant.
const explanationCache = new Map();

let _state = {
  chunk: null,      // current chunk data { target, english, category, frequency_band, is_idiom, pairIdx, chunkIdx }
  chapter: null,    // reference to chapter object for context
};

function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function cacheKey(c) {
  return `${c.target}|${c.english}`;
}

/**
 * Open the popover for a chunk. Pulls pre-baked data from the chunk and
 * the surrounding chapter context.
 */
export function openPopover(chunkData, chapter) {
  _state.chunk = chunkData;
  _state.chapter = chapter;

  // Populate pre-baked fields.
  $("popover-target").textContent = chunkData.target;

  // Secondary line: the OTHER script — Hanzi under pinyin, or pinyin under
  // Hanzi. Only for real word chunks (both scripts known); skipped for the
  // uncovered-token fallback, whose hanzi is the whole sentence.
  const secondaryEl = $("popover-secondary");
  const other = chunkData.script === "hanzi" ? chunkData.pinyin : chunkData.hanzi;
  if (chunkData.pinyin && chunkData.hanzi && other && other !== chunkData.target) {
    secondaryEl.textContent = other;
    secondaryEl.hidden = false;
  } else {
    secondaryEl.textContent = "";
    secondaryEl.hidden = true;
  }

  const englishEl = $("popover-english");
  if (chunkData.english) {
    englishEl.textContent = chunkData.english;
    englishEl.hidden = false;
  } else {
    englishEl.textContent = "(no direct translation — tap “See explanation”)";
    englishEl.hidden = false;
  }

  // Tags (category, frequency, idiom).
  const tagsEl = $("popover-tags");
  tagsEl.innerHTML = "";
  if (chunkData.category) {
    const t = document.createElement("span");
    t.className = `pop-tag cat-${chunkData.category}`;
    t.textContent = CATEGORY_LABELS[chunkData.category] || chunkData.category;
    tagsEl.appendChild(t);
  }
  if (chunkData.frequency_band) {
    const t = document.createElement("span");
    t.className = `pop-tag freq-${chunkData.frequency_band}`;
    t.textContent = FREQUENCY_LABELS[chunkData.frequency_band] || chunkData.frequency_band;
    tagsEl.appendChild(t);
  }
  if (chunkData.is_idiom) {
    const t = document.createElement("span");
    t.className = "pop-tag idiom-flag";
    t.textContent = "Idiom";
    tagsEl.appendChild(t);
  }

  // Context sentence — the pair this chunk came from.
  const contextEl = $("popover-context");
  if (chapter && Number.isFinite(chunkData.pairIdx)) {
    const pair = chapter.pairs[chunkData.pairIdx];
    if (pair) {
      contextEl.innerHTML = `
        <strong>In context</strong>
        <div>${escape(chunkData.script === "hanzi" ? (pair.hanzi || pair.target) : pair.target)}</div>
        <div style="margin-top:4px; color: var(--text-muted)">${escape(pair.english)}</div>
      `;
    } else {
      contextEl.innerHTML = "";
    }
  } else {
    contextEl.innerHTML = "";
  }

  // Reset explanation panel.
  const expEl = $("popover-explanation");
  expEl.hidden = true;
  expEl.textContent = "";

  // Reflect whether this word is already in the vault.
  refreshSaveButton(chunkData);

  // Show.
  $("popover-backdrop").hidden = false;
  $("popover").hidden = false;
}

export function closePopover() {
  $("popover").hidden = true;
  $("popover-backdrop").hidden = true;
  _state.chunk = null;
  _state.chapter = null;
}

/**
 * Call OpenAI's Chat Completions endpoint to get a richer explanation of
 * the current chunk. Renders the result into the popover.
 */
async function fetchExplanation() {
  const chunk = _state.chunk;
  if (!chunk) return;

  const expEl = $("popover-explanation");
  const btn = $("pop-act-explain");

  // Cache check.
  const key = cacheKey(chunk);
  if (explanationCache.has(key)) {
    expEl.hidden = false;
    expEl.classList.remove("loading");
    expEl.textContent = explanationCache.get(key);
    return;
  }

  const settings = await getSettings();
  if (!settings.openaiKey) {
    expEl.hidden = false;
    expEl.classList.remove("loading");
    expEl.textContent =
      "Add your OpenAI API key in Settings to enable explanations.\n\n(The key is stored only on this device.)";
    return;
  }

  if (!navigator.onLine) {
    expEl.hidden = false;
    expEl.classList.remove("loading");
    expEl.textContent = "Offline — connect to the internet to fetch an explanation.";
    return;
  }

  // Loading state.
  expEl.hidden = false;
  expEl.classList.add("loading");
  expEl.textContent = "Fetching explanation…";
  btn.disabled = true;

  const pair = _state.chapter?.pairs?.[chunk.pairIdx];
  const contextPinyin = pair ? pair.target : "";
  const contextEnglish = pair ? pair.english : "";

  const systemPrompt =
    "You are a concise Mandarin Chinese tutor for an English-speaking learner. " +
    "Write the explanation in ENGLISH. Chinese characters MUST NOT appear at all — " +
    "use pinyin only (pinyin is allowed in the Pronunciation line and the example " +
    "sentences). " +
    "Given a word/phrase (pinyin with tone marks) and the sentence it appears in, " +
    "give a short, learner-friendly explanation under 220 words with these labelled parts:\n" +
    "Pronunciation: repeat the word in pinyin with tone marks, then a plain-English " +
    "approximation of how to say it syllable-by-syllable, and name each syllable's tone " +
    "(e.g. \"lǚguǎn — roughly LYOO-gwan; lǚ = 3rd/dipping tone, guǎn = 3rd tone\"). " +
    "Mandarin pinyin spelling is unintuitive, so make the approximation genuinely helpful.\n" +
    "Meaning: the literal English meaning.\n" +
    "Word parts: if the word is made up of two or more component characters/morphemes " +
    "(very common in Chinese), break it down — list each component in pinyin with tone " +
    "marks and its own meaning, then note how they combine into the whole word. " +
    "E.g. \"shānkǒu = shān (mountain) + kǒu (mouth → opening/pass)\". " +
    "Omit this line for a single-morpheme word or a proper name.\n" +
    "Usage: nuance / usage notes in English.\n" +
    "Examples: 1–2 short example sentences in pinyin (no Chinese characters), each " +
    "followed by its English translation in parentheses.\n" +
    "Plain text only, no markdown.";

  const userPrompt =
    `Word/phrase: ${chunk.target}\n` +
    `English equivalent: ${chunk.english || "(none)"}\n` +
    `Part of speech: ${chunk.category || "(unspecified)"}\n` +
    (chunk.is_idiom ? `This is a fixed expression / idiom.\n` : "") +
    (contextPinyin ? `\nSentence in the book (pinyin): ${contextPinyin}\nSentence in the book (English): ${contextEnglish}\n` : "");

  const EXPLAIN_MODEL = "gpt-5.4-nano";
  const isNewFamily = /^gpt-5|^o1|^o3/i.test(EXPLAIN_MODEL);

  // gpt-5 family + o-series: use max_completion_tokens, omit temperature
  // (only default of 1 is accepted).
  const body = {
    model: EXPLAIN_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    [isNewFamily ? "max_completion_tokens" : "max_tokens"]: 700,
  };
  if (!isNewFamily) body.temperature = 0.3;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.openaiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || "(no content)";
    explanationCache.set(key, text);
    expEl.classList.remove("loading");
    expEl.textContent = text;
  } catch (err) {
    expEl.classList.remove("loading");
    expEl.textContent = `Couldn't fetch explanation:\n${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

/**
 * Hand this word off to the Language Assistant: attach the word, its in-context
 * sentence, and (if it's been fetched) the explanation as context, then open the
 * assistant so the user can ask follow-up questions.
 */
function askAssistantFromPopover() {
  const chunk = _state.chunk;
  if (!chunk) return;
  const pair = _state.chapter?.pairs?.[chunk.pairIdx];
  const lines = [];
  lines.push(
    `Word: ${chunk.target}` +
    (chunk.english ? ` — ${chunk.english}` : "") +
    (chunk.category ? ` (${chunk.category})` : "")
  );
  if (pair) {
    const sentence = chunk.script === "hanzi" ? (pair.hanzi || pair.target) : pair.target;
    lines.push(`Sentence: ${sentence} — ${pair.english}`);
  }
  const explanation = explanationCache.get(cacheKey(chunk));
  if (explanation) lines.push(`Explanation already given:\n${explanation}`);

  askWithContext(lines.join("\n"));
  closePopover();
}

/**
 * Speak the current word aloud with the browser's built-in TTS. Speaks the
 * Hanzi (chunk word if available, else the whole sentence) in the book's
 * language, so tones are correct — never the pinyin.
 */
async function hearPronunciation() {
  const chunk = _state.chunk;
  if (!chunk) return;
  const text = chunk.hanzi || _state.chapter?.pairs?.[chunk.pairIdx]?.hanzi || "";
  const lang = _state.chapter?.language || "zh";
  const btn = $("pop-act-hear");

  if (!text) {
    const expEl = $("popover-explanation");
    expEl.hidden = false;
    expEl.classList.remove("loading");
    expEl.textContent = "No Chinese characters available for this word to pronounce.";
    return;
  }

  const original = btn.textContent;
  btn.disabled = true;
  try {
    // Uses high-quality OpenAI TTS (cached per word), falling back to the system
    // voice automatically if that's unavailable.
    await speakWord(text, lang, {
      onState: (state) => {
        if (state === "loading") btn.textContent = "Loading…";
        else if (state === "playing") btn.textContent = "▶ Playing…";
        else if (state === "fallback") btn.textContent = "▶ Playing (basic)…";
      },
    });
  } finally {
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 600);
  }
}

// Can this word be saved to the vault? (Only aligned words carry a clean
// per-word hanzi; uncovered taps fall back to the whole sentence.)
function isSaveable(chunk) {
  return !!(chunk && chunk.hanzi && chunk.chunkIdx != null);
}

function setSaveButton(state) {
  const btn = $("pop-act-save");
  if (state === "saved") { btn.textContent = "✓ Saved"; btn.classList.add("saved"); }
  else if (state === "saving") { btn.textContent = "Saving…"; btn.classList.remove("saved"); }
  else { btn.textContent = "Save to Memory Vault"; btn.classList.remove("saved"); }
}

// Reflect the saved/not-saved state whenever the popover opens.
async function refreshSaveButton(chunk) {
  const btn = $("pop-act-save");
  if (!isSaveable(chunk)) { setSaveButton("default"); btn.disabled = false; return; }
  btn.disabled = false;
  setSaveButton((await isWordSaved(chunk.hanzi)) ? "saved" : "default");
}

/** Toggle the current word in the Memory Vault: save if new, or remove (with a
 *  confirm) if already saved. */
async function toggleSaveVault() {
  const chunk = _state.chunk;
  if (!chunk) return;
  const btn = $("pop-act-save");
  if (!isSaveable(chunk)) {
    setSaveButton("default");
    btn.textContent = "Tap a highlighted word to save";
    setTimeout(() => setSaveButton("default"), 1400);
    return;
  }
  const already = await isWordSaved(chunk.hanzi);
  if (already) {
    if (!confirm(`Remove “${chunk.hanzi}” from your Memory Vault?`)) return;
    await removeWord(chunk.hanzi);
    setSaveButton("default");
  } else {
    btn.disabled = true;
    setSaveButton("saving");
    await saveWord(chunk, _state.chapter);
    btn.disabled = false;
    setSaveButton("saved");
  }
}

export function initPopover() {
  $("popover-close").addEventListener("click", closePopover);
  $("popover-backdrop").addEventListener("click", closePopover);
  $("pop-act-explain").addEventListener("click", fetchExplanation);
  $("pop-act-ask").addEventListener("click", askAssistantFromPopover);
  $("pop-act-save").addEventListener("click", toggleSaveVault);
  $("pop-act-hear").addEventListener("click", hearPronunciation);
  // Allow Escape to close.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("popover").hidden) closePopover();
  });
}
