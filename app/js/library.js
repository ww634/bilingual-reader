import {
  getSettings,
  getLibrary,
  putLibrary,
  getAllBooks,
  putBook,
  deleteBook,
  putChapter,
  deleteChapter,
  getChapter,
  getAllChapterKeys,
  getProgress,
  chapterKey,
  updateSettings,
} from "./db.js";
import { getLearningLanguage, setLearningLanguage, availableLanguages, languageName } from "./languages.js";
import { LEVELS, levelHint, loadLevels, chapterKnowledge, clampLevel } from "./levels.js";
import { bookQuizPrefs } from "./chapterquiz.js";
import { vaultBucketMap } from "./vault.js";
import { isPracticeBook, deletePracticeStory } from "./stories.js";

const $ = (id) => document.getElementById(id);

const state = {
  catalog: null,           // { version, books: [...] } — the fetched library.json
  downloadedBooks: new Map(),  // id -> book record (with coverBlob)
  selectedBookId: null,    // currently shown in book detail view
  online: navigator.onLine,
};

function resolveUrl(libraryUrl, relativeOrAbsolute) {
  const absLibrary = new URL(libraryUrl, window.location.href);
  return new URL(relativeOrAbsolute, absLibrary).toString();
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.json();
}

async function fetchBlob(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  } catch (err) {
    console.warn("Blob fetch failed:", url, err);
    return null;
  }
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function loadDownloadedIndex() {
  const all = await getAllBooks();
  const map = new Map();
  for (const b of all) map.set(b.id, b);

  // Inspect stored content, not the book metadata saved before a download.
  // This also detects an interrupted update when all chapter keys still exist.
  for (const book of map.values()) {
    book.downloadedChapterCount = 0;
    book.downloadedChapterVersions = {};
  }
  const chapterKeys = await getAllChapterKeys();
  await Promise.all(chapterKeys.map(async (key) => {
    const [bookId, chapterId] = String(key).split("/");
    const book = map.get(bookId);
    if (!book) return;
    const chapter = await getChapter(bookId, chapterId);
    if (!chapter?.pairs?.length) return;
    book.downloadedChapterCount++;
    book.downloadedChapterVersions[chapterId] = chapter.catalogVersion ?? chapter.version ?? 1;
  }));
  return map;
}

function renderHomeCounts() {
  const lang = getLearningLanguage();
  const downloaded = Array.from(state.downloadedBooks.values()).filter((b) => b.language === lang).length;
  const catalog = (state.catalog?.books || []).filter((b) => b.language === lang).length;
  $("tile-library-count").textContent = downloaded === 0
    ? "Your downloaded books"
    : `${downloaded} book${downloaded === 1 ? "" : "s"}`;
  $("tile-browse-count").textContent = catalog === 0
    ? "Add new books to your library"
    : `${catalog} available`;
}

// Every language that has content (catalog or downloaded), used to populate the
// switchers alongside the always-on base languages.
function contentLanguages() {
  const codes = new Set();
  for (const b of state.catalog?.books || []) if (b.language) codes.add(b.language);
  for (const b of state.downloadedBooks.values()) if (b.language) codes.add(b.language);
  return [...codes];
}

// Fill every .lang-switch select with the available languages and the current
// selection. Called after each catalog refresh and on language change.
export function populateLangSwitchers() {
  const current = getLearningLanguage();
  const codes = availableLanguages(contentLanguages());
  for (const sel of document.querySelectorAll(".lang-switch")) {
    sel.innerHTML = codes.map((c) => `<option value="${c}">${languageName(c)}</option>`).join("");
    sel.value = current;
  }
}

/* ============ LIBRARY VIEW (downloaded books grid) ============ */

export function renderLibrary() {
  const grid = $("library-grid");
  const empty = $("library-empty");
  grid.innerHTML = "";

  const books = Array.from(state.downloadedBooks.values()).filter((b) => b.language === getLearningLanguage());

  if (books.length === 0) {
    grid.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  grid.hidden = false;

  for (const book of books) {
    const card = document.createElement("button");
    card.className = "book-card";
    card.setAttribute("data-book-id", book.id);

    const coverObjUrl = book.coverBlob ? URL.createObjectURL(book.coverBlob) : null;
    const hasCover = !!coverObjUrl;
    const coverInner = hasCover
      ? `<img src="${escape(coverObjUrl)}" alt="" loading="lazy" />`
      : `<div class="placeholder">${escape(book.title?.english || book.id)}</div>`;

    card.innerHTML = `
      <div class="book-cover ${hasCover ? "" : "placeholder"}">${coverInner}</div>
      <div class="book-meta">
        <div class="book-title">${escape(book.title?.english || book.id)}</div>
        <div class="book-sub">${escape(book.author || book.title?.target || "")}</div>
      </div>
    `;
    card.addEventListener("click", () => openBookDetail(book.id));
    grid.appendChild(card);
  }
}

/* ============ BROWSE VIEW (catalog list) ============ */

export function renderBrowse() {
  const list = $("browse-list");
  list.innerHTML = "";

  const books = (state.catalog?.books || []).filter((b) => b.language === getLearningLanguage());

  if (books.length === 0) {
    $("browse-status").textContent = state.online
      ? `No ${languageName(getLearningLanguage())} books available yet.`
      : "Offline — no cached catalog yet. Connect to fetch it.";
    return;
  }

  if (!$("browse-status").classList.contains("error")) $("browse-status").textContent = "";

  for (const entry of books) {
    const local = state.downloadedBooks.get(entry.id);
    const li = document.createElement("li");
    li.className = "book-list-row";

    const coverUrl = entry._coverResolved;
    const coverInner = coverUrl
      ? `<img src="${escape(coverUrl)}" alt="" loading="lazy" />`
      : `<div class="placeholder">${escape(entry.title?.english || entry.id)}</div>`;

    const chapterCount = entry.chapters?.length || 0;
    const subline = entry.author
      ? `${escape(entry.author)}  ·  ${chapterCount} ch.`
      : `${chapterCount} chapter${chapterCount === 1 ? "" : "s"}`;

    const expectedChapters = entry.chapters?.length || 0;
    const downloadedChapters = local?.downloadedChapterCount || 0;
    const isPartial =
      !!local &&
      expectedChapters > 0 &&
      downloadedChapters < expectedChapters;

    const hasUpdate = !!local && (
      local.version !== entry.version ||
      entry.chapters.some((chapter) => {
        const stored = local.downloadedChapterVersions[chapter.id];
        return stored !== undefined && stored !== (chapter.version ?? 1);
      })
    );
    let stateLabel, stateCls;
    if (!local) { stateLabel = "Not in library"; stateCls = ""; }
    else if (hasUpdate) { stateLabel = "Update available"; stateCls = "update"; }
    else if (isPartial) {
      stateLabel = `Partial · ${downloadedChapters}/${expectedChapters} ch.`;
      stateCls = "update";
    } else { stateLabel = "In library"; stateCls = "ok"; }

    li.innerHTML = `
      <div class="row-cover ${coverUrl ? "" : "placeholder"}">${coverInner}</div>
      <div class="row-text">
        <div class="row-target">${escape(entry.title?.english || entry.id)}</div>
        <div class="row-english">${subline}</div>
        <div class="row-state ${stateCls}">${stateLabel}</div>
      </div>
      <div class="row-actions"></div>
    `;
    const actions = li.querySelector(".row-actions");

    if (!local) {
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = state.online ? "Add" : "Offline";
      btn.disabled = !state.online;
      if (state.online) btn.addEventListener("click", () => downloadBook(entry, btn));
      actions.appendChild(btn);
    } else if (hasUpdate) {
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = state.online ? "Update" : "Offline";
      btn.disabled = !state.online;
      if (state.online) btn.addEventListener("click", () => downloadBook(entry, btn));
      actions.appendChild(btn);
    } else if (isPartial) {
      // Partial download — re-tapping picks up where it left off.
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = state.online
        ? `Resume ${downloadedChapters}/${expectedChapters}`
        : "Offline";
      btn.disabled = !state.online;
      if (state.online) btn.addEventListener("click", () => downloadBook(entry, btn));
      actions.appendChild(btn);
    } else {
      const btn = document.createElement("button");
      btn.textContent = "Open";
      btn.addEventListener("click", () => openBookDetail(entry.id));
      actions.appendChild(btn);
    }

    list.appendChild(li);
  }
}

async function downloadBook(catalogEntry, btn) {
  const settings = await getSettings();
  btn.disabled = true;
  btn.textContent = "Adding…";
  $("browse-status").classList.remove("error");
  $("browse-status").textContent = `Adding "${catalogEntry.title?.english || catalogEntry.id}"…`;

  try {
    // 1. Cover: reuse existing if we have a local record, otherwise fetch.
    const existingRecord = state.downloadedBooks.get(catalogEntry.id);
    let coverBlob = existingRecord?.coverBlob || null;
    if (!coverBlob && catalogEntry.cover) {
      const coverUrl = resolveUrl(settings.libraryUrl, catalogEntry.cover);
      coverBlob = await fetchBlob(coverUrl);
    }

    // 2. Save the book record FIRST (with empty/partial state). This makes
    //    the book appear in the library immediately and survives partial
    //    failures — if the network drops mid-download, the partial state
    //    is persisted so re-tapping Add picks up from where it left off.
    const bookRecord = {
      id: catalogEntry.id,
      language: catalogEntry.language,
      version: catalogEntry.version,
      title: catalogEntry.title,
      author: catalogEntry.author || "",
      synopsis: catalogEntry.synopsis || "",
      genres: Array.isArray(catalogEntry.genres) ? catalogEntry.genres : [],
      chapters: catalogEntry.chapters.map((c) => ({
        id: c.id,
        version: c.version,
        title: c.title,
        url: c.url,
      })),
      coverBlob,
      addedAt: existingRecord?.addedAt || new Date().toISOString(),
    };
    await putBook(bookRecord);
    state.downloadedBooks.set(catalogEntry.id, bookRecord);

    // 3. Replace stale chapters, and resume missing ones after a failure.
    //    Reading progress and saved vocabulary live separately and stay intact.
    const total = catalogEntry.chapters?.length || 0;
    let downloadedCount = 0;
    let skippedCount = 0;
    for (let i = 0; i < total; i++) {
      const ch = catalogEntry.chapters[i];
      // Check if this chapter is already in IndexedDB.
      const existing = await getChapter(catalogEntry.id, ch.id);
      if (existing && Array.isArray(existing.pairs) && existing.pairs.length > 0 &&
          (existing.catalogVersion ?? existing.version ?? 1) === (ch.version ?? 1)) {
        skippedCount++;
        continue;
      }
      $("browse-status").textContent = `Downloading chapter ${i + 1}/${total}…`;
      const chUrl = resolveUrl(settings.libraryUrl, ch.url);
      const chJson = await fetchJson(chUrl);
      if (!Array.isArray(chJson.pairs)) throw new Error(`Chapter ${ch.id}: invalid format`);
      // Older content files may have their own unrelated version number.
      chJson.catalogVersion = ch.version ?? 1;
      await putChapter(catalogEntry.id, ch.id, chJson);
      downloadedCount++;
    }

    $("browse-status").textContent = "";
    if (skippedCount > 0 && downloadedCount === 0) {
      // Nothing new — must have been called when book was already complete.
    }
    // Refresh the downloaded index so partial/complete state reflects what's
    // now in IndexedDB. Without this the UI would still show the pre-download
    // chapter count and keep the "Resume" button visible.
    state.downloadedBooks = await loadDownloadedIndex();
    renderBrowse();
    renderLibrary();
    renderHomeCounts();
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Retry";
    $("browse-status").textContent = `Could not add: ${err.message}`;
    $("browse-status").classList.add("error");
  }
}

/* ============ BOOK DETAIL helpers ============ */

/**
 * For a downloaded book, compute reading progress aggregated across chapters.
 * Returns:
 *   {
 *     totalPages, currentPosition, pct,
 *     totalChapters, currentChapterIndex,
 *     lastReadChapterId, lastReadPage, lastReadTime,
 *     chapterProgress: Map<chapterId, { lastPage, totalPages, updatedAt }>
 *   }
 *
 * Returns null if the book isn't downloaded.
 */
async function computeBookProgress(book) {
  if (!book || !book.chapters) return null;
  const settings = await getSettings();
  const perPage = settings.pairsPerPage || 7;
  let totalPages = 0;
  let lastReadChapterId = null;
  let lastReadPage = 0;
  let lastReadTime = "";
  const chapterProgress = new Map();
  const chapterPagesById = new Map();

  for (const chMeta of book.chapters) {
    const chapter = await getChapter(book.id, chMeta.id);
    if (!chapter) { chapterPagesById.set(chMeta.id, 0); continue; }
    // Pages = 1 (title page) + ceil(pairs / perPage)
    const chPages = 1 + Math.max(1, Math.ceil(chapter.pairs.length / perPage));
    chapterPagesById.set(chMeta.id, chPages);
    totalPages += chPages;

    const prog = await getProgress(book.id, chMeta.id);
    if (prog) {
      chapterProgress.set(chMeta.id, {
        lastPage: prog.lastPage,
        totalPages: chPages,
        updatedAt: prog.updatedAt,
      });
      if (!lastReadTime || prog.updatedAt > lastReadTime) {
        lastReadTime = prog.updatedAt;
        lastReadChapterId = chMeta.id;
        lastReadPage = prog.lastPage;
      }
    }
  }

  // Find the position in the book at the user's furthest-read chapter.
  // We compute "currentPosition" as pages-before-active-chapter + lastReadPage + 1.
  let currentPosition = 1;
  let currentChapterIndex = 0;
  if (lastReadChapterId) {
    for (let i = 0; i < book.chapters.length; i++) {
      const ch = book.chapters[i];
      if (ch.id === lastReadChapterId) {
        currentChapterIndex = i;
        currentPosition += lastReadPage;
        break;
      }
      currentPosition += chapterPagesById.get(ch.id) || 0;
    }
  }

  const pct = totalPages > 0 ? Math.min(100, Math.round((currentPosition / totalPages) * 100)) : 0;

  return {
    totalPages,
    currentPosition,
    pct,
    totalChapters: book.chapters.length,
    currentChapterIndex,
    lastReadChapterId,
    lastReadPage,
    lastReadTime,
    chapterProgress,
  };
}

/* ============ BOOK DETAIL (chapter picker) ============ */

export async function openBookDetail(bookId) {
  state.selectedBookId = bookId;
  await renderBookDetail();
  window.dispatchEvent(new CustomEvent("nav:bookDetail", { detail: { id: bookId } }));
}

export async function renderBookDetail() {
  const book = state.downloadedBooks.get(state.selectedBookId)
    || (state.catalog?.books || []).find((b) => b.id === state.selectedBookId);
  if (!book) return;

  const isDownloaded = state.downloadedBooks.has(book.id);

  // Cover
  const coverContainer = $("book-detail-cover");
  coverContainer.innerHTML = "";
  if (isDownloaded && book.coverBlob) {
    const img = document.createElement("img");
    img.src = URL.createObjectURL(book.coverBlob);
    coverContainer.appendChild(img);
    coverContainer.classList.remove("placeholder");
  } else if (book._coverResolved || book.cover) {
    const img = document.createElement("img");
    img.src = book._coverResolved || resolveUrlFromCachedSettings(book.cover);
    coverContainer.appendChild(img);
    coverContainer.classList.remove("placeholder");
  } else {
    coverContainer.innerHTML = `<div class="placeholder">${escape(book.title?.english || book.id)}</div>`;
    coverContainer.classList.add("placeholder");
  }

  // Header text
  const englishTitle = book.title?.english || book.id;
  $("book-detail-title").textContent = englishTitle;
  $("book-detail-target").textContent = book.title?.target || "";
  $("book-detail-author").textContent = book.author || "";
  $("book-detail-synopsis").textContent = book.synopsis || "";
  // Topbar reflects the book name while on this screen.
  const topTitle = document.getElementById("title");
  if (topTitle && document.body.dataset.view !== "reader") topTitle.textContent = englishTitle;

  // Genre pills
  const genresEl = $("book-detail-genres");
  genresEl.innerHTML = "";
  const genres = Array.isArray(book.genres) ? book.genres : [];
  for (const g of genres) {
    const pill = document.createElement("span");
    pill.className = "genre-pill";
    pill.textContent = g;
    genresEl.appendChild(pill);
  }

  // Progress + Continue button. Only meaningful if the book is downloaded.
  const progressEl = $("book-detail-progress");
  const progressFill = $("book-detail-progress-fill");
  const progressSummary = $("book-detail-progress-summary");
  const progressPct = $("book-detail-progress-pct");
  const continueBtn = $("book-detail-continue");

  let firstChapterId = book.chapters?.[0]?.id || null;
  let resumeChapterId = firstChapterId;

  if (isDownloaded) {
    const p = await computeBookProgress(book);
    const hasStarted = !!p?.lastReadChapterId;
    if (hasStarted && p.totalPages > 0) {
      progressEl.hidden = false;
      progressFill.style.width = `${p.pct}%`;
      const chLabel = `Chapter ${p.currentChapterIndex + 1} of ${p.totalChapters}`;
      const pgLabel = `· Page ${p.currentPosition} of ${p.totalPages}`;
      progressSummary.textContent = `${chLabel} ${pgLabel}`;
      progressPct.textContent = `${p.pct}%`;
      resumeChapterId = p.lastReadChapterId;
    } else {
      progressEl.hidden = true;
    }

    if (continueBtn) {
      continueBtn.textContent = hasStarted ? "Continue reading" : "Start reading";
      continueBtn.disabled = !resumeChapterId;
      continueBtn.onclick = () => {
        if (!resumeChapterId) return;
        window.dispatchEvent(new CustomEvent("nav:reader", {
          detail: { bookId: book.id, chapterId: resumeChapterId },
        }));
      };
      continueBtn.parentElement.hidden = false;
    }
  } else {
    progressEl.hidden = true;
    if (continueBtn) continueBtn.parentElement.hidden = true;
  }

  // End-of-chapter quiz preferences for this book.
  await renderBookQuizPrefs(book, isDownloaded);
  $("book-detail-new-story").hidden = !isPracticeBook(book.id);

  // Chapter list with per-chapter status indicators
  const list = $("book-detail-chapters");
  list.innerHTML = "";
  const chapters = book.chapters || [];
  const practice = isPracticeBook(book.id);

  let perChapterProgress = null;
  if (isDownloaded) {
    const p = await computeBookProgress(book);
    perChapterProgress = p?.chapterProgress || new Map();
  }

  for (const ch of chapters) {
    const li = document.createElement("li");
    li.className = "chapter-row";

    // Per-chapter status badge: read (last page) / in-progress / unread
    let statusHtml = "";
    if (perChapterProgress && perChapterProgress.has(ch.id)) {
      const cp = perChapterProgress.get(ch.id);
      if (cp.lastPage + 1 >= cp.totalPages) {
        statusHtml = `<span class="chapter-status done">finished</span>`;
      } else {
        statusHtml = `<span class="chapter-status reading">page ${cp.lastPage + 1} / ${cp.totalPages}</span>`;
      }
    }

    li.innerHTML = `
      <div class="chapter-info">
        <div class="chapter-title">${escape(ch.title?.english || ch.id)}</div>
        <div class="chapter-target">${escape(ch.title?.target || "")}</div>
        <div class="chapter-badges">${statusHtml}<span class="chapter-known" data-ch="${escape(ch.id)}"></span></div>
      </div>
      ${practice ? `<button class="chapter-del" aria-label="Delete story">×</button>` : ""}
      <span class="chapter-chev">›</span>
    `;
    if (isDownloaded) {
      li.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("nav:reader", { detail: { bookId: book.id, chapterId: ch.id } }));
      });
    } else {
      li.classList.add("locked");
    }
    li.querySelector(".chapter-del")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete the story “${ch.title?.english || ch.id}”?`)) return;
      await deletePracticeStory(book.id, ch.id);
      if (state.downloadedBooks.has(book.id)) renderBookDetail();
      else window.dispatchEvent(new CustomEvent("app:back"));
    });
    list.appendChild(li);
  }

  if (isDownloaded) fillKnownPills(book);
}

// "≈ 84% known" on each chapter row, worked out from the learner's level and
// Memory Vault. Filled in after the list renders (it reads every chapter).
let _knownRun = 0;
async function fillKnownPills(book) {
  const run = ++_knownRun;
  const settings = await getSettings();
  const level = clampLevel(settings.myLevel);
  if (book.language === "zh") await loadLevels();
  const buckets = await vaultBucketMap(book.language);
  for (const ch of book.chapters || []) {
    if (run !== _knownRun || state.selectedBookId !== book.id) return;   // navigated away / re-rendered
    const chapter = await getChapter(book.id, ch.id);
    const pill = document.querySelector(`.chapter-known[data-ch="${CSS.escape(ch.id)}"]`);
    if (!chapter || !pill) continue;
    const k = chapterKnowledge(chapter, level, buckets);
    pill.textContent = `≈${k.pct}% known`;
    pill.className = `chapter-known ${k.pct >= 95 ? "easy" : k.pct >= 85 ? "ok" : "hard"}`;
  }
}

async function renderBookQuizPrefs(book, isDownloaded) {
  const box = $("book-quiz");
  if (!isDownloaded) { box.hidden = true; return; }
  box.hidden = false;
  const prefs = bookQuizPrefs(await getSettings(), book.id);
  const on = $("book-quiz-on");
  on.checked = prefs.on;
  const levels = $("book-quiz-levels");
  levels.innerHTML = LEVELS.map((l) => `<button class="chip${l.n === prefs.level ? " on" : ""}" data-n="${l.n}">${l.name}</button>`).join("");
  const hint = () => {
    const cur = bookQuizPrefs({ bookQuiz: { [book.id]: { on: on.checked, level: +levels.querySelector(".chip.on")?.dataset.n } } }, book.id);
    $("book-quiz-hint").textContent = on.checked
      ? `Tests the chapter's ${book.language === "zh" ? `${levelHint(cur.level, "zh").split(" · ")[0]} words` : levelHint(cur.level, book.language)}. Shown on the last page of each chapter.`
      : "Turned off for this book.";
    levels.classList.toggle("off", !on.checked);
  };
  const save = async (patch) => {
    const s = await getSettings();
    const all = { ...(s.bookQuiz || {}) };
    all[book.id] = { ...bookQuizPrefs(s, book.id), ...patch };
    await updateSettings({ bookQuiz: all });
  };
  on.onchange = () => { hint(); save({ on: on.checked }); };
  levels.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
    levels.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b));
    hint();
    save({ level: +b.dataset.n });
  }));
  hint();
}

// Settings cache for cover URL resolution (used when rendering catalog entries
// in the detail view).
let _cachedSettings = null;
async function ensureCachedSettings() {
  if (!_cachedSettings) _cachedSettings = await getSettings();
  return _cachedSettings;
}
function resolveUrlFromCachedSettings(relPath) {
  if (!_cachedSettings) return relPath;
  return resolveUrl(_cachedSettings.libraryUrl, relPath);
}

/* ============ Catalog refresh ============ */

export async function refreshCatalog() {
  const settings = await getSettings();
  _cachedSettings = settings;
  $("browse-status").classList.remove("error");
  state.downloadedBooks = await loadDownloadedIndex();

  if (state.online) {
    $("browse-status").textContent = "Loading catalog…";
    try {
      const lib = await fetchJson(settings.libraryUrl);
      if (lib?.version && lib.version !== 2) {
        throw new Error(`Library schema v${lib.version} not supported (need v2)`);
      }
      if (lib?.books) {
        for (const book of lib.books) {
          if (book.cover) book._coverResolved = resolveUrl(settings.libraryUrl, book.cover);
        }
      }
      state.catalog = lib;
      await putLibrary(lib);
      $("browse-status").textContent = "";
    } catch (err) {
      console.warn("Catalog fetch failed:", err);
      const cached = await getLibrary();
      state.catalog = cached || { books: [] };
      $("browse-status").textContent = cached
        ? `Showing cached catalog (refresh failed: ${err.message}).`
        : `Could not load catalog: ${err.message}`;
      if (!cached) $("browse-status").classList.add("error");
    }
  } else {
    const cached = await getLibrary();
    state.catalog = cached || { books: [] };
    $("browse-status").textContent = "Offline — showing cached catalog.";
  }

  populateLangSwitchers();
  renderBrowse();
  renderLibrary();
  renderHomeCounts();
}

export function initCatalog() {
  window.addEventListener("online", () => { state.online = true; refreshCatalog(); });
  window.addEventListener("offline", () => { state.online = false; refreshCatalog(); });

  // Any language switcher changes the global learning language.
  for (const sel of document.querySelectorAll(".lang-switch")) {
    sel.addEventListener("change", (e) => setLearningLanguage(e.target.value));
  }
  // Re-render the catalog views whenever the learning language changes.
  window.addEventListener("language:changed", () => {
    populateLangSwitchers();
    renderBrowse();
    renderLibrary();
    renderHomeCounts();
  });

  return refreshCatalog();
}

/* ============ External: ask the catalog for a chapter's content ============ */

export async function loadChapter(bookId, chapterId) {
  return getChapter(bookId, chapterId);
}
