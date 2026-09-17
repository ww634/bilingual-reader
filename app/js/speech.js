// Word/sentence pronunciation via the browser's built-in Web Speech API
// (SpeechSynthesis). Free, offline, no API key — it uses the device's own
// system voices (e.g. iOS's Mandarin voice). We always speak the ORIGINAL
// script (Hanzi), never pinyin, so tones come out correctly.

export function canSpeak() {
  return typeof window !== "undefined"
    && "speechSynthesis" in window
    && typeof window.SpeechSynthesisUtterance !== "undefined";
}

// Map a content-language code (from the book) to a BCP-47 tag with a sensible
// default region, so the engine picks the right voice.
const LANG_TAG = {
  zh: "zh-CN", ja: "ja-JP", ko: "ko-KR", es: "es-ES", fr: "fr-FR",
  de: "de-DE", it: "it-IT", pt: "pt-PT", ru: "ru-RU", ar: "ar-SA", hi: "hi-IN",
};
export function langTag(code) {
  const c = String(code || "").toLowerCase();
  return LANG_TAG[c] || c || "zh-CN";
}

// iOS populates the voice list asynchronously, so cache it and refresh on the
// voiceschanged event (and lazily before each utterance).
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

/**
 * Speak `text` in the given content-language code (e.g. "zh"). Cancels any
 * in-flight utterance first. Returns false if speech isn't available or there
 * was nothing to say. `rate` defaults to 0.9 — a touch slower, for learners.
 */
export function speak(text, code, { rate = 0.9 } = {}) {
  const t = String(text || "").trim();
  if (!t || !canSpeak()) return false;
  const synth = window.speechSynthesis;
  try {
    synth.cancel();                 // stop anything already playing
    if (!_voices.length) refreshVoices();
    const u = new window.SpeechSynthesisUtterance(t);
    const tag = langTag(code);
    u.lang = tag;
    const v = pickVoice(tag);
    if (v) u.voice = v;
    u.rate = rate;
    synth.speak(u);
    return true;
  } catch { return false; }
}

export function stopSpeaking() {
  try { window.speechSynthesis.cancel(); } catch {}
}
