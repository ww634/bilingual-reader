import { initCatalog, refreshCatalog } from "./library.js";
import { openReader, closeReader } from "./reader.js";
import { initSettings, loadSettingsIntoUI } from "./settings.js";

const VIEWS = ["home", "library", "browse", "quizzes", "reader", "settings"];
const TITLES = {
  home: "Reader",
  library: "Library",
  browse: "Browse",
  quizzes: "Quizzes",
  reader: "",
  settings: "Settings",
};

const titleEl = document.getElementById("title");
const backBtn = document.getElementById("back-btn");
const settingsBtn = document.getElementById("settings-btn");

let currentView = "home";

function setView(name) {
  for (const v of VIEWS) {
    const el = document.getElementById(`view-${v}`);
    if (el) el.hidden = v !== name;
  }
  currentView = name;
  document.body.setAttribute("data-view", name);

  if (TITLES[name]) titleEl.textContent = TITLES[name];

  backBtn.hidden = name === "home";
  settingsBtn.hidden = name !== "home";
}

// Wire home-tile clicks.
document.querySelectorAll("[data-nav]").forEach((el) => {
  el.addEventListener("click", () => {
    const target = el.getAttribute("data-nav");
    if (target) setView(target);
  });
});

backBtn.addEventListener("click", () => {
  if (currentView === "reader") {
    closeReader();
    setView("library");
    refreshCatalog();
    return;
  }
  setView("home");
});

settingsBtn.addEventListener("click", () => {
  loadSettingsIntoUI();
  setView("settings");
});

window.addEventListener("nav:reader", async (e) => {
  const ok = await openReader(e.detail.id);
  if (ok) setView("reader");
  // reader.js sets the topbar title to the chapter's English title.
});

window.addEventListener("settings:libraryUrl", () => refreshCatalog());
window.addEventListener("settings:cleared", () => {
  if (currentView === "reader") {
    closeReader();
  }
  setView("home");
  refreshCatalog();
});

// Register service worker (skip on file://).
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("SW registration failed:", err);
    });
  });
}

// Boot.
(async function boot() {
  await initSettings();
  await initCatalog();
  setView("home");
})();
