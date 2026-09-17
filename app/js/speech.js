// Word/sentence pronunciation.
//
// Primary: OpenAI's text-to-speech (natural, human-like), using the same API
// key as the rest of the app. Fetched audio is cached persistently (Cache API)
// AND in memory, so each unique word is paid for at most once, ever.
//
// Fallback: the browser's built-in SpeechSynthesis (free, offline, robotic) —
// used when there's no key, no network, or the TTS request fails.
//
// iOS note: audio playback must be unlocked inside the tap gesture. We use the
// Web Audio API and resume the AudioContext synchronously at the top of
// speakWord() (before any await), which keeps playback allowed after the async
// fetch completes.

import { getSettings } from "./db.js";

// ── Config (tweak here) ──
// Model options: "gpt-4o-mini-tts" (newest, natural, cheaper), "tts-1-hd"
// (high quality), "tts-1" (fastest/cheapest). Voices: alloy, echo, fable, onyx,
// nova, shimmer, coral, sage…
const TTS_MODEL = "gpt-4o-mini-tts";
const TTS_VOICE = "nova";
const TTS_CACHE = "tts-audio-v1";
// Bump when TTS_INSTRUCTIONS change, so cached audio is regenerated rather than
// replayed with the old delivery.
const TTS_REV = "2";

// Voice-steering instructions (supported by gpt-4o* TTS models). Keyed by book
// language, with a learner-friendly default. Mandarin gets clear, standard
// delivery at a slightly slower pace.
const TTS_INSTRUCTIONS = {
  zh: "Speak standard Putonghua. Pronounce every syllable clearly. Maintain natural Mandarin tone sandhi and neutral tones. Speak at 85% of normal conversational speed. Do not exaggerate tones.",
};
const TTS_INSTRUCTIONS_DEFAULT =
  "Speak clearly and naturally at a slightly slower, learner-friendly pace. Pronounce every syllable distinctly without exaggerating.";

function ttsInstructions(code) {
  return TTS_INSTRUCTIONS[String(code || "").toLowerCase()] || TTS_INSTRUCTIONS_DEFAULT;
}
const modelSupportsInstructions = /^gpt-4o/i.test(TTS_MODEL);

// ── Built-in SpeechSynthesis (fallback) ──

export function canSpeak() {
  return typeof window !== "undefined"
    && "speechSynthesis" in window
    && typeof window.SpeechSynthesisUtterance !== "undefined";
}

const LANG_TAG = {
  zh: "zh-CN", ja: "ja-JP", ko: "ko-KR", es: "es-ES", fr: "fr-FR",
  de: "de-DE", it: "it-IT", pt: "pt-PT", ru: "ru-RU", ar: "ar-SA", hi: "hi-IN",
};
export function langTag(code) {
  const c = String(code || "").toLowerCase();
  return LANG_TAG[c] || c || "zh-CN";
}

let _voices = [];
function refreshVoices() {
  try { _voices = window.speechSynthesis.getVoices() || []; } catch { _voices = []; }
}
if (canSpeak()) {
  refreshVoices();
  try { window.speechSynthesis.addEventListener("voiceschanged", refreshVoices); } catch {}
}
function pickVoice(tag) {
  const base = tag.split("-")[0].toLowerCase();
  return _voices.find((v) => v.lang && v.lang.toLowerCase() === tag.toLowerCase())
      || _voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(base))
      || null;
}

/** System-voice fallback. Returns false if unavailable. */
export function speak(text, code, { rate = 0.9 } = {}) {
  const t = String(text || "").trim();
  if (!t || !canSpeak()) return false;
  const synth = window.speechSynthesis;
  try {
    synth.cancel();
    if (!_voices.length) refreshVoices();
    const u = new window.SpeechSynthesisUtterance(t);
    u.lang = langTag(code);
    const v = pickVoice(u.lang);
    if (v) u.voice = v;
    u.rate = rate;
    synth.speak(u);
    return true;
  } catch { return false; }
}

export function stopSpeaking() {
  try { window.speechSynthesis.cancel(); } catch {}
  try { if (_currentSource) _currentSource.stop(); } catch {}
}

// ── OpenAI TTS (primary) via Web Audio ──

let _ctx = null;
let _currentSource = null;
const _bufferCache = new Map(); // key -> decoded AudioBuffer (session)

function ensureCtx() {
  try {
    if (!_ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      _ctx = new AC();
    }
    if (_ctx.state === "suspended") _ctx.resume().catch(() => {});
    return _ctx;
  } catch { return null; }
}

function cacheKey(text, code) {
  // Same-origin relative URL used purely as a Cache API key. TTS_REV busts the
  // cache when the delivery instructions change.
  return `tts-cache/${TTS_REV}/${TTS_MODEL}/${TTS_VOICE}/${encodeURIComponent(code)}/${encodeURIComponent(text)}`;
}

async function getCachedBytes(key) {
  try {
    const cache = await caches.open(TTS_CACHE);
    const res = await cache.match(key);
    if (res) return await res.arrayBuffer();
  } catch { /* Cache API unavailable */ }
  return null;
}
async function putCachedBytes(key, bytes) {
  try {
    const cache = await caches.open(TTS_CACHE);
    await cache.put(key, new Response(bytes, { headers: { "Content-Type": "audio/mpeg" } }));
  } catch { /* ignore */ }
}

function playBuffer(ctx, buffer) {
  try { if (_currentSource) _currentSource.stop(); } catch {}
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0);
  _currentSource = src;
}

async function decodeAndPlay(ctx, bytes, key) {
  // decodeAudioData detaches the ArrayBuffer, so decode a copy and keep the
  // original bytes for caching.
  const buffer = await ctx.decodeAudioData(bytes.slice(0));
  _bufferCache.set(key, buffer);
  playBuffer(ctx, buffer);
}

/**
 * Speak `text` with the best available voice: OpenAI TTS if a key is set and
 * we're online, otherwise the system voice. `code` is the book's language code.
 * `onState(state)` receives "loading" | "playing" | "fallback" | "idle".
 * MUST be called from within a user gesture (a click/tap).
 */
export async function speakWord(text, code, { onState } = {}) {
  const t = String(text || "").trim();
  if (!t) return;
  const ctx = ensureCtx(); // resume synchronously inside the gesture

  const key = cacheKey(t, code);

  // 1) In-memory decoded buffer — instant, no cost.
  if (ctx && _bufferCache.has(key)) { playBuffer(ctx, _bufferCache.get(key)); return; }

  // 2) Persistent cache — no cost.
  if (ctx) {
    const cachedBytes = await getCachedBytes(key);
    if (cachedBytes) {
      try { await decodeAndPlay(ctx, cachedBytes, key); return; } catch { /* fall through */ }
    }
  }

  // 3) Fetch from OpenAI TTS.
  const settings = await getSettings().catch(() => ({}));
  if (!ctx || !settings.openaiKey || !navigator.onLine) {
    if (onState) onState("fallback");
    speak(t, code);
    if (onState) onState("idle");
    return;
  }

  if (onState) onState("loading");
  try {
    const payload = { model: TTS_MODEL, voice: TTS_VOICE, input: t, response_format: "mp3" };
    if (modelSupportsInstructions) payload.instructions = ttsInstructions(code);
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.openaiKey}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${msg.slice(0, 160)}`);
    }
    const bytes = await res.arrayBuffer();
    await putCachedBytes(key, bytes);
    if (onState) onState("playing");
    await decodeAndPlay(ctx, bytes, key);
  } catch (err) {
    console.warn("TTS failed, using system voice:", err.message);
    if (onState) onState("fallback");
    speak(t, code); // graceful fallback
  } finally {
    if (onState) onState("idle");
  }
}
