// IndexedDB wrapper for the bilingual reader (v2 schema — books as containers).
//
// Stores:
//   books    — keyed by book id. Stores the full book metadata + cover Blob.
//              Chapter contents are stored separately in `chapters`.
//   chapters — keyed by `<book_id>/<chapter_id>`. Stores full chapter JSON.
//   progress — keyed by `<book_id>/<chapter_id>`. { lastPage, updatedAt }.
//   library  — single record at key "current". The last-fetched library.json.
//   settings — single record at key "current". App settings.

const DB_NAME = "bilingual-reader";
const DB_VERSION = 2;

const STORE_BOOKS = "books";
const STORE_CHAPTERS = "chapters";
const STORE_PROGRESS = "progress";
const STORE_LIBRARY = "library";
const STORE_SETTINGS = "settings";

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      // v1 -> v2: wipe everything and start over. The old `chapters` store
      // used `id` as keyPath which doesn't fit the new composite-key model,
      // and the old library cache uses the v1 schema. For a personal-use
      // app it's simpler to re-add via Browse than to write a data migration.
      if (oldVersion < 2) {
        for (const name of Array.from(db.objectStoreNames)) {
          db.deleteObjectStore(name);
        }
      }

      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
        db.createObjectStore(STORE_CHAPTERS);
      }
      if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
        db.createObjectStore(STORE_PROGRESS);
      }
      if (!db.objectStoreNames.contains(STORE_LIBRARY)) {
        db.createObjectStore(STORE_LIBRARY);
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS);
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

export function chapterKey(bookId, chapterId) {
  return `${bookId}/${chapterId}`;
}

// ---------- books ----------
export async function putBook(book) {
  const store = await tx(STORE_BOOKS, "readwrite");
  return asPromise(store.put(book));
}
export async function getBook(id) {
  const store = await tx(STORE_BOOKS);
  return asPromise(store.get(id));
}
export async function getAllBooks() {
  const store = await tx(STORE_BOOKS);
  return asPromise(store.getAll());
}
export async function deleteBook(id) {
  const store = await tx(STORE_BOOKS, "readwrite");
  return asPromise(store.delete(id));
}

// ---------- chapters ----------
export async function putChapter(bookId, chapterId, chapterJson) {
  const store = await tx(STORE_CHAPTERS, "readwrite");
  return asPromise(store.put(chapterJson, chapterKey(bookId, chapterId)));
}
export async function getChapter(bookId, chapterId) {
  const store = await tx(STORE_CHAPTERS);
  return asPromise(store.get(chapterKey(bookId, chapterId)));
}
export async function deleteChapter(bookId, chapterId) {
  const store = await tx(STORE_CHAPTERS, "readwrite");
  return asPromise(store.delete(chapterKey(bookId, chapterId)));
}
export async function getAllChapterKeys() {
  const store = await tx(STORE_CHAPTERS);
  return asPromise(store.getAllKeys());
}

// ---------- progress ----------
export async function putProgress(bookId, chapterId, lastPage) {
  const store = await tx(STORE_PROGRESS, "readwrite");
  return asPromise(store.put({ lastPage, updatedAt: new Date().toISOString() }, chapterKey(bookId, chapterId)));
}
export async function getProgress(bookId, chapterId) {
  const store = await tx(STORE_PROGRESS);
  return asPromise(store.get(chapterKey(bookId, chapterId)));
}

// ---------- library cache ----------
export async function putLibrary(library) {
  const store = await tx(STORE_LIBRARY, "readwrite");
  return asPromise(store.put(library, "current"));
}
export async function getLibrary() {
  const store = await tx(STORE_LIBRARY);
  return asPromise(store.get("current"));
}

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  libraryUrl: "../content/library.json",
  fontSize: "medium",
  pairsPerPage: 7,
  openaiKey: "", // user-pasted via Settings; used only for tap-to-learn explanations
};

export async function getSettings() {
  const store = await tx(STORE_SETTINGS);
  const stored = await asPromise(store.get("current"));
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}
export async function putSettings(settings) {
  const store = await tx(STORE_SETTINGS, "readwrite");
  return asPromise(store.put(settings, "current"));
}

// ---------- nuke ----------
export async function clearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(
      [STORE_BOOKS, STORE_CHAPTERS, STORE_PROGRESS, STORE_LIBRARY, STORE_SETTINGS],
      "readwrite"
    );
    for (const name of [STORE_BOOKS, STORE_CHAPTERS, STORE_PROGRESS, STORE_LIBRARY, STORE_SETTINGS]) {
      t.objectStore(name).clear();
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
