// The "learning language" — which language the user is currently studying. The
// platform UI stays English; this is just what Library / Browse / Memory Vault /
// Quizzes are filtered and sorted by. One global setting, switchable from the
// language pickers, cached here so views can read it synchronously.

import { getSettings, putSettings } from "./db.js";

// Display names for languages the app knows about. `base` languages always
// appear in the switcher (so a language can be selected before it has content);
// any other language that has books in the catalog/library is added dynamically.
export const LANGUAGES = {
  zh: { name: "Chinese", base: true },
  fr: { name: "French", base: true },
  es: { name: "Spanish" },
  ja: { name: "Japanese" },
  de: { name: "German" },
  it: { name: "Italian" },
  ko: { name: "Korean" },
};

export function languageName(code) {
  return LANGUAGES[String(code || "").toLowerCase()]?.name || String(code || "").toUpperCase();
}

let _current = "zh";
export function getLearningLanguage() { return _current; }

export async function loadLearningLanguage() {
  const s = await getSettings();
  _current = s.learningLanguage || "zh";
  return _current;
}

export async function setLearningLanguage(code) {
  if (!code || code === _current) { _current = code || _current; }
  _current = code;
  const s = await getSettings();
  await putSettings({ ...s, learningLanguage: code });
  window.dispatchEvent(new CustomEvent("language:changed", { detail: code }));
}

/**
 * Languages to offer in the switcher: the always-on base set, plus any extra
 * languages that actually have content, plus the current one. Returns an
 * ordered list of codes.
 */
export function availableLanguages(contentCodes = []) {
  const set = new Set();
  for (const [code, meta] of Object.entries(LANGUAGES)) if (meta.base) set.add(code);
  for (const c of contentCodes) if (c) set.add(String(c).toLowerCase());
  set.add(_current);
  // Base languages first (in declaration order), then the rest alphabetically.
  const order = Object.keys(LANGUAGES);
  return [...set].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}
