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

// 7 distinct pastel hues. Cycled by content-chunk index per pair (grammar
// chunks don't count toward the cycle so colors are reserved for content).
const CHUNK_COLORS = 7;

// English words that should NEVER be colored, even when they appear inside
// a content-word chunk's span. Articles, generic prepositions, conjunctions.
// (The chunk still tap-binds to the surrounding content words.)
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
 * Build a coverage map: for each character position in `text`, record the
 * chunk *content* index (skipping grammar chunks) that claims it, or null.
 *
 * Articles like "the" / "a" / "an" at the START of an english span are left
 * uncovered (no color), so "the Admiral Benbow" colors only "Admiral Benbow".
 *
 * @param {string} text The source text (pair.target or pair.english).
 * @param {Array} alignment The alignment chunks.
 * @param {'target'|'english'} key Which language field to find in `text`.
 * @returns {{coverage: Array<number|null>, colorMap: Map<number, number>, dataMap: Map<number, object>}}
 */
function buildCoverage(text, alignment, key) {
  const coverage = new Array(text.length).fill(null);
  const colorMap = new Map(); // chunk index -> color index (0..6)
  const dataMap = new Map();  // chunk index -> chunk object (for tap data)
  let colorCounter = 0;
  let scanFrom = 0;

  for (let ci = 0; ci < alignment.length; ci++) {
    const chunk = alignment[ci];
    const span = (chunk[key] || "").trim();
    if (!span) continue;

    // Find this span left-to-right starting after the previous match.
    let idx = text.indexOf(span, scanFrom);
    if (idx === -1) idx = text.indexOf(span); // fallback: search whole text
    if (idx === -1) continue;

    // Grammar chunks don't get colored but still advance the scan cursor.
    if (chunk.category === "grammar") {
      scanFrom = idx + span.length;
      continue;
    }

    // Assign a fresh color to this content chunk (cycling through palette).
    const colorIdx = colorCounter % CHUNK_COLORS;
    colorMap.set(ci, colorIdx);
    dataMap.set(ci, chunk);

    // For english, strip leading articles ("the Admiral Benbow" → color only
    // "Admiral Benbow"; "the" stays default-colored).
    let startOffset = 0;
    if (key === "english") {
      const words = span.split(/\s+/);
      let consumed = 0;
      for (const w of words) {
        if (NEUTRAL_LEADING.has(w.toLowerCase())) {
          consumed += w.length + 1; // +1 for the space
        } else {
          break;
        }
      }
      startOffset = Math.min(consumed, span.length);
    }

    const start = idx + startOffset;
    const end = idx + span.length;
    for (let p = start; p < end; p++) {
      if (coverage[p] === null) coverage[p] = ci;
    }
    scanFrom = idx + span.length;
    colorCounter++;
  }

  return { coverage, colorMap, dataMap };
}

/**
 * Walk `text` with the coverage map and emit HTML, wrapping covered runs in
 * <span class="chunk" data-color data-cat data-freq ...> elements.
 */
function emitColored(text, { coverage, colorMap, dataMap }) {
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
      const color = colorMap.get(claim) ?? 0;
      const chunk = dataMap.get(claim) || {};
      const attrs = [
        `data-color="${color}"`,
        chunk.category ? `data-cat="${escape(chunk.category)}"` : "",
        chunk.frequency_band ? `data-freq="${escape(chunk.frequency_band)}"` : "",
        chunk.is_idiom ? `data-idiom="true"` : "",
        `data-chunk-index="${claim}"`,
      ].filter(Boolean).join(" ");
      html += `<span class="chunk" ${attrs}>${escape(text.slice(p, end))}</span>`;
      p = end;
    }
  }
  return html;
}

/**
 * Render one pair as two flowing text lines (pinyin row, english row) with
 * content-word chunks wrapped in colored spans. Punctuation flows naturally
 * because we use pair.target / pair.english as the source of truth.
 */
function renderPair(pair) {
  const hasAlignment = Array.isArray(pair.alignment) && pair.alignment.length > 0;

  if (!hasAlignment) {
    return `
      <div class="pair">
        <p class="target">${escape(pair.target)}</p>
        <p class="english">${escape(pair.english)}</p>
      </div>
    `;
  }

  const targetCov = buildCoverage(pair.target, pair.alignment, "target");
  const englishCov = buildCoverage(pair.english, pair.alignment, "english");

  return `
    <div class="pair">
      <p class="target">${emitColored(pair.target, targetCov)}</p>
      <p class="english">${emitColored(pair.english, englishCov)}</p>
    </div>
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
