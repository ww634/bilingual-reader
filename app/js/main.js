import { showWelcome } from "./welcome.js";
import { isReadingTourActive } from './reading-tour.js';
import { confirmAction } from "./ui.js";
import { initCatalog, refreshCatalog, openBookDetail, renderBookDetail, downloadChapter } from "./library.js";
import { openReader, closeReader, getReaderContext, startReadingTour } from "./reader.js";
import { initSettings, loadSettingsIntoUI } from "./settings.js";
import { initPopover, closePopover } from "./popover.js";
import { initReaderOptions } from "./reader-options.js";
import { initAssistant } from "./assistant.js";
import { initSelection } from "./selection.js";
import { initVault, openVault, finishActiveQuiz } from "./vault.js";
import { loadLearningLanguage, getLearningLanguage } from "./languages.js";
import { initHome } from "./home.js";
import { initListen } from "./listen.js";
import { requestPersistence } from "./backup.js";
import { initWriter } from "./write.js";
import { initStories } from "./stories.js";
import { initFeedback } from "./feedback.js";

const VIEWS = ["home", "library", "browse", "book-detail", "vault", "review", "reader", "settings"];
const TITLES = {
  home: "Today",
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
  settingsBtn.hidden = name === "settings";
  // The reader-options (sliders) and assistant icons only make sense in the reader.
  if (readerOptionsBtn) readerOptionsBtn.hidden = name !== "reader";
  if (assistantBtn) assistantBtn.hidden = name !== "reader";
  if (listenBtn) listenBtn.hidden = name !== "reader";

  // Let modules (e.g. the reader selection) react to leaving/entering a screen.
  window.dispatchEvent(new CustomEvent("view:changed", { detail: name }));

  if (name === "vault") openVault();
}

function goBack() {
  if (currentView === "review" && finishActiveQuiz()) return;
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

async function openSettings(section) {
  closePopover(); window.dispatchEvent(new CustomEvent("ui:close-overlays"));
  setView("settings"); await loadSettingsIntoUI();
  if (section === "ai") { document.getElementById("ai-settings-heading").scrollIntoView({block:"start"}); document.getElementById("openai-key").focus(); }
}
settingsBtn.addEventListener("click", () => openSettings());
window.addEventListener("app:settings", e => openSettings(e.detail));
document.addEventListener("click", e => { if(e.target.closest("[data-ai-settings]"))openSettings("ai") });

window.addEventListener("nav:bookDetail", (e) => {
  // Title is set inside renderBookDetail; here we just transition views.
  setView("book-detail");
  // Set the topbar title to the book title.
  const title = document.getElementById("book-detail-title")?.textContent || "";
  titleEl.textContent = title;
});

window.addEventListener("nav:reader", async (e) => {
  const { bookId, chapterId } = e.detail;
  const previousView = currentView;
  // Show the reader view FIRST so it has a real layout/width. The reader
  // measures rendered pinyin to decide visual-line block boundaries; this
  // measurement requires the view to be visible (display:none gives 0
  // width). The visible-but-empty reader is fine for the ~10ms it takes
  // openReader's IndexedDB reads to complete before populating it.
  setView("reader");
  const ok = await openReader(bookId, chapterId);
  if (ok && e.detail.tour) requestAnimationFrame(() => { if (!isReadingTourActive()) startReadingTour(); });
  if (!ok) {
    // Chapter not downloaded — return to wherever we came from.
    if (previousView === "reader") {
      setView("reader", { push: false });
    } else if (navStack.length > 0) {
      const prev = navStack.pop();
      setView(prev, { push: false });
    } else {
      setView("home", { push: false });
    }
    let message = "This chapter isn’t downloaded yet. Download it to keep reading. Your current place is kept.";
    while (await confirmAction({ title: "Chapter not downloaded", message, confirmLabel: "Download", destructive: false })) {
      try { await downloadChapter(bookId, chapterId); window.dispatchEvent(new CustomEvent("nav:reader", {detail:{bookId,chapterId}})); break; }
      catch (error) { message = error.message + " You can retry the download."; }
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
  initFeedback();
  await initVault();
  setView("home", { push: false });
  initCatalog().catch(err => console.warn("Catalog refresh failed:", err));
  showWelcome();
  // Ask iOS to keep this app's data even when the phone is short of space.
  requestPersistence();
})();

document.getElementById("show-welcome").addEventListener("click", () => showWelcome({force:true}));
document.getElementById("show-reading-tour").addEventListener("click", async () => {
  const { getAllChapterMetadata, getAllBooks } = await import('./db.js');
  const context = getReaderContext();
  const [downloaded, books] = await Promise.all([getAllChapterMetadata(), getAllBooks()]);
  const languageBooks = new Set(books.filter(book => book.language === getLearningLanguage()).map(book => book.id));
  const chapter = downloaded.find(ch => languageBooks.has(ch.bookId) && ch.bookId === context?.bookId && ch.chapterId === context?.chapterId)
    || downloaded.find(ch => languageBooks.has(ch.bookId)) || downloaded[0];
  if (chapter) window.dispatchEvent(new CustomEvent('nav:reader', { detail: { bookId: chapter.bookId, chapterId: chapter.chapterId, tour: true } }));
  else showWelcome({ force: true });
});

window.addEventListener("welcome:complete", () => { if(getReaderContext())closeReader();navStack.length=0;setView("home",{push:false}); });
