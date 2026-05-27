// Tap-to-learn popover: opens when the user taps a colored chunk in the
// reader. Shows pre-baked info (pinyin, English, POS, frequency, context
// sentence) instantly. The "See explanation" button calls OpenAI with the
// user's API key (stored in Settings) for a richer explanation.

import { getSettings } from "./db.js";

const $ = (id) => document.getElementById(id);

const CATEGORY_LABELS = {
  noun: "Noun",
  verb: "Verb",
  adjective: "Adjective",
  adverb: "Adverb",
  grammar: "Grammar",
  idiom: "Idiom",
  proper_noun: "Proper noun",
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
  $("popover-english").textContent = chunkData.english || "";

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
        <div>${escape(pair.target)}</div>
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
    "You are a concise Mandarin Chinese tutor. Given a word/phrase (pinyin with tone marks) and the sentence it appears in, give a short, learner-friendly explanation under 200 words. Cover: literal meaning, nuance/usage notes, and 1-2 short example sentences (pinyin only — no Chinese characters — followed by English in parentheses). Plain text only, no markdown.";

  const userPrompt =
    `Word/phrase: ${chunk.target}\n` +
    `English equivalent: ${chunk.english || "(none)"}\n` +
    `Part of speech: ${chunk.category || "(unspecified)"}\n` +
    (chunk.is_idiom ? `This is a fixed expression / idiom.\n` : "") +
    (contextPinyin ? `\nSentence in the book (pinyin): ${contextPinyin}\nSentence in the book (English): ${contextEnglish}\n` : "");

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
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

export function initPopover() {
  $("popover-close").addEventListener("click", closePopover);
  $("popover-backdrop").addEventListener("click", closePopover);
  $("pop-act-explain").addEventListener("click", fetchExplanation);
  $("pop-act-save").addEventListener("click", () => {
    // Memory Vault feature is deferred.
    alert("Memory Vault is coming in a later version.");
  });
  $("pop-act-hear").addEventListener("click", () => {
    // Pronunciation feature is deferred.
    alert("Pronunciation playback is coming in a later version.");
  });
  // Allow Escape to close.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("popover").hidden) closePopover();
  });
}
