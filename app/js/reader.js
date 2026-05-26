import { getChapter, getProgress, putProgress, getSettings } from "./db.js";

const pagesEl = () => document.getElementById("reader-pages");
const indicatorEl = () => document.getElementById("page-indicator");

let _state = {
  chapter: null,
  pagesCount: 0,
  currentPage: 0,
  saveTimer: null,
};

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
    page.innerHTML = chunk.map((p) => `
      <div class="pair">
        <p class="target">${escape(p.target)}</p>
        <p class="english">${escape(p.english)}</p>
      </div>
    `).join("");
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
  // Debounce progress save.
  clearTimeout(_state.saveTimer);
  _state.saveTimer = setTimeout(() => {
    if (_state.chapter) putProgress(_state.chapter.id, _state.currentPage);
  }, 300);
}

export async function openReader(chapterId) {
  const chapter = await getChapter(chapterId);
  if (!chapter) {
    console.error("Chapter not downloaded:", chapterId);
    return false;
  }
  const settings = await getSettings();
  const progress = await getProgress(chapterId);

  _state.chapter = chapter;
  _state.currentPage = 0;

  renderChapter(chapter, settings.pairsPerPage);

  // Set title in topbar.
  document.getElementById("title").textContent = chapter.title.english;

  const container = pagesEl();
  // Wait a frame so layout is ready before scrolling.
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
  if (_state.chapter) {
    // Final flush.
    putProgress(_state.chapter.id, _state.currentPage);
  }
  _state.chapter = null;
  _state.pagesCount = 0;
  _state.currentPage = 0;
  pagesEl().innerHTML = "";
}
