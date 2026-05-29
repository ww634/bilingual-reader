// Reader-options slide-up sheet: a per-reader settings panel that lives
// outside the global Settings view. Today it just controls per-category
// visibility of English translations; future home for font size, theme,
// search, share, etc.
//
// Per-category visibility is implemented as body-level classes
// (`body.hide-cat-noun`, etc) plus CSS rules in styles.css. Toggling is
// instant — no re-render — and pagination stays stable because we use
// visibility:hidden rather than display:none.

import { getSettings, putSettings } from "./db.js";

const CATEGORIES = [
  { key: "noun" },
  { key: "verb" },
  { key: "adjective" },
  { key: "adverb" },
  { key: "idiom" },
  { key: "proper_noun" },
];

const DEFAULT_VISIBILITY = {
  noun: true,
  verb: true,
  adjective: true,
  adverb: true,
  idiom: true,
  proper_noun: true,
};

const $ = (id) => document.getElementById(id);

let _state = {
  visibility: { ...DEFAULT_VISIBILITY },
};

function applyVisibilityClasses(visibility) {
  for (const { key } of CATEGORIES) {
    const hidden = visibility[key] === false;
    document.body.classList.toggle(`hide-cat-${key}`, hidden);
  }
}

/**
 * Read settings, apply the visibility classes to <body>, and update internal
 * state. Called on boot so a returning visitor sees the same toggles they
 * left, even before the reader is opened.
 */
export async function loadAndApplyVisibility() {
  const settings = await getSettings();
  const stored = settings.categoryVisibility || {};
  _state.visibility = { ...DEFAULT_VISIBILITY, ...stored };
  applyVisibilityClasses(_state.visibility);
  return _state.visibility;
}

function syncCheckboxes() {
  for (const { key } of CATEGORIES) {
    const cb = document.querySelector(
      `#reader-options input[data-cat="${key}"]`
    );
    if (cb) cb.checked = _state.visibility[key] !== false;
  }
}

function openSheet() {
  syncCheckboxes();
  $("reader-options-backdrop").hidden = false;
  const sheet = $("reader-options");
  sheet.hidden = false;
  // Force layout before adding .open so the CSS transition fires.
  void sheet.offsetHeight;
  sheet.classList.add("open");
}

function closeSheet() {
  const sheet = $("reader-options");
  sheet.classList.remove("open");
  // Wait for slide-down to finish before hiding (and removing pointer events).
  // Keep this in sync with the CSS transition duration (220ms).
  setTimeout(() => {
    sheet.hidden = true;
    $("reader-options-backdrop").hidden = true;
  }, 240);
}

async function onToggleChange(key, checked) {
  _state.visibility[key] = checked;
  applyVisibilityClasses(_state.visibility);
  // Persist. We re-fetch settings so we don't clobber any other field that
  // got updated since boot.
  const settings = await getSettings();
  settings.categoryVisibility = { ..._state.visibility };
  await putSettings(settings);
}

export async function initReaderOptions() {
  // Apply saved visibility on boot, before anything renders.
  await loadAndApplyVisibility();

  $("reader-options-btn")?.addEventListener("click", openSheet);
  $("reader-options-close")?.addEventListener("click", closeSheet);
  $("reader-options-backdrop")?.addEventListener("click", closeSheet);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("reader-options").hidden) closeSheet();
  });

  for (const { key } of CATEGORIES) {
    const cb = document.querySelector(
      `#reader-options input[data-cat="${key}"]`
    );
    cb?.addEventListener("change", () => onToggleChange(key, cb.checked));
  }
}
