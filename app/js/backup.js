// Backup / restore of the learner's own data, plus storage protection.
//
// What's in a backup: every Memory Vault word (all languages, with quiz history),
// reading progress, and the daily activity record (streak). NOT included: books
// and chapters (re-downloadable from Browse), cached audio, and the OpenAI key
// (a backup file may end up in iCloud/Files — keep the secret out of it).
//
// Restore MERGES rather than replaces: words missing locally are added, words on
// both sides keep whichever copy was studied more recently, and progress keeps
// the later position. So restoring an old backup can never wipe newer work.

import {
  getAllVaultItems, getVaultItem, putVaultItem,
  getAllProgress, putProgressRecord, getActivity, putActivity, updateSettings, dayKey,
} from "./db.js";
import { APP_VERSION } from "./version.js";

const KIND = "bilingual-reader-backup";
const FORMAT = 1;

async function buildBackup() {
  const [vault, progress, activity] = await Promise.all([getAllVaultItems(), getAllProgress(), getActivity()]);
  return {
    kind: KIND,
    format: FORMAT,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    vault,
    progress,
    activity,
  };
}

/**
 * Save a backup file. On iPhone this opens the share sheet (Save to Files,
 * AirDrop, iCloud Drive…); elsewhere it downloads the file.
 * Returns { ok, count, how } — how: "shared" | "downloaded" | "cancelled".
 */
export async function exportBackup() {
  const data = await buildBackup();
  const name = `reader-backup-${dayKey()}.json`;
  const json = JSON.stringify(data, null, 1);
  const file = new File([json], name, { type: "application/json" });

  let how = "downloaded";
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Reader backup" });
      how = "shared";
    } catch (err) {
      if (err && err.name === "AbortError") return { ok: false, count: data.vault.length, how: "cancelled" };
      downloadFile(file);   // share refused (e.g. no user gesture) — fall back
    }
  } else {
    downloadFile(file);
  }
  await updateSettings({ lastBackupAt: new Date().toISOString() });
  return { ok: true, count: data.vault.length, how };
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// When a word was last studied (or saved, if never quizzed).
const studiedAt = (it) => it?.lastSeen || it?.createdAt || 0;

/**
 * Merge a backup file into this device. Returns { added, updated, kept, progress }.
 * Throws with a readable message if the file isn't a backup.
 */
export async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { throw new Error("That file isn't a readable backup (not valid JSON)."); }
  if (!data || data.kind !== KIND || !Array.isArray(data.vault)) {
    throw new Error("That file isn't a Reader backup.");
  }

  let added = 0, updated = 0, kept = 0;
  for (const item of data.vault) {
    if (!item || !item.id) continue;
    const local = await getVaultItem(item.id);
    if (!local) { await putVaultItem(item); added++; }
    else if (studiedAt(item) > studiedAt(local)) { await putVaultItem(item); updated++; }
    else kept++;
  }

  // Reading progress: keep whichever position is more recent.
  let progress = 0;
  if (Array.isArray(data.progress) && data.progress.length) {
    const localProg = new Map((await getAllProgress()).map((p) => [p.key, p.value]));
    for (const p of data.progress) {
      if (!p?.key || !p.value) continue;
      const mine = localProg.get(p.key);
      if (!mine || String(p.value.updatedAt || "") > String(mine.updatedAt || "")) {
        await putProgressRecord(p.key, p.value);
        progress++;
      }
    }
  }

  // Activity: union of days, taking the larger count for each.
  if (data.activity?.days) {
    const mine = await getActivity();
    for (const [day, counts] of Object.entries(data.activity.days)) {
      const cur = mine.days[day] || {};
      const merged = { ...cur };
      for (const [k, v] of Object.entries(counts || {})) merged[k] = Math.max(cur[k] || 0, v || 0);
      mine.days[day] = merged;
    }
    await putActivity(mine);
  }

  window.dispatchEvent(new CustomEvent("vault:changed"));
  return { added, updated, kept, progress };
}

// ── Storage protection ──
// Ask the browser to treat this app's storage as persistent so iOS doesn't
// evict it under storage pressure. Home-screen apps are normally granted.
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return null; }
}
export async function isPersisted() {
  try { return navigator.storage?.persisted ? await navigator.storage.persisted() : null; }
  catch { return null; }
}
