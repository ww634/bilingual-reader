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

const CHUNK_COLORS = 7;
const NEUTRAL_LEADING = new Set(["the", "a", "an"]);

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
 * For a given pair's alignment, map each content-chunk index to a stable
 * color index. Grammar chunks get no color. `colorOffset` continues the
 * cycle from previous pairs in the same page so colors flow continuously
 * across a page.
 */
function buildChunkColors(alignment, colorOffset) {
  const colors = new Map();
  let counter = 0;
  for (let i = 0; i < alignment.length; i++) {
    if (alignment[i].category === "grammar") continue;
    colors.set(i, (colorOffset + counter) % CHUNK_COLORS);
    counter++;
  }
  return { colors, count: counter };
}

/**
 * Walk `text` for one pair, marking each character with the chunk index
 * that claims it (or null). Articles like "the" at the START of an English
 * span are left uncovered so they don't get colored.
 */
function buildCoverage(text, alignment, key, chunkColors) {
  const coverage = new Array(text.length).fill(null);
  let scanFrom = 0;

  for (let ci = 0; ci < alignment.length; ci++) {
    const chunk = alignment[ci];
    const span = (chunk[key] || "").trim();
    if (!span) continue;

    let idx = text.indexOf(span, scanFrom);
    if (idx === -1) idx = text.indexOf(span);
    if (idx === -1) continue;

    if (!chunkColors.has(ci)) {
      // Grammar chunk — advance cursor, don't color.
      scanFrom = idx + span.length;
      continue;
    }

    let startOffset = 0;
    if (key === "english") {
      const words = span.split(/\s+/);
      let consumed = 0;
      for (const w of words) {
        if (NEUTRAL_LEADING.has(w.toLowerCase())) {
          consumed += w.length + 1;
        } else break;
      }
      startOffset = Math.min(consumed, span.length);
    }

    const start = idx + startOffset;
    const end = idx + span.length;
    for (let p = start; p < end; p++) {
      if (coverage[p] === null) coverage[p] = ci;
    }
    scanFrom = idx + span.length;
  }

  return coverage;
}

/**
 * Build colored HTML for one pair's target or english line.
 */
function emitColored(text, coverage, alignment, chunkColors) {
  let html = "";
  let p = 0;
  while (p < text.length) {
    const claim = coverage[p];
    if (claim === null) {
      let end = p;
      while (end < text.length && coverage[end] === null) end++;
      html += escape(text.slice(p, end));
      p = end;
    } else {
      let end = p;
      while (end < text.length && coverage[end] === claim) end++;
      const color = chunkColors.get(claim);
      const chunk = alignment[claim];
      const attrs = [
        `data-color="${color}"`,
        chunk.category ? `data-cat="${escape(chunk.category)}"` : "",
        chunk.frequency_band ? `data-freq="${escape(chunk.frequency_band)}"` : "",
        chunk.is_idiom ? `data-idiom="true"` : "",
      ].filter(Boolean).join(" ");
      html += `<span class="chunk" ${attrs}>${escape(text.slice(p, end))}</span>`;
      p = end;
    }
  }
  return html;
}

/**
 * Render one page as TWO flowing paragraphs:
 *   - pinyin paragraph: all clauses of the page concatenated
 *   - english paragraph: all clauses concatenated underneath
 *
 * Color codes bind chunks across both languages. Clause boundaries are
 * still visible because pair.target / pair.english already include their
 * punctuation. This reads like a normal bilingual book paragraph rather
 * than a stack of choppy two-line rows.
 */
function renderPage(pairs) {
  let colorOffset = 0;
  const targetParts = [];
  const englishParts = [];

  for (const pair of pairs) {
    if (!Array.isArray(pair.alignment) || pair.alignment.length === 0) {
      targetParts.push(escape(pair.target));
      englishParts.push(escape(pair.english));
      continue;
    }
    const { colors, count } = buildChunkColors(pair.alignment, colorOffset);
    const tCov = buildCoverage(pair.target, pair.alignment, "target", colors);
    const eCov = buildCoverage(pair.english, pair.alignment, "english", colors);
    targetParts.push(emitColored(pair.target, tCov, pair.alignment, colors));
    englishParts.push(emitColored(pair.english, eCov, pair.alignment, colors));
    colorOffset += count;
  }

  // Join clauses with a single space; punctuation already inside the clauses
  // creates the natural breaks. Browser collapses whitespace appropriately.
  return `
    <section class="reader-page">
      <p class="target">${targetParts.join(" ")}</p>
      <p class="english">${englishParts.join(" ")}</p>
    </section>
  `;
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
  for (const pageChunk of chunks) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderPage(pageChunk);
    container.appendChild(wrapper.firstElementChild);
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
