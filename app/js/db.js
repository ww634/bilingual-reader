// Tiny IndexedDB wrapper. Stores: chapters, progress, library, settings.

const DB_NAME = "bilingual-reader";
const DB_VERSION = 1;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("chapters")) {
        db.createObjectStore("chapters", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("progress")) {
        db.createObjectStore("progress", { keyPath: "chapterId" });
      }
      if (!db.objectStoreNames.contains("library")) {
        db.createObjectStore("library"); // single-key store, key = "current"
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings"); // single-key store, key = "current"
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(storeName, mode = "readonly") {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function asPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- chapters ----------
export async function putChapter(chapter) {
  const store = await tx("chapters", "readwrite");
  return asPromise(store.put(chapter));
}
export async function getChapter(id) {
  const store = await tx("chapters");
  return asPromise(store.get(id));
}
export async function getAllChapters() {
  const store = await tx("chapters");
  return asPromise(store.getAll());
}
export async function deleteChapter(id) {
  const store = await tx("chapters", "readwrite");
  return asPromise(store.delete(id));
}

// ---------- progress ----------
export async function putProgress(chapterId, lastPage) {
  const store = await tx("progress", "readwrite");
  return asPromise(store.put({ chapterId, lastPage, updatedAt: new Date().toISOString() }));
}
export async function getProgress(chapterId) {
  const store = await tx("progress");
  return asPromise(store.get(chapterId));
}

// ---------- library cache ----------
export async function putLibrary(library) {
  const store = await tx("library", "readwrite");
  return asPromise(store.put(library, "current"));
}
export async function getLibrary() {
  const store = await tx("library");
  return asPromise(store.get("current"));
}

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  libraryUrl: "../content/library.json",
  fontSize: "medium",
  pairsPerPage: 7,
};

export async function getSettings() {
  const store = await tx("settings");
  const stored = await asPromise(store.get("current"));
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}
export async function putSettings(settings) {
  const store = await tx("settings", "readwrite");
  return asPromise(store.put(settings, "current"));
}

// ---------- nuke ----------
export async function clearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["chapters", "progress", "library", "settings"], "readwrite");
    t.objectStore("chapters").clear();
    t.objectStore("progress").clear();
    t.objectStore("library").clear();
    t.objectStore("settings").clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
