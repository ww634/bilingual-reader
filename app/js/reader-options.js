// Reader-options slide-up sheet: a per-reader settings panel that lives
// outside the global Settings view. Controls Chinese script display and
// per-category visibility of English translations.
//
// Per-category visibility is implemented as body-level classes
// (`body.hide-cat-noun`, etc) plus CSS rules in styles.css. Toggling is
// instant — no re-render — and pagination stays stable because we use
// visibility:hidden rather than display:none.

import { getSettings, updateSettings } from "./db.js";

// Keep this list in sync with the toggles in index.html and the
// body.hide-cat-<key> rules in styles.css. Adding a category here = adding
// a checkbox + a CSS rule = wiring complete.
const CATEGORIES = [
  { key: "noun" },
  { key: "verb" },
  { key: "adjective" },
  { key: "adverb" },
  { key: "idiom" },
  { key: "proper_noun" },
  { key: "measure_word" },
  { key: "function_word" },
  { key: "particle" },
  { key: "other" }, // catch-all for any English word the alignment didn't claim
];

const DEFAULT_VISIBILITY = {
  noun: true,
  verb: true,
  adjective: true,
  adverb: true,
  idiom: true,
  proper_noun: true,
  measure_word: true,
  function_word: true,
  particle: true,
  other: true,
};

const $ = (id) => document.getElementById(id);

/**
 * True when the reader should show the target language only: the "Show English"
 * switch is off, or every English category has been switched off one by one.
 * Either way the English lines are removed and the text flows like a book.
 */
export function isTargetOnly(settings) {
  if (settings?.showEnglish === false) return true;
  const vis = { ...DEFAULT_VISIBILITY, ...(settings?.categoryVisibility || {}) };
  return CATEGORIES.every(({ key }) => vis[key] === false);
}

// Re-lay out the open chapter (English on ⇄ off). reader.js listens.
const relayout = () => window.dispatchEvent(new CustomEvent("reader:layout"));

function syncEnglishSwitch(settings) {
  const sw = $("opt-show-english");
  if (!sw) return;
  const off = isTargetOnly(settings);
  sw.checked = !off;
  $("cat-section")?.classList.toggle("off", off);
}

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
  getSettings().then(s => {
    syncEnglishSwitch(s);
    $("reader-script").value = s.readerScript || "pinyin";
    const hm = $("opt-hide-mastered");
    if (hm) hm.checked = s.hideMastered !== false;
  });
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
  const before = isTargetOnly(await getSettings());
  _state.visibility[key] = checked;
  applyVisibilityClasses(_state.visibility);
  const after = await updateSettings({ categoryVisibility: { ..._state.visibility } });
  syncEnglishSwitch(after);
  // Switching off the last category (or one back on from none) changes the layout.
  if (before !== isTargetOnly(after)) relayout();
}

async function onEnglishSwitch(on) {
  const patch = { showEnglish: on };
  // Turning English back on with every category off would still show nothing:
  // bring the categories back too.
  if (on && CATEGORIES.every(({ key }) => _state.visibility[key] === false)) {
    for (const { key } of CATEGORIES) _state.visibility[key] = true;
    applyVisibilityClasses(_state.visibility);
    syncCheckboxes();
    patch.categoryVisibility = { ..._state.visibility };
  }
  const next = await updateSettings(patch);
  syncEnglishSwitch(next);
  relayout();
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

  $("reader-script")?.addEventListener("change", async (event) => {
    const script = event.target.value;
    window.dispatchEvent(new CustomEvent("reader:script", { detail: script }));
    await updateSettings({ readerScript: script });
  });

  $("opt-show-english")?.addEventListener("change", (e) => onEnglishSwitch(e.target.checked));

  $("opt-hide-mastered")?.addEventListener("change", async (event) => {
    const on = event.target.checked;
    document.body.classList.toggle("hide-mastered", on);
    await updateSettings({ hideMastered: on });
  });

  for (const { key } of CATEGORIES) {
    const cb = document.querySelector(
      `#reader-options input[data-cat="${key}"]`
    );
    cb?.addEventListener("change", () => onToggleChange(key, cb.checked));
  }
}
