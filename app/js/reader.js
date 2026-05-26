import { getChapter, getProgress, putProgress, getSettings } from "./db.js";

const pagesEl = () => document.getElementById("reader-pages");
const indicatorEl = () => document.getElementById("page-indicator");

let _state = {
  bookId: null,
  chapterId: null,
  chapter: null,
  pagesCount: 0,
  currentPage: 0,
  saveTimer: null,
};

// Color palette for chunk color-coding. Soft pastels that sit well on a dark
// background. Cycled per pair (resets every clause so colors stay distinct
// within the immediate reading window).
const CHUNK_COLORS = 7;

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function chunkPairs(pairs, perPage) {
  const out = [];
  for (let i = 0; i < pairs.length; i += perPage) {
    out.push(pairs.slice(i, i + perPage));
  }
  return out;
}

/**
 * Render a single pair as a row of interlinear chunks.
 *
 * Each chunk is an inline-block with pinyin on top and English directly under.
 * Wrapping happens between chunks (not inside a Chinese word) so pinyin/English
 * coupling is always preserved.
 *
 * For pairs without alignment data, the whole clause is rendered as one big
 * chunk (no color, no per-word tap).
 */
function renderPair(pair) {
  const hasAlignment = Array.isArray(pair.alignment) && pair.alignment.length > 0;

  if (!hasAlignment) {
    // Fallback: single chunk, normal wrapping.
    return `
      <div class="pair pair-plain">
        <span class="chunk chunk-plain">
          <span class="target">${escape(pair.target)}</span>
          <span class="english">${escape(pair.english)}</span>
        </span>
      </div>
    `;
  }

  const chunksHtml = pair.alignment.map((c, i) => {
    const colorIdx = i % CHUNK_COLORS;
    const cat = c.category ? ` data-cat="${escape(c.category)}"` : "";
    const freq = c.frequency_band ? ` data-freq="${escape(c.frequency_band)}"` : "";
    const idiom = c.is_idiom ? " data-idiom=\"true\"" : "";
    return `
      <span class="chunk" data-color="${colorIdx}"${cat}${freq}${idiom}>
        <span class="target">${escape(c.target)}</span>
        <span class="english">${escape(c.english)}</span>
      </span>
    `;
  }).join("");

  return `<div class="pair">${chunksHtml}</div>`;
}

function renderChapter(chapter, perPage) {
  const container = pagesEl();
  container.innerHTML = "";

  // Title page.
  const titlePage = document.createElement("section");
  titlePage.className = "reader-page title-page";
  titlePage.innerHTML = `
    <div class="target">${escape(chapter.title.target)}</div>
    <div class="english">${escape(chapter.title.english)}</div>
  `;
  container.appendChild(titlePage);

  // Content pages.
  const chunks = chunkPairs(chapter.pairs, perPage);
  for (const chunk of chunks) {
    const page = document.createElement("section");
    page.className = "reader-page";
    page.innerHTML = chunk.map(renderPair).join("");
    container.appendChild(page);
  }

  _state.pagesCount = 1 + chunks.length;
}

function updateIndicator() {
  indicatorEl().textContent = `${_state.currentPage + 1} / ${_state.pagesCount}`;
}

function pageFromScroll(container) {
  const w = container.clientWidth;
  if (w === 0) return 0;
  return Math.round(container.scrollLeft / w);
}

function scrollToPage(container, page) {
  const w = container.clientWidth;
  container.scrollTo({ left: w * page, behavior: "instant" in container ? "auto" : "auto" });
}

function handleScroll() {
  const container = pagesEl();
  const page = pageFromScroll(container);
  if (page === _state.currentPage) return;
  _state.currentPage = page;
  updateIndicator();
  clearTimeout(_state.saveTimer);
  _state.saveTimer = setTimeout(() => {
    if (_state.bookId && _state.chapterId) {
      putProgress(_state.bookId, _state.chapterId, _state.currentPage);
    }
  }, 300);
}

export async function openReader(bookId, chapterId) {
  const chapter = await getChapter(bookId, chapterId);
  if (!chapter) {
    console.error("Chapter not downloaded:", bookId, chapterId);
    return false;
  }
  const settings = await getSettings();
  const progress = await getProgress(bookId, chapterId);

  _state.bookId = bookId;
  _state.chapterId = chapterId;
  _state.chapter = chapter;
  _state.currentPage = 0;

  renderChapter(chapter, settings.pairsPerPage);

  document.getElementById("title").textContent = chapter.title.english;

  const container = pagesEl();
  requestAnimationFrame(() => {
    const startPage = Math.min(Math.max(progress?.lastPage ?? 0, 0), _state.pagesCount - 1);
    _state.currentPage = startPage;
    scrollToPage(container, startPage);
    updateIndicator();
  });

  container.removeEventListener("scroll", handleScroll);
  container.addEventListener("scroll", handleScroll, { passive: true });

  return true;
}

export function closeReader() {
  const container = pagesEl();
  container.removeEventListener("scroll", handleScroll);
  clearTimeout(_state.saveTimer);
  if (_state.bookId && _state.chapterId) {
    putProgress(_state.bookId, _state.chapterId, _state.currentPage);
  }
  _state.bookId = null;
  _state.chapterId = null;
  _state.chapter = null;
  _state.pagesCount = 0;
  _state.currentPage = 0;
  pagesEl().innerHTML = "";
}
