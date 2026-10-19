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
const DB_VERSION = 3;

const STORE_BOOKS = "books";
const STORE_CHAPTERS = "chapters";
const STORE_PROGRESS = "progress";
const STORE_LIBRARY = "library";
const STORE_SETTINGS = "settings";
const STORE_VAULT = "vault";   // saved words for spaced-repetition review

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
      // v2 -> v3: add the Memory Vault store (keyed by the word's id). Additive
      // — existing books/chapters/progress/settings are untouched.
      if (!db.objectStoreNames.contains(STORE_VAULT)) {
        db.createObjectStore(STORE_VAULT, { keyPath: "id" });
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
// `pair` = the first sentence on that page (-1 on the end page), so the place
// survives layout changes (English on/off re-paginates the chapter).
export async function putProgress(bookId, chapterId, lastPage, pair = null) {
  const store = await tx(STORE_PROGRESS, "readwrite");
  return asPromise(store.put({ lastPage, pair, updatedAt: new Date().toISOString() }, chapterKey(bookId, chapterId)));
}
export async function getProgress(bookId, chapterId) {
  const store = await tx(STORE_PROGRESS);
  return asPromise(store.get(chapterKey(bookId, chapterId)));
}
/** Write a raw progress record by its "<book>/<chapter>" key (used by restore). */
export async function putProgressRecord(key, value) {
  const store = await tx(STORE_PROGRESS, "readwrite");
  return asPromise(store.put(value, key));
}
/** Every progress record as { key: "<book>/<chapter>", value: {lastPage, updatedAt} }. */
export async function getAllProgress() {
  const store = await tx(STORE_PROGRESS);
  const [keys, values] = await Promise.all([asPromise(store.getAllKeys()), asPromise(store.getAll())]);
  return keys.map((key, i) => ({ key: String(key), value: values[i] }));
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

// ---------- vault (saved words) ----------
export async function putVaultItem(item) {
  const store = await tx(STORE_VAULT, "readwrite");
  return asPromise(store.put(item));
}
export async function getVaultItem(id) {
  const store = await tx(STORE_VAULT);
  return asPromise(store.get(id));
}
export async function getAllVaultItems() {
  const store = await tx(STORE_VAULT);
  return asPromise(store.getAll());
}
export async function deleteVaultItem(id) {
  const store = await tx(STORE_VAULT, "readwrite");
  return asPromise(store.delete(id));
}

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  libraryUrl: "../content/library.json",
  learningLanguage: "zh",   // which language the user is currently learning
  fontSize: "medium",
  pairsPerPage: 7,
  openaiKey: "", // user-pasted via Settings; used only for tap-to-learn explanations
  // Memory Vault quiz preferences.
  reviewAnswerMode: "mix",           // "choice" | "type" | "mix"
  reviewDirection: "mix",            // "t2e" | "e2t" | "mix"
  reviewBuckets: ["new", "learning"], // which mastery groups to quiz
  reviewLength: "20",                // "10" | "20" | "30" | "all" | "endless"
  reviewScript: "both",              // how Chinese shows in quizzes: "hanzi" | "pinyin" | "both"
  hideMastered: true,                // hide English for mastered words in the reader
  showEnglish: true,                 // false = target language only, flowing like a book
  myLevel: 2,                        // learner level 1–6 (Newbie … Advanced), see levels.js
  // Per-category visibility for English translations in the reader. Toggled
  // via the reader-options sheet. When a category is false, the English part
  // of those chunks is rendered with visibility:hidden so the page layout
  // doesn't shift — the pinyin stays visible and tappable.
  categoryVisibility: {
    noun: true,
    verb: true,
    adjective: true,
    adverb: true,
    idiom: true,
    proper_noun: true,
    measure_word: true,
    function_word: true,
    particle: true,
    other: true,
  },
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

/**
 * Merge `patch` into the stored settings inside ONE readwrite transaction, so two
 * quick changes (e.g. two toggles) can't read the same old record and overwrite
 * each other. Prefer this over getSettings() + putSettings(). Returns the result.
 */
export async function updateSettings(patch) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_SETTINGS, "readwrite");
    const store = t.objectStore(STORE_SETTINGS);
    let next = null;
    const req = store.get("current");
    req.onsuccess = () => {
      next = { ...DEFAULT_SETTINGS, ...(req.result || {}), ...patch };
      store.put(next, "current");
    };
    t.oncomplete = () => resolve(next);
    t.onerror = () => reject(t.error);
  });
}

// ---------- daily activity (streak + today's counts) ----------
// Stored in the settings store under its own key: { days: { "YYYY-MM-DD": { pages, answers } } }.
const ACTIVITY_KEY = "activity";
const ACTIVITY_KEEP_DAYS = 400;

/** Local calendar date as YYYY-MM-DD. */
export function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function getActivity() {
  const store = await tx(STORE_SETTINGS);
  const rec = await asPromise(store.get(ACTIVITY_KEY));
  return rec && rec.days ? rec : { days: {} };
}

/** Add to today's counters, e.g. bumpActivity({ pages: 1 }). Atomic, like updateSettings. */
export async function bumpActivity(counts) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_SETTINGS, "readwrite");
    const store = t.objectStore(STORE_SETTINGS);
    const req = store.get(ACTIVITY_KEY);
    req.onsuccess = () => {
      const rec = req.result && req.result.days ? req.result : { days: {} };
      const today = dayKey();
      const day = rec.days[today] || { pages: 0, answers: 0 };
      for (const [k, v] of Object.entries(counts)) day[k] = (day[k] || 0) + v;
      rec.days[today] = day;
      const keys = Object.keys(rec.days).sort();
      while (keys.length > ACTIVITY_KEEP_DAYS) delete rec.days[keys.shift()];
      store.put(rec, ACTIVITY_KEY);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
export async function putActivity(rec) {
  const store = await tx(STORE_SETTINGS, "readwrite");
  return asPromise(store.put(rec && rec.days ? rec : { days: {} }, ACTIVITY_KEY));
}

// ---------- nuke ----------
export async function clearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const stores = [STORE_BOOKS, STORE_CHAPTERS, STORE_PROGRESS, STORE_LIBRARY, STORE_SETTINGS, STORE_VAULT];
    const t = db.transaction(stores, "readwrite");
    for (const name of stores) {
      t.objectStore(name).clear();
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
