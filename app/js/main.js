import { initCatalog, refreshCatalog, openBookDetail, renderBookDetail } from "./library.js";
import { openReader, closeReader, getReaderContext } from "./reader.js";
import { initSettings, loadSettingsIntoUI } from "./settings.js";
import { initPopover, closePopover } from "./popover.js";
import { initReaderOptions } from "./reader-options.js";
import { initAssistant } from "./assistant.js";
import { initSelection } from "./selection.js";
import { initVault, openVault } from "./vault.js";
import { loadLearningLanguage } from "./languages.js";
import { initHome } from "./home.js";
import { initListen } from "./listen.js";
import { requestPersistence } from "./backup.js";
import { initWriter } from "./write.js";
import { initStories } from "./stories.js";

const VIEWS = ["home", "library", "browse", "book-detail", "vault", "review", "reader", "settings"];
const TITLES = {
  home: "Reader",
  library: "Library",
  browse: "Browse",
  "book-detail": "",   // set per-book
  vault: "Memory Vault",
  review: "Review",
  reader: "",          // set per-chapter
  settings: "Settings",
};

const titleEl = document.getElementById("title");
const backBtn = document.getElementById("back-btn");
const settingsBtn = document.getElementById("settings-btn");
const readerOptionsBtn = document.getElementById("reader-options-btn");
const assistantBtn = document.getElementById("assistant-btn");
const listenBtn = document.getElementById("listen-btn");

const navStack = [];     // history of view names for back navigation
let currentView = "home";

function setView(name, { push = true } = {}) {
  for (const v of VIEWS) {
    const el = document.getElementById(`view-${v}`);
    if (el) el.hidden = v !== name;
  }
  if (push && currentView !== name) navStack.push(currentView);
  currentView = name;
  document.body.setAttribute("data-view", name);

  if (TITLES[name]) titleEl.textContent = TITLES[name];

  backBtn.hidden = name === "home";
  settingsBtn.hidden = name !== "home";
  // The reader-options (sliders) and assistant icons only make sense in the reader.
  if (readerOptionsBtn) readerOptionsBtn.hidden = name !== "reader";
  if (assistantBtn) assistantBtn.hidden = name !== "reader";
  if (listenBtn) listenBtn.hidden = name !== "reader";

  // Let modules (e.g. the reader selection) react to leaving/entering a screen.
  window.dispatchEvent(new CustomEvent("view:changed", { detail: name }));

  if (name === "vault") openVault();
}

function goBack() {
  closePopover();
  if (currentView === "reader") {
    closeReader();
  }
  const prev = navStack.pop() || "home";
  setView(prev, { push: false });
  if (prev === "library" || prev === "browse") refreshCatalog();
  if (prev === "book-detail") renderBookDetail();
  // Back into an open chapter (e.g. after its "words to watch" quiz).
  if (prev === "reader") titleEl.textContent = getReaderContext()?.chapter?.title?.english || "";
}

document.querySelectorAll("[data-nav]").forEach((el) => {
  el.addEventListener("click", () => {
    const target = el.getAttribute("data-nav");
    if (target) setView(target);
  });
});

backBtn.addEventListener("click", goBack);

settingsBtn.addEventListener("click", () => {
  loadSettingsIntoUI();
  setView("settings");
});

window.addEventListener("nav:bookDetail", (e) => {
  // Title is set inside renderBookDetail; here we just transition views.
  setView("book-detail");
  // Set the topbar title to the book title.
  const title = document.getElementById("book-detail-title")?.textContent || "";
  titleEl.textContent = title;
});

window.addEventListener("nav:reader", async (e) => {
  const { bookId, chapterId } = e.detail;
  // Show the reader view FIRST so it has a real layout/width. The reader
  // measures rendered pinyin to decide visual-line block boundaries; this
  // measurement requires the view to be visible (display:none gives 0
  // width). The visible-but-empty reader is fine for the ~10ms it takes
  // openReader's IndexedDB reads to complete before populating it.
  setView("reader");
  const ok = await openReader(bookId, chapterId);
  if (!ok) {
    // Chapter not downloaded — return to wherever we came from.
    if (navStack.length > 0) {
      const prev = navStack.pop();
      setView(prev, { push: false });
    } else {
      setView("home", { push: false });
    }
  }
});

// Programmatic navigation from modules (e.g. vault → review → vault).
window.addEventListener("app:setview", (e) => { if (e.detail) setView(e.detail); });
// "Done" from a quiz returns to wherever it was started (vault, home, reader).
window.addEventListener("app:back", goBack);

window.addEventListener("settings:libraryUrl", () => refreshCatalog());
window.addEventListener("settings:cleared", () => {
  if (currentView === "reader") closeReader();
  navStack.length = 0;
  setView("home", { push: false });
  refreshCatalog();
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("SW registration failed:", err);
    });
  });
}

(async function boot() {
  await initSettings();
  await loadLearningLanguage();
  initPopover();
  await initReaderOptions();
  initAssistant();
  initSelection();
  initListen();
  initHome();
  initWriter();
  initStories();
  await initVault();
  await initCatalog();
  setView("home", { push: false });
  // Ask iOS to keep this app's data even when the phone is short of space.
  requestPersistence();
})();
