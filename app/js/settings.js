import { getSettings, updateSettings, clearAll, getAllVaultItems } from "./db.js";
import { APP_VERSION } from "./version.js";
import { exportBackup, importBackup, isPersisted } from "./backup.js";
import { LEVELS, levelHint, clampLevel } from "./levels.js";
import { getLearningLanguage } from "./languages.js";

const $ = (id) => document.getElementById(id);

const els = {
  libUrl: () => document.getElementById("lib-url"),
  fontSize: () => document.getElementById("font-size"),
  pairsPerPage: () => document.getElementById("pairs-per-page"),
  openaiKey: () => document.getElementById("openai-key"),
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
  if (els.openaiKey()) els.openaiKey().value = s.openaiKey || "";
  const lvl = $("my-level");
  lvl.innerHTML = LEVELS.map((l) => `<option value="${l.n}">${l.name}</option>`).join("");
  lvl.value = String(clampLevel(s.myLevel));
  showLevelHint(lvl.value);
  applyFontSize(s.fontSize);
  updateOnlineStatus();
  const ver = document.getElementById("app-version");
  if (ver) ver.textContent = `Version v${APP_VERSION}`;
  refreshDataStatus(s);
}

function showLevelHint(n) {
  const lang = getLearningLanguage();
  const what = lang === "zh" ? levelHint(clampLevel(n), "zh") : `roughly: you know ${levelHint(clampLevel(n), lang)}`;
  $("my-level-hint").textContent = `${what}. Used for “% known” on chapters, the default chapter-quiz level, and practice stories.`;
}

function timeAgo(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

async function refreshDataStatus(s) {
  s = s || (await getSettings());
  const count = (await getAllVaultItems()).length;
  const words = `${count} saved word${count === 1 ? "" : "s"}`;
  $("backup-status").textContent = s.lastBackupAt
    ? `${words} · last backup ${timeAgo(s.lastBackupAt)}`
    : `${words} · never backed up`;
  const persisted = await isPersisted();
  $("storage-status").textContent = persisted === true
    ? "Storage is protected: iOS won't clear it to free up space."
    : persisted === false
      ? "Storage isn't protected yet. iOS could clear it if the phone runs low on space, so keep a backup."
      : "";
}

// Remove cached app code so the next load fetches the latest version. Keeps the
// pronunciation audio cache (it costs API calls to rebuild) unless `all`.
async function dropAppCaches({ all = false } = {}) {
  if (window.caches) {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => all || !k.startsWith("tts-audio")).map((k) => caches.delete(k)));
  }
  if (navigator.serviceWorker) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  }
}

function updateOnlineStatus() {
  els.onlineStatus().textContent = navigator.onLine ? "Online" : "Offline";
}

const save = (partial) => updateSettings(partial);

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

  if (els.openaiKey()) {
    els.openaiKey().addEventListener("change", async (e) => {
      await save({ openaiKey: e.target.value.trim() });
    });
  }

  $("my-level").addEventListener("change", async (e) => {
    showLevelHint(e.target.value);
    await save({ myLevel: clampLevel(e.target.value) });
  });

  $("backup-export").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await exportBackup();
      if (r.how !== "cancelled") $("backup-status").textContent = `Backed up ${r.count} word${r.count === 1 ? "" : "s"}.`;
      setTimeout(() => refreshDataStatus(), 2500);
    } catch (err) {
      $("backup-status").textContent = `Backup failed: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  $("backup-import").addEventListener("click", () => $("backup-file").click());
  $("backup-file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const r = await importBackup(file);
      const parts = [`${r.added} new word${r.added === 1 ? "" : "s"} added`];
      if (r.updated) parts.push(`${r.updated} updated`);
      if (r.kept) parts.push(`${r.kept} already up to date`);
      $("backup-status").textContent = `Restored: ${parts.join(", ")}.`;
    } catch (err) {
      $("backup-status").textContent = err.message;
    }
  });

  $("refresh-app").addEventListener("click", async () => {
    await dropAppCaches();
    location.reload();
  });

  els.clearBtn().addEventListener("click", async () => {
    const count = (await getAllVaultItems()).length;
    const vaultLine = count
      ? `This also deletes your Memory Vault: ${count} saved word${count === 1 ? "" : "s"} and all quiz history.`
      : "";
    if (!confirm(`Erase everything on this device?\n\nBooks, reading progress and settings will be deleted. ${vaultLine}\n\nTo just update the app, use “Refresh app” instead.`)) return;
    if (count && !confirm(`Last check: permanently delete ${count} saved word${count === 1 ? "" : "s"}? This can't be undone without a backup.`)) return;
    await clearAll();
    await dropAppCaches({ all: true });
    location.reload();
  });

  // A restore (or any vault change) changes the counts shown here.
  window.addEventListener("vault:changed", () => {
    if (document.body.getAttribute("data-view") === "settings") refreshDataStatus();
  });

  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);

  return loadSettingsIntoUI();
}
