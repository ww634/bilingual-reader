import {
  getSettings,
  getLibrary,
  putLibrary,
  getAllChapters,
  putChapter,
} from "./db.js";

const browseStatusEl = () => document.getElementById("browse-status");
const browseListEl = () => document.getElementById("browse-list");
const libraryGridEl = () => document.getElementById("library-grid");
const libraryEmptyEl = () => document.getElementById("library-empty");
const tileLibraryCount = () => document.getElementById("tile-library-count");
const tileBrowseCount = () => document.getElementById("tile-browse-count");

const state = {
  library: null,           // { version, chapters: [...] } — the catalog
  downloaded: new Map(),   // id -> chapter
  online: navigator.onLine,
};

function resolveUrl(libraryUrl, relativeOrAbsolute) {
  const absLibrary = new URL(libraryUrl, window.location.href);
  return new URL(relativeOrAbsolute, absLibrary).toString();
}

async function fetchLibrary(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Library fetch failed: ${res.status}`);
  return res.json();
}

async function loadDownloadedIndex() {
  const all = await getAllChapters();
  const map = new Map();
  for (const c of all) map.set(c.id, c);
  return map;
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function rowState(entry, local) {
  if (!local) return { label: "Not in library", cls: "" };
  if (local.version !== entry.version) return { label: "Update available", cls: "update" };
  return { label: "In library", cls: "ok" };
}

function coverElement({ coverUrl, fallbackTitle, cls = "" }) {
  if (coverUrl) {
    return `<img class="${cls}" src="${escape(coverUrl)}" alt="" loading="lazy" />`;
  }
  return `<div class="${cls} placeholder">${escape(fallbackTitle)}</div>`;
}

function renderHomeCounts() {
  const downloadedCount = state.downloaded.size;
  const catalogCount = (state.library?.chapters || []).filter(c => c.language === "zh").length;
  tileLibraryCount().textContent = downloadedCount === 0
    ? "Your downloaded books"
    : `${downloadedCount} book${downloadedCount === 1 ? "" : "s"}`;
  tileBrowseCount().textContent = catalogCount === 0
    ? "Add new books to your library"
    : `${catalogCount} available`;
}

/* ============ LIBRARY VIEW (downloaded books grid) ============ */

export function renderLibrary() {
  const grid = libraryGridEl();
  const empty = libraryEmptyEl();
  grid.innerHTML = "";

  const downloaded = Array.from(state.downloaded.values()).filter(c => c.language === "zh");

  if (downloaded.length === 0) {
    grid.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  grid.hidden = false;

  for (const chapter of downloaded) {
    const card = document.createElement("button");
    card.className = "book-card";
    card.setAttribute("data-id", chapter.id);

    const coverObjUrl = chapter._coverBlob ? URL.createObjectURL(chapter._coverBlob) : null;
    const hasCover = !!coverObjUrl;
    const coverHtml = coverElement({
      coverUrl: coverObjUrl,
      fallbackTitle: chapter.title.english,
      cls: "",
    });

    card.innerHTML = `
      <div class="book-cover ${hasCover ? "" : "placeholder"}">
        ${coverHtml}
      </div>
      <div class="book-meta">
        <div class="book-title">${escape(chapter.title.english)}</div>
        <div class="book-sub">${escape(chapter.title.target)}</div>
      </div>
    `;
    card.addEventListener("click", () => openReader(chapter.id));
    grid.appendChild(card);
  }
}

/* ============ BROWSE VIEW (catalog list) ============ */

export function renderBrowse() {
  const list = browseListEl();
  list.innerHTML = "";

  const chapters = (state.library?.chapters || []).filter(c => c.language === "zh");

  if (chapters.length === 0) {
    browseStatusEl().textContent = state.online
      ? "No books found in the catalog."
      : "Offline — no cached catalog yet. Connect to fetch it.";
    return;
  }

  for (const entry of chapters) {
    const local = state.downloaded.get(entry.id);
    const st = rowState(entry, local);

    const li = document.createElement("li");
    li.className = "book-list-row";

    const coverUrl = entry._coverResolved;
    const coverHtml = coverElement({
      coverUrl,
      fallbackTitle: entry.title.english,
      cls: "",
    });

    li.innerHTML = `
      <div class="row-cover ${coverUrl ? "" : "placeholder"}">${coverHtml}</div>
      <div class="row-text">
        <div class="row-target">${escape(entry.title.english)}</div>
        <div class="row-english">${escape(entry.title.target)}</div>
        <div class="row-state ${st.cls}">${st.label}</div>
      </div>
      <div class="row-actions"></div>
    `;
    const actions = li.querySelector(".row-actions");

    if (!local) {
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = state.online ? "Add" : "Offline";
      btn.disabled = !state.online;
      if (state.online) btn.addEventListener("click", () => downloadOne(entry, btn));
      actions.appendChild(btn);
    } else if (local.version !== entry.version) {
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = state.online ? "Update" : "Offline";
      btn.disabled = !state.online;
      if (state.online) btn.addEventListener("click", () => downloadOne(entry, btn));
      actions.appendChild(btn);
    } else {
      const btn = document.createElement("button");
      btn.textContent = "Read";
      btn.addEventListener("click", () => openReader(entry.id));
      actions.appendChild(btn);
    }

    list.appendChild(li);
  }
}

async function fetchCoverBlob(coverUrl) {
  try {
    const res = await fetch(coverUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  } catch (err) {
    console.warn("Cover fetch failed:", coverUrl, err);
    return null;
  }
}

async function downloadOne(entry, btn) {
  const settings = await getSettings();
  const url = resolveUrl(settings.libraryUrl, entry.url);
  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const chapter = await res.json();
    if (!chapter.id || !Array.isArray(chapter.pairs)) {
      throw new Error("Invalid chapter format");
    }
    // Cover: prefer the URL on the catalog entry (library.json), since it's
    // resolved relative to library.json. The chapter's own `cover` field is
    // resolved relative to the chapter file.
    let coverUrl = null;
    if (entry.cover) coverUrl = resolveUrl(settings.libraryUrl, entry.cover);
    else if (chapter.cover) coverUrl = new URL(chapter.cover, url).toString();
    if (coverUrl) {
      const blob = await fetchCoverBlob(coverUrl);
      if (blob) chapter._coverBlob = blob;
    }
    await putChapter(chapter);
    state.downloaded.set(chapter.id, chapter);
    renderBrowse();
    renderLibrary();
    renderHomeCounts();
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Retry";
    browseStatusEl().textContent = `Could not add: ${err.message}`;
    browseStatusEl().classList.add("error");
  }
}

function openReader(id) {
  window.dispatchEvent(new CustomEvent("nav:reader", { detail: { id } }));
}

export async function refreshCatalog() {
  const settings = await getSettings();
  browseStatusEl().classList.remove("error");
  state.downloaded = await loadDownloadedIndex();

  if (state.online) {
    browseStatusEl().textContent = "Loading catalog…";
    try {
      const lib = await fetchLibrary(settings.libraryUrl);
      // Pre-resolve cover URLs in the catalog so we can render them.
      if (lib?.chapters) {
        for (const entry of lib.chapters) {
          if (entry.cover) {
            entry._coverResolved = resolveUrl(settings.libraryUrl, entry.cover);
          }
        }
      }
      state.library = lib;
      await putLibrary(lib);
      browseStatusEl().textContent = "";
    } catch (err) {
      console.warn("Catalog fetch failed:", err);
      const cached = await getLibrary();
      state.library = cached || { chapters: [] };
      browseStatusEl().textContent = cached
        ? `Showing cached catalog (refresh failed: ${err.message}).`
        : `Could not load catalog: ${err.message}`;
      if (!cached) browseStatusEl().classList.add("error");
    }
  } else {
    const cached = await getLibrary();
    state.library = cached || { chapters: [] };
    browseStatusEl().textContent = "Offline — showing cached catalog.";
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
