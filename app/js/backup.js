// Backup / restore of the learner's own data, plus storage protection.
//
// What's in a backup: every Memory Vault word (all languages, with quiz history),
// reading progress, daily activity, safe settings and locally generated practice
// stories. Catalogue chapters can be downloaded again. Audio, the OpenAI key
// and the feedback token are excluded from the backup.
//
// Restore MERGES rather than replaces: words missing locally are added, words on
// both sides keep whichever copy was studied more recently, and progress keeps
// the later position. So restoring an old backup can never wipe newer work.

import {
  getAllVaultItems, getVaultItem, putVaultItem,
  getAllBooks, getBook, putBook, getChapter, putChapter, getSettings,
  getAllProgress, putProgressRecord, getActivity, putActivity, updateSettings, dayKey,
} from "./db.js";
import { APP_VERSION } from "./version.js";

const KIND = "bilingual-reader-backup";
const FORMAT = 2;
const safeSettings = settings => { const { openaiKey, feedbackToken, ...safe } = settings || {}; return safe; };

export async function buildBackup() {
  const [vault, progress, activity] = await Promise.all([getAllVaultItems(), getAllProgress(), getActivity()]);
  const settings = safeSettings(await getSettings());
  const stories = [];
  for (const book of await getAllBooks()) {
    if (!book.id.startsWith("practice-")) continue;
    const chapters = [];
    for (const entry of book.chapters || []) { const chapter = await getChapter(book.id, entry.id); if (chapter) chapters.push(chapter); }
    const { coverBlob, chapterIndex, downloadedChapterVersions, downloadedChapterCount, ...metadata } = book;
    stories.push({ book: metadata, chapters });
  }
  return {
    kind: KIND,
    format: FORMAT,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    vault,
    progress,
    activity, settings, stories,
  };
}

/**
 * Save a backup file. On iPhone this opens the share sheet (Save to Files,
 * AirDrop, iCloud Drive…); elsewhere it downloads the file.
 * Returns { ok, count, how } — how: "shared" | "downloaded" | "cancelled".
 */
export async function prepareBackup() {
  const data = await buildBackup();
  const file = new File([JSON.stringify(data, null, 1)], `reader-backup-${dayKey()}.json`, { type: "application/json" });
  return { data, file };
}

// Prepared before the tap: share() is invoked before any await so the gesture
// survives on iOS. A download is an export, not confirmation of a saved backup.
export async function exportBackup(prepared) {
  if (!prepared) return { ok: false, how: "not-ready", count: 0 };
  const { data, file } = prepared;
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Reader backup" }); }
    catch (error) { return { ok: false, count: data.vault.length, how: error?.name === "AbortError" ? "cancelled" : "failed" }; }
    await updateSettings({ lastBackupAt: new Date().toISOString() });
    return { ok: true, count: data.vault.length, how: "shared" };
  }
  downloadFile(file);
  await updateSettings({ lastBackupDownloadAt: new Date().toISOString() });
  return { ok: true, count: data.vault.length, how: "downloaded" };
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

  if (![1, 2].includes(data.format)) throw new Error("This backup format is not supported by this app version.");
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

  let stories = 0;
  for (const entry of data.stories || []) {
    const incoming = entry?.book;
    if (!incoming?.id?.startsWith("practice-") || !Array.isArray(entry.chapters)) continue;
    const existing = await getBook(incoming.id);
    const merged = { ...incoming, ...existing, coverBlob: existing?.coverBlob || null, chapters: [...(existing?.chapters || [])] };
    for (const chapter of entry.chapters) {
      if (!chapter?.id || chapter.book_id !== incoming.id || !Array.isArray(chapter.pairs) || !chapter.pairs.length) continue;
      const meta = incoming.chapters?.find(c => c.id === chapter.id);
      if (!meta) continue;
      if (!await getChapter(incoming.id, chapter.id)) { await putChapter(incoming.id, chapter.id, chapter); stories++; }
      if (!merged.chapters.some(c => c.id === chapter.id)) merged.chapters.push(meta);
    }
    await putBook(merged);
  }
  if (data.settings && typeof data.settings === "object" && !Array.isArray(data.settings)) await updateSettings(safeSettings(data.settings));
  window.dispatchEvent(new CustomEvent("vault:changed"));
  window.dispatchEvent(new CustomEvent("settings:libraryUrl"));
  return { added, updated, kept, progress, stories };
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
