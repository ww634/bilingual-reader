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
  fr: "Speak standard metropolitan French. Pronounce every syllable clearly, with natural liaison, elision and nasal vowels. Speak at 85% of normal conversational speed. Do not exaggerate the intonation.",
};
const TTS_INSTRUCTIONS_DEFAULT =
  "Speak clearly and naturally at a slightly slower, learner-friendly pace. Pronounce every syllable distinctly without exaggerating.";

// "slow" swaps the speed sentence for a slower pace with pauses between phrases
// (used by Listen mode). Slowing the voice itself, rather than the playback,
// keeps the pitch (and so the tones) natural.
const SLOW_PACE = "Speak slowly, at about 65% of normal conversational speed, with a brief pause between phrases.";
function ttsInstructions(code, variant = "normal") {
  const base = TTS_INSTRUCTIONS[String(code || "").toLowerCase()] || TTS_INSTRUCTIONS_DEFAULT;
  if (variant !== "slow") return base;
  const replaced = base.replace(/Speak at \d+% of normal conversational speed\./, SLOW_PACE);
  return replaced === base ? `${base} ${SLOW_PACE}` : replaced;
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

function cacheKey(text, code, variant = "normal") {
  // Same-origin relative URL used purely as a Cache API key. TTS_REV busts the
  // cache when the delivery instructions change.
  const rev = variant === "slow" ? `${TTS_REV}s` : TTS_REV;
  return `tts-cache/${rev}/${TTS_MODEL}/${TTS_VOICE}/${encodeURIComponent(code)}/${encodeURIComponent(text)}`;
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

async function fetchTtsBytes(text, code, variant, apiKey) {
  const payload = { model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: "mp3" };
  if (modelSupportsInstructions) payload.instructions = ttsInstructions(code, variant);
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${msg.slice(0, 160)}`);
  }
  return res.arrayBuffer();
}

const _inflight = new Map();   // key -> Promise<AudioBuffer|null>, so prefetch + play share one request

/**
 * Decoded audio for `text`: memory → persistent cache → OpenAI. Resolves null
 * when OpenAI isn't usable (no key / offline), so the caller can fall back to
 * the system voice. Rejects if the request itself fails.
 */
async function getBuffer(ctx, text, code, variant = "normal") {
  const key = cacheKey(text, code, variant);
  if (_bufferCache.has(key)) return _bufferCache.get(key);
  if (_inflight.has(key)) return _inflight.get(key);
  const job = (async () => {
    let bytes = await getCachedBytes(key);
    if (!bytes) {
      const settings = await getSettings().catch(() => ({}));
      if (!settings.openaiKey || !navigator.onLine) return null;
      bytes = await fetchTtsBytes(text, code, variant, settings.openaiKey);
      await putCachedBytes(key, bytes);
    }
    // decodeAudioData detaches the ArrayBuffer, so decode a copy.
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    _bufferCache.set(key, buffer);
    return buffer;
  })();
  _inflight.set(key, job);
  try { return await job; } finally { _inflight.delete(key); }
}

/** Fetch + cache a sentence ahead of time (no playback). Safe to call freely. */
export function prefetchSpeech(text, code, { slow = false } = {}) {
  const t = String(text || "").trim();
  const ctx = _ctx;   // only once audio is unlocked; never creates a context
  if (!t || !ctx) return;
  getBuffer(ctx, t, code, slow ? "slow" : "normal").catch(() => {});
}

/**
 * Play one sentence and report when it finishes — the building block for
 * Listen mode. Returns a controller immediately: { stop(), done }.
 * `onEnded` fires only when the audio finishes naturally (not after stop()).
 * The first call must happen inside a tap so iOS allows audio.
 */
export function playSpeech(text, code, { slow = false, onEnded, onState } = {}) {
  const t = String(text || "").trim();
  const ctx = ensureCtx();   // synchronously, inside the gesture
  const ctl = {
    stopped: false,
    src: null,
    system: false,
    stop() {
      ctl.stopped = true;
      try { ctl.src && ctl.src.stop(); } catch {}
      if (ctl.system) { try { window.speechSynthesis.cancel(); } catch {} }
    },
  };
  const finish = () => { if (!ctl.stopped) { ctl.stopped = true; onEnded && onEnded(); } };
  ctl.done = (async () => {
    if (!t) return finish();
    let buffer = null;
    if (ctx) {
      onState && onState("loading");
      try { buffer = await getBuffer(ctx, t, code, slow ? "slow" : "normal"); }
      catch (err) { console.warn("TTS failed, using system voice:", err.message); }
    }
    if (ctl.stopped) return;
    if (buffer) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.onended = finish;
      ctl.src = src;
      src.start(0);
      onState && onState("playing");
      return;
    }
    // System-voice fallback (no key, offline, or the request failed).
    if (!canSpeak()) return finish();
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      if (!_voices.length) refreshVoices();
      const u = new window.SpeechSynthesisUtterance(t);
      u.lang = langTag(code);
      const v = pickVoice(u.lang);
      if (v) u.voice = v;
      u.rate = slow ? 0.7 : 0.9;
      u.onend = finish;
      u.onerror = finish;
      ctl.system = true;
      synth.speak(u);
      onState && onState("fallback");
    } catch { finish(); }
  })();
  return ctl;
}

export async function speakWord(text, code, { onState } = {}) {
  const t = String(text || "").trim();
  if (!t) return;
  const ctx = ensureCtx(); // resume synchronously inside the gesture
  if (!ctx) { speak(t, code); return; }

  const key = cacheKey(t, code);
  if (!_bufferCache.has(key) && onState) onState("loading");
  try {
    const buffer = await getBuffer(ctx, t, code);
    if (buffer) {
      if (onState) onState("playing");
      playBuffer(ctx, buffer);
    } else {
      if (onState) onState("fallback");
      speak(t, code);
    }
  } catch (err) {
    console.warn("TTS failed, using system voice:", err.message);
    if (onState) onState("fallback");
    speak(t, code); // graceful fallback
  } finally {
    if (onState) onState("idle");
  }
}
