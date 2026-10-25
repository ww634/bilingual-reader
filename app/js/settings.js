import { confirmAction } from "./ui.js";
import { audioCacheInfo, clearAudioCache } from "./speech.js";
import { getSettings, updateSettings, clearAll, getAllVaultItems } from "./db.js";
import { APP_VERSION } from "./version.js";
import { exportBackup, prepareBackup, importBackup, isPersisted } from "./backup.js";
import { learnerLevel, LEVELS, levelHint, clampLevel } from "./levels.js";
import { getLearningLanguage } from "./languages.js";
import { flushFeedback, feedbackSummary, KINDS } from "./feedback.js";

let _preparedBackup = null;
let _backupPreparation = 0;
async function refreshPreparedBackup() {
  const run = ++_backupPreparation;
  _preparedBackup = null;
  const button = document.getElementById("backup-export");
  button.disabled = true;
  try { const ready = await prepareBackup(); if (run === _backupPreparation) _preparedBackup = ready; }
  catch { $("backup-status").textContent = "Could not prepare the backup file. Please try again."; }
  finally { if (run === _backupPreparation) button.disabled = false; }
}

const $ = (id) => document.getElementById(id);

const els = {
  libUrl: () => document.getElementById("lib-url"),
  fontSize: () => document.getElementById("font-size"),
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
  if (els.openaiKey()) els.openaiKey().value = s.openaiKey || "";
  const lvl = $("my-level");
  lvl.innerHTML = LEVELS.map((l) => `<option value="${l.n}">${l.name}</option>`).join("");
  lvl.value = String(learnerLevel(s, getLearningLanguage()));
  showLevelHint(lvl.value);
  applyFontSize(s.fontSize);
  updateOnlineStatus();
  const ver = document.getElementById("app-version");
  if (ver) ver.textContent = `Version v${APP_VERSION}`;
  refreshDataStatus(s);
  refreshPreparedBackup();
  $("feedback-repo").value = s.feedbackRepo || "";
  $("feedback-token").value = s.feedbackToken || "";
  refreshFeedbackStatus();
  refreshAudioCacheStatus();
}

async function refreshAudioCacheStatus() {
  const info = await audioCacheInfo();
  $("audio-cache-status").textContent = `${info.entries} audio clips · ${(info.bytes / 1024 / 1024).toFixed(1)} MB. Limited to ${info.maxEntries} clips or 12 MB; least-played clips are removed first.`;
}

async function refreshFeedbackStatus() {
  const { all, sent, waiting } = await feedbackSummary();
  const s = await getSettings();
  const ready = !!(s.feedbackRepo && s.feedbackToken);
  $("feedback-summary").textContent = !all.length
    ? (ready ? "Ready. Nothing sent yet." : "Add the repository and token to start sending feedback.")
    : `${sent} sent${waiting ? ` · ${waiting} waiting to send` : ""}${!ready && waiting ? " (add the token to send)" : ""}`;
  $("feedback-flush").hidden = !(waiting && ready);
  const kind = (id) => KINDS.find((k) => k.id === id)?.label || id;
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  $("feedback-list").innerHTML = all.slice(0, 6).map((f) => `
    <li>
      <span class="fb-words">${esc((f.selection?.hanzi || f.selection?.shown || "").slice(0, 24))}</span>
      <span class="fb-kind">${esc(kind(f.kind))} · ${esc((f.message || "").slice(0, 60))}</span>
      <span class="fb-state ${f.status === "sent" ? "sent" : "waiting"}">${f.status === "sent" ? `✓ #${f.issue?.number ?? ""}` : "waiting"}</span>
    </li>`).join("");
}

function showLevelHint(n) {
  const lang = getLearningLanguage();
  const what = lang === "zh" ? levelHint(clampLevel(n), "zh") : `Practice level: ${levelHint(clampLevel(n), lang)}`;
  $("my-level-hint").textContent = `${what}. Used for quizzes and practice stories.${lang === "fr" ? " Reading-percentage estimates are not shown for French yet." : " Also used for chapter reading estimates."}`;
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
  const words = `${count} saved item${count === 1 ? "" : "s"}`;
  $("backup-status").textContent = s.lastBackupAt
    ? `${words} · last backup ${timeAgo(s.lastBackupAt)}`
    : s.lastBackupDownloadAt ? `${words} · backup file exported ${timeAgo(s.lastBackupDownloadAt)} (save not confirmed)` : `${words} · no confirmed backup yet`;
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
    await Promise.all(keys.filter((k) => all || k.startsWith("reader-shell-")).map((k) => caches.delete(k)));
  }
  if (navigator.serviceWorker) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  }
}

export function clearAppLocalStorage() {
  for (const key of Object.keys(localStorage)) if (key.startsWith("bilingual-reader.")) localStorage.removeItem(key);
}

function updateOnlineStatus() {
  els.onlineStatus().textContent = navigator.onLine ? "Online" : "Offline";
  $("refresh-app").disabled = !navigator.onLine;
}

const save = async partial => { const next = await updateSettings(partial); refreshPreparedBackup(); return next; };

export function initSettings() {
  els.libUrl().addEventListener("change", async (e) => {
    await save({ libraryUrl: e.target.value.trim() });
    window.dispatchEvent(new CustomEvent("settings:libraryUrl"));
  });

  els.fontSize().addEventListener("change", async (e) => {
    const next = await save({ fontSize: e.target.value });
    applyFontSize(next.fontSize);
    window.dispatchEvent(new CustomEvent("reader:layout"));
  });



  if (els.openaiKey()) {
    els.openaiKey().addEventListener("change", async (e) => {
      await save({ openaiKey: e.target.value.trim() });
    });
  }

  const saveFeedbackSetup = async () => {
    await save({ feedbackRepo: $("feedback-repo").value.trim(), feedbackToken: $("feedback-token").value.trim() });
    await flushFeedback();
    refreshFeedbackStatus();
  };
  $("feedback-repo").addEventListener("change", saveFeedbackSetup);
  $("feedback-token").addEventListener("change", saveFeedbackSetup);
  $("feedback-flush").addEventListener("click", async () => {
    $("feedback-summary").textContent = "Sending…";
    const r = await flushFeedback();
    if (r && r.waiting && r.setup) $("feedback-summary").textContent = "Couldn't send. Check the token and repository, or your connection.";
    else refreshFeedbackStatus();
  });
  window.addEventListener("feedback:changed", () => {
    if (document.body.getAttribute("data-view") === "settings") refreshFeedbackStatus();
  });

  $("my-level").addEventListener("change", async (e) => {
    showLevelHint(e.target.value);
    await updateSettings(s => ({ myLevel: { ...s.myLevel, [getLearningLanguage()]: clampLevel(e.target.value) } }));
    refreshPreparedBackup();
  });

  $("backup-export").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await exportBackup(_preparedBackup);
      if (r.how === "not-ready") refreshPreparedBackup();
      $("backup-status").textContent = r.how === "shared" ? `Backup shared: ${r.count} saved items.`
        : r.how === "downloaded" ? "Backup file downloaded. Save it somewhere safe; saving has not been confirmed."
        : r.how === "cancelled" ? "Backup cancelled. No confirmed backup was recorded."
        : "The backup could not be shared. Please try again.";
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
      if (r.stories) parts.push(`${r.stories} practice stories restored`);
      if (r.kept) parts.push(`${r.kept} already up to date`);
      $("backup-status").textContent = `Restored: ${parts.join(", ")}.`;
      refreshPreparedBackup();
    } catch (err) {
      $("backup-status").textContent = err.message;
    }
  });

  $("clear-audio-cache").addEventListener("click", async () => { await clearAudioCache(); await refreshAudioCacheStatus(); });

  $("refresh-app").addEventListener("click", async () => {
    if (!navigator.onLine) return;
    await dropAppCaches();
    location.reload();
  });

  els.clearBtn().addEventListener("click", async () => {
    const count = (await getAllVaultItems()).length;
    if (!await confirmAction({ title: "Erase this device’s data?", message: `Books, progress, settings and ${count} saved items will be permanently deleted. Restore requires a backup. To update the app without deleting data, use Refresh app.`, confirmLabel: "Erase everything" })) return;
    await clearAll();
    clearAppLocalStorage();
    await dropAppCaches({ all: true });
    location.reload();
  });

  // A restore (or any vault change) changes the counts shown here.
  window.addEventListener("vault:changed", () => {
    if (document.body.getAttribute("data-view") === "settings") { refreshDataStatus(); refreshPreparedBackup(); }
  });

  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);

  return loadSettingsIntoUI();
}
