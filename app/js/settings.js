import { getSettings, putSettings, clearAll } from "./db.js";

const els = {
  libUrl: () => document.getElementById("lib-url"),
  fontSize: () => document.getElementById("font-size"),
  pairsPerPage: () => document.getElementById("pairs-per-page"),
  clearBtn: () => document.getElementById("clear-cache"),
  onlineStatus: () => document.getElementById("online-status"),
};

function applyFontSize(size) {
  document.body.setAttribute("data-font", size || "medium");
}

export async function loadSettingsIntoUI() {
  const s = await getSettings();
  els.libUrl().value = s.libraryUrl;
  els.fontSize().value = s.fontSize;
  els.pairsPerPage().value = String(s.pairsPerPage);
  applyFontSize(s.fontSize);
  updateOnlineStatus();
}

function updateOnlineStatus() {
  els.onlineStatus().textContent = navigator.onLine ? "Online" : "Offline";
}

async function save(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await putSettings(next);
  return next;
}

export function initSettings() {
  els.libUrl().addEventListener("change", async (e) => {
    await save({ libraryUrl: e.target.value.trim() });
    window.dispatchEvent(new CustomEvent("settings:libraryUrl"));
  });

  els.fontSize().addEventListener("change", async (e) => {
    const next = await save({ fontSize: e.target.value });
    applyFontSize(next.fontSize);
  });

  els.pairsPerPage().addEventListener("change", async (e) => {
    await save({ pairsPerPage: parseInt(e.target.value, 10) });
    window.dispatchEvent(new CustomEvent("settings:pairsPerPage"));
  });

  els.clearBtn().addEventListener("click", async () => {
    if (!confirm("Delete all downloaded chapters, progress, settings, AND force-refresh the app code?")) return;
    // 1) Wipe IndexedDB
    await clearAll();
    // 2) Wipe service worker caches (so updated CSS/JS gets pulled next launch)
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    // 3) Unregister the service worker so a fresh one installs
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    // 4) Hard reload — bypass any in-flight cached responses.
    location.reload();
  });

  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);

  return loadSettingsIntoUI();
}
