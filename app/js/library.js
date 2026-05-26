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
  getProgress,
  chapterKey,
} from "./db.js";

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
  return map;
}

function renderHomeCounts() {
  const downloaded = state.downloadedBooks.size;
  const catalog = (state.catalog?.books || []).filter((b) => b.language === "zh").length;
  $("tile-library-count").textContent = downloaded === 0
    ? "Your downloaded books"
    : `${downloaded} book${downloaded === 1 ? "" : "s"}`;
  $("tile-browse-count").textContent = catalog === 0
    ? "Add new books to your library"
    : `${catalog} available`;
}

/* ============ LIBRARY VIEW (downloaded books grid) ============ */

export function renderLibrary() {
  const grid = $("library-grid");
  const empty = $("library-empty");
  grid.innerHTML = "";

  const books = Array.from(state.downloadedBooks.values()).filter((b) => b.language === "zh");

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

  const books = (state.catalog?.books || []).filter((b) => b.language === "zh");

  if (books.length === 0) {
    $("browse-status").textContent = state.online
      ? "No books found in the catalog."
      : "Offline — no cached catalog yet. Connect to fetch it.";
    return;
  }

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

    let stateLabel, stateCls;
    if (!local) { stateLabel = "Not in library"; stateCls = ""; }
    else if (local.version !== entry.version) { stateLabel = "Update available"; stateCls = "update"; }
    else { stateLabel = "In library"; stateCls = "ok"; }

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
    } else if (local.version !== entry.version) {
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = state.online ? "Update" : "Offline";
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
    // 1. Download cover blob
    let coverBlob = null;
    if (catalogEntry.cover) {
      const coverUrl = resolveUrl(settings.libraryUrl, catalogEntry.cover);
      coverBlob = await fetchBlob(coverUrl);
    }

    // 2. Download every chapter
    const total = catalogEntry.chapters?.length || 0;
    for (let i = 0; i < total; i++) {
      const ch = catalogEntry.chapters[i];
      $("browse-status").textContent = `Downloading chapter ${i + 1}/${total}…`;
      const chUrl = resolveUrl(settings.libraryUrl, ch.url);
      const chJson = await fetchJson(chUrl);
      if (!Array.isArray(chJson.pairs)) throw new Error(`Chapter ${ch.id}: invalid format`);
      await putChapter(catalogEntry.id, ch.id, chJson);
    }

    // 3. Store book metadata
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
      addedAt: new Date().toISOString(),
    };
    await putBook(bookRecord);
    state.downloadedBooks.set(catalogEntry.id, bookRecord);

    $("browse-status").textContent = "";
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

  // Chapter list with per-chapter status indicators
  const list = $("book-detail-chapters");
  list.innerHTML = "";
  const chapters = book.chapters || [];

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
        ${statusHtml}
      </div>
      <span class="chapter-chev">›</span>
    `;
    if (isDownloaded) {
      li.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("nav:reader", { detail: { bookId: book.id, chapterId: ch.id } }));
      });
    } else {
      li.classList.add("locked");
    }
    list.appendChild(li);
  }
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

  renderBrowse();
  renderLibrary();
  renderHomeCounts();
}

export function initCatalog() {
  window.addEventListener("online", () => { state.online = true; refreshCatalog(); });
  window.addEventListener("offline", () => { state.online = false; refreshCatalog(); });
  return refreshCatalog();
}

/* ============ External: ask the catalog for a chapter's content ============ */

export async function loadChapter(bookId, chapterId) {
  return getChapter(bookId, chapterId);
}
