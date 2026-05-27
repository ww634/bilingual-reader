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

// Pinyin character budget per visual line. Used to decide block breaks.
// Conservative — accepting some under-packing in exchange for fewer
// visual wraps of pinyin into a second line.
const PINYIN_LINE_BUDGET = 36;

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
    if (!chunkColors.has(ci)) { scanFrom = idx + span.length; continue; }
    let startOffset = 0;
    if (key === "english") {
      const words = span.split(/\s+/);
      let consumed = 0;
      for (const w of words) {
        if (NEUTRAL_LEADING.has(w.toLowerCase())) consumed += w.length + 1;
        else break;
      }
      startOffset = Math.min(consumed, span.length);
    }
    for (let p = idx + startOffset; p < idx + span.length; p++) {
      if (coverage[p] === null) coverage[p] = ci;
    }
    scanFrom = idx + span.length;
  }
  return coverage;
}

function emitColoredSlice(text, coverage, alignment, chunkColors, start, end) {
  let html = "";
  let p = start;
  while (p < end) {
    const claim = coverage[p];
    if (claim === null) {
      let stop = p;
      while (stop < end && coverage[stop] === null) stop++;
      html += escape(text.slice(p, stop));
      p = stop;
    } else {
      let stop = p;
      while (stop < end && coverage[stop] === claim) stop++;
      const color = chunkColors.get(claim);
      const chunk = alignment[claim];
      const attrs = [
        `data-color="${color}"`,
        chunk.category ? `data-cat="${escape(chunk.category)}"` : "",
        chunk.frequency_band ? `data-freq="${escape(chunk.frequency_band)}"` : "",
        chunk.is_idiom ? `data-idiom="true"` : "",
      ].filter(Boolean).join(" ");
      html += `<span class="chunk" ${attrs}>${escape(text.slice(p, stop))}</span>`;
      p = stop;
    }
  }
  return html;
}

/**
 * Render one page as a stack of "blocks". Each block holds one or more
 * COMPLETE pairs — pairs are atomic and are never split across blocks.
 *
 * Adjacent short pairs pack into the same block until adding the next
 * pair would push the cumulative pinyin over PINYIN_LINE_BUDGET. A long
 * pair that exceeds the budget on its own gets its own block (and may
 * wrap visually to two lines, which is acceptable for a single long
 * clause). This eliminates orphan pinyin-only blocks caused by mid-pair
 * splitting, at the cost of letting genuinely long single clauses wrap.
 */
function renderPage(pairs) {
  const blocks = [];
  let current = { pinyinSegments: [], englishSegments: [], charCount: 0 };
  let colorOffset = 0;

  function flush() {
    if (current.charCount > 0 || current.englishSegments.length > 0) {
      blocks.push({
        pinyinHtml: current.pinyinSegments.join("").replace(/^\s+|\s+$/g, ""),
        englishHtml: current.englishSegments.join(" ").replace(/^\s+|\s+$/g, ""),
      });
    }
    current = { pinyinSegments: [], englishSegments: [], charCount: 0 };
  }

  for (const pair of pairs) {
    let targetHtml, englishHtml;

    if (!Array.isArray(pair.alignment) || pair.alignment.length === 0) {
      targetHtml = escape(pair.target);
      englishHtml = escape(pair.english);
    } else {
      const { colors, count } = buildChunkColors(pair.alignment, colorOffset);
      colorOffset += count;
      const tCov = buildCoverage(pair.target, pair.alignment, "target", colors);
      const eCov = buildCoverage(pair.english, pair.alignment, "english", colors);
      targetHtml = emitColoredSlice(pair.target, tCov, pair.alignment, colors, 0, pair.target.length);
      englishHtml = emitColoredSlice(pair.english, eCov, pair.alignment, colors, 0, pair.english.length);
    }

    const pairLen = pair.target.length;
    // If adding this whole pair would overflow the current block, flush
    // first so the pair starts fresh in a new block. The pair itself is
    // never split.
    if (current.charCount > 0 && current.charCount + pairLen + 1 > PINYIN_LINE_BUDGET) {
      flush();
    }

    const leadSpace = current.pinyinSegments.length ? " " : "";
    current.pinyinSegments.push(leadSpace + targetHtml);
    current.englishSegments.push(englishHtml);
    current.charCount += pairLen + leadSpace.length;
  }

  flush();

  return blocks.map((b) => `
    <div class="reader-block">
      <p class="target">${b.pinyinHtml}</p>
      <p class="english">${b.englishHtml}</p>
    </div>
  `).join("");
}

function renderChapter(chapter, perPage) {
  const container = pagesEl();
  container.innerHTML = "";

  const titlePage = document.createElement("section");
  titlePage.className = "reader-page title-page";
  titlePage.innerHTML = `
    <div class="target">${escape(chapter.title.target)}</div>
    <div class="english">${escape(chapter.title.english)}</div>
  `;
  container.appendChild(titlePage);

  const chunks = chunkPairs(chapter.pairs, perPage);
  for (const pageChunk of chunks) {
    const page = document.createElement("section");
    page.className = "reader-page";
    page.innerHTML = renderPage(pageChunk);
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
