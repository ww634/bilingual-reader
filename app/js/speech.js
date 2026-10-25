import { requestAI } from "./ai-request.js";
// Word/sentence pronunciation.
//
// Primary: OpenAI's text-to-speech (natural, human-like), using the same API
// key as the rest of the app. Fetched audio is cached persistently (Cache API)
// AND in a bounded memory cache. Evicted clips may need fetching again.
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

export function decodedAudioCount() { return _bufferCache.size; }

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

/** Resume audio inside a tap so sound started later (after an await) may play. */
export function unlockAudio() { ensureCtx(); }

function cacheKey(text, code, variant = "normal") {
  // Same-origin relative URL used purely as a Cache API key. TTS_REV busts the
  // cache when the delivery instructions change.
  const rev = variant === "slow" ? `${TTS_REV}s` : TTS_REV;
  return `tts-cache/${rev}/${TTS_MODEL}/${TTS_VOICE}/${encodeURIComponent(code)}/${encodeURIComponent(text)}`;
}

const AUDIO_LIMIT_ENTRIES = 64;
const AUDIO_LIMIT_BYTES = 12 * 1024 * 1024;
const AUDIO_INDEX = new URL("../tts-cache/index.json", import.meta.url).href;
let _audioQueue = Promise.resolve();
let _audioEpoch = 0;

async function readAudioIndex(cache) {
  const saved = await cache.match(AUDIO_INDEX);
  if (saved) { try { const entries = await saved.json(); if (Array.isArray(entries)) return entries; } catch {} }
  const entries = [];
  for (const request of await cache.keys()) {
    if (request.url === AUDIO_INDEX) continue;
    const response = await cache.match(request);
    entries.push({ key: request.url, bytes: Number(response.headers.get("content-length")) || (await response.arrayBuffer()).byteLength, plays: 0, used: 0 });
  }
  return entries;
}
function withAudioCache(action) {
  const execute = async () => {
    const cache = await caches.open(TTS_CACHE), entries = await readAudioIndex(cache);
    const result = await action(cache, entries);
    entries.sort((a, b) => a.plays - b.plays || a.used - b.used);
    let bytes = entries.reduce((n, e) => n + e.bytes, 0);
    while (entries.length > AUDIO_LIMIT_ENTRIES || bytes > AUDIO_LIMIT_BYTES) {
      const victim = entries.shift(); await cache.delete(victim.key); bytes -= victim.bytes;
    }
    await cache.put(AUDIO_INDEX, new Response(JSON.stringify(entries), { headers: { "Content-Type": "application/json" } }));
    return result ?? { entries: entries.length, bytes, maxEntries: AUDIO_LIMIT_ENTRIES, maxBytes: AUDIO_LIMIT_BYTES, decoded: _bufferCache.size };
  };
  const run = () => navigator.locks?.request ? navigator.locks.request("reader-audio-cache", execute) : execute();
  const job = _audioQueue.then(run, run); _audioQueue = job.catch(() => {}); return job;
}
async function noteAudioUse(key, bytes = null, played = false) {
  const url = new URL(key, new URL("../", import.meta.url)).href;
  return withAudioCache(async (cache, entries) => {
    let entry = entries.find(e => e.key === url);
    if (!entry && bytes != null) { entry = { key: url, bytes, plays: 0, used: 0 }; entries.push(entry); }
    if (entry) { entry.used = Date.now(); if (played) entry.plays++; }
  }).catch(() => {});
}
async function getCachedBytes(key) {
  try {
    const cache = await caches.open(TTS_CACHE), response = await cache.match(key);
    if (response) { const bytes = await response.arrayBuffer(); await noteAudioUse(key, bytes.byteLength); return bytes; }
  } catch { /* Cache API unavailable */ }
  return null;
}
async function putCachedBytes(key, bytes, epoch) {
  if (epoch !== _audioEpoch || bytes.byteLength > AUDIO_LIMIT_BYTES) return;
  try {
    const url = new URL(key, new URL("../", import.meta.url)).href;
    await withAudioCache(async (cache, entries) => {
      if (epoch !== _audioEpoch) return;
      await cache.put(url, new Response(bytes, { headers: { "Content-Type": "audio/mpeg", "Content-Length": String(bytes.byteLength) } }));
      const prior = entries.find(e => e.key === url);
      if (prior) { prior.bytes = bytes.byteLength; prior.used = Date.now(); }
      else entries.push({ key: url, bytes: bytes.byteLength, plays: 0, used: Date.now() });
    });
  } catch { /* Playback can continue without persistent storage. */ }
}
export async function audioCacheInfo() {
  try { return await withAudioCache(async () => {}); }
  catch { return { entries: 0, bytes: 0, maxEntries: AUDIO_LIMIT_ENTRIES, maxBytes: AUDIO_LIMIT_BYTES, decoded: _bufferCache.size }; }
}
export async function clearAudioCache() {
  _audioEpoch++; _bufferCache.clear(); _inflight.clear(); stopSpeaking();
  await _audioQueue;
  const clear = async () => { for (const name of await caches.keys()) if (name.startsWith("tts-audio")) await caches.delete(name); };
  if (navigator.locks?.request) await navigator.locks.request("reader-audio-cache", clear); else await clear();
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
  return requestAI("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  }, { audio: true, label: "AI voice", retry: () => speakWord(text, code) });

}

const _inflight = new Map();   // key -> Promise<AudioBuffer|null>, so prefetch + play share one request

/**
 * Decoded audio for `text`: memory → persistent cache → OpenAI. Resolves null
 * when OpenAI isn't usable (no key / offline), so the caller can fall back to
 * the system voice. Rejects if the request itself fails.
 */
async function getBuffer(ctx, text, code, variant = "normal", played = false) {
  const epoch = _audioEpoch;
  const key = cacheKey(text, code, variant);
  if (_bufferCache.has(key)) {
    const buffer = _bufferCache.get(key);
    _bufferCache.delete(key); _bufferCache.set(key, buffer);
    if (played) noteAudioUse(key, null, true);
    return buffer;
  }
  if (_inflight.has(key)) { const buffer = await _inflight.get(key); if (played && buffer) noteAudioUse(key, null, true); return buffer; }
  const job = (async () => {
    let bytes = await getCachedBytes(key);
    if (!bytes) {
      const settings = await getSettings().catch(() => ({}));
      if (!settings.openaiKey || !navigator.onLine) return null;
      bytes = await fetchTtsBytes(text, code, variant, settings.openaiKey);
      await putCachedBytes(key, bytes, epoch);
    }
    // decodeAudioData detaches the ArrayBuffer, so decode a copy.
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    if (epoch === _audioEpoch) _bufferCache.set(key, buffer);
    while (_bufferCache.size > 24) _bufferCache.delete(_bufferCache.keys().next().value);
    return buffer;
  })();
  _inflight.set(key, job);
  try { const buffer = await job; if (played && buffer) noteAudioUse(key, null, true); return buffer; } finally { _inflight.delete(key); }
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
      try { buffer = await getBuffer(ctx, t, code, slow ? "slow" : "normal", true); }
      catch (err) { if(err.code === "cancelled") return finish(); console.warn("TTS failed, using system voice:", err.message); }
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
    const buffer = await getBuffer(ctx, t, code, "normal", true);
    if (buffer) {
      if (onState) onState("playing");
      playBuffer(ctx, buffer);
    } else {
      if (onState) onState("fallback");
      speak(t, code);
    }
  } catch (err) {
    if(err.code === "cancelled") return;
    console.warn("TTS failed, using system voice:", err.message);
    if (onState) onState("fallback");
    speak(t, code); // graceful fallback
  } finally {
    if (onState) onState("idle");
  }
}
