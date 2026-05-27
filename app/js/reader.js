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

/* ───────────────────────── chunk positioning ───────────────────────── */

/**
 * For each chunk in pair.alignment, find its target span [start, end) and
 * its english span [start, end) inside pair.target / pair.english using a
 * left-to-right cursor (chunks are in target order).
 *
 * Failed lookups: targetStart === -1 means the chunk's target couldn't be
 * located after the cursor; english similarly. Such chunks contribute no
 * coloring but do not block rendering.
 */
function findChunkPositions(pair) {
  let scanT = 0, scanE = 0;
  return pair.alignment.map((chunk) => {
    let tStart = -1, tEnd = -1, eStart = -1, eEnd = -1;
    if (chunk.target) {
      const idx = pair.target.indexOf(chunk.target, scanT);
      if (idx !== -1) {
        tStart = idx;
        tEnd = idx + chunk.target.length;
        scanT = tEnd;
      }
    }
    if (chunk.english) {
      const idx = pair.english.indexOf(chunk.english, scanE);
      if (idx !== -1) {
        eStart = idx;
        eEnd = idx + chunk.english.length;
        scanE = eEnd;
      }
    }
    return { tStart, tEnd, eStart, eEnd };
  });
}

/* ───────────────────────── english coverage ───────────────────────── */

/**
 * Build a coverage array for pair.english: for each character, the chunk
 * index that "owns" it (for coloring), or null. Grammar chunks and leading
 * English articles ("the", "a", "an") are left uncovered.
 */
function buildEnglishCoverage(pair) {
  const text = pair.english;
  const coverage = new Array(text.length).fill(null);
  if (!Array.isArray(pair.alignment)) return coverage;

  let scanFrom = 0;
  for (let ci = 0; ci < pair.alignment.length; ci++) {
    const chunk = pair.alignment[ci];
    const span = (chunk.english || "").trim();
    if (!span) continue;
    let idx = text.indexOf(span, scanFrom);
    if (idx === -1) idx = text.indexOf(span);
    if (idx === -1) continue;

    if (chunk.category === "grammar") {
      scanFrom = idx + span.length;
      continue;
    }

    // Strip leading articles from the colored portion.
    let startOffset = 0;
    const words = span.split(/\s+/);
    let consumed = 0;
    for (const w of words) {
      if (NEUTRAL_LEADING.has(w.toLowerCase())) consumed += w.length + 1;
      else break;
    }
    startOffset = Math.min(consumed, span.length);

    for (let p = idx + startOffset; p < idx + span.length; p++) {
      if (coverage[p] === null) coverage[p] = ci;
    }
    scanFrom = idx + span.length;
  }
  return coverage;
}

/**
 * Emit a slice of an English text wrapped in <span class="chunk"> for any
 * colored positions, plain text for uncovered positions. Slice bounds:
 * [start, end).
 */
function emitEnglishSlice(pair, coverage, start, end) {
  let html = "";
  let p = start;
  const text = pair.english;
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
      const chunk = pair.alignment[claim];
      const attrs = [
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

/* ───────────────────────── pinyin span emission ───────────────────────── */

/**
 * Emit uncovered text (text between chunks, or trailing punctuation). Each
 * word becomes its own <span class="seg uncov"> (nowrap), and whitespace
 * between words becomes a plain text node — the ONLY allowable line-break
 * points. This guarantees no word ever splits across lines.
 */
function pushUncoveredText(parts, txt) {
  if (!txt) return;
  // Split into runs of whitespace and runs of non-whitespace.
  const tokens = txt.split(/(\s+)/);
  for (const tok of tokens) {
    if (!tok) continue;
    if (/^\s+$/.test(tok)) {
      parts.push(escape(tok));
    } else {
      parts.push(`<span class="seg uncov">${escape(tok)}</span>`);
    }
  }
}

/**
 * Build the full pinyin HTML for a page. Every word — whether part of an
 * alignment chunk or just inter-chunk punctuation/uncovered prose — is
 * wrapped in an atomic <span> with white-space:nowrap. Spaces between
 * spans are plain text nodes (the only break-points).
 *
 * This guarantees the browser only wraps BETWEEN words, never within one,
 * so each span's offsetTop reliably identifies its visual line.
 *
 * Returns { html, chunkMeta }.
 */
function buildPinyinHtml(pairs) {
  const chunkMeta = [];
  let parts = [];

  for (let pairIdx = 0; pairIdx < pairs.length; pairIdx++) {
    const pair = pairs[pairIdx];

    if (!Array.isArray(pair.alignment) || pair.alignment.length === 0) {
      pushUncoveredText(parts, pair.target);
      if (pairIdx < pairs.length - 1) parts.push(" ");
      continue;
    }

    const positions = findChunkPositions(pair);
    let cursor = 0;

    for (let chunkIdx = 0; chunkIdx < pair.alignment.length; chunkIdx++) {
      const pos = positions[chunkIdx];
      if (pos.tStart === -1) continue;

      if (pos.tStart > cursor) {
        pushUncoveredText(parts, pair.target.slice(cursor, pos.tStart));
      }

      const chunk = pair.alignment[chunkIdx];
      const uid = `p${pairIdx}c${chunkIdx}`;
      const attrs = [
        `class="seg chunk"`,
        `data-uid="${uid}"`,
        `data-pair="${pairIdx}"`,
        chunk.category ? `data-cat="${escape(chunk.category)}"` : "",
        chunk.frequency_band ? `data-freq="${escape(chunk.frequency_band)}"` : "",
        chunk.is_idiom ? `data-idiom="true"` : "",
      ].filter(Boolean).join(" ");
      parts.push(`<span ${attrs}>${escape(chunk.target)}</span>`);

      chunkMeta.push({
        uid, pairIdx, chunkIdx,
        eStart: pos.eStart, eEnd: pos.eEnd,
        isGrammar: chunk.category === "grammar",
      });

      cursor = pos.tEnd;
    }

    if (cursor < pair.target.length) {
      pushUncoveredText(parts, pair.target.slice(cursor));
    }

    if (pairIdx < pairs.length - 1) {
      parts.push(" ");
    }
  }

  return { html: parts.join(""), chunkMeta };
}

/* ───────────────────────── visual-line grouping ───────────────────────── */

/**
 * Group ALL .seg spans (both chunks and uncov tokens) by their visual line
 * in the rendered paragraph. Both kinds of spans are nowrap-atomic, so an
 * uncov "wài," that ends up on a different visual line than its preceding
 * chunks needs to be detected as such — otherwise the block range pulls
 * it onto the wrong line.
 *
 * Returns an array of line objects, each with the first/last seg and only
 * the CHUNKS on that line (for pair-line tracking on the English side).
 */
function groupSegsByLine(targetEl) {
  const segs = Array.from(targetEl.querySelectorAll(".seg"));
  if (segs.length === 0) return [];

  const linesByTop = [];
  for (const seg of segs) {
    const top = seg.offsetTop;
    let lineEntry = linesByTop.find((l) => Math.abs(l.top - top) < 4);
    if (!lineEntry) {
      lineEntry = { top, segs: [] };
      linesByTop.push(lineEntry);
    }
    lineEntry.segs.push(seg);
  }
  linesByTop.sort((a, b) => a.top - b.top);
  return linesByTop.map((l) => ({
    top: l.top,
    firstSeg: l.segs[0],
    lastSeg: l.segs[l.segs.length - 1],
    chunks: l.segs.filter((s) => s.classList.contains("chunk")),
  }));
}

/**
 * For each visual line, build a Range spanning that line's content (chunks
 * + the inter-chunk text/punctuation that ends up on the same line). Use
 * Range.cloneContents() to extract the HTML.
 *
 * First line starts at target start. Each subsequent line starts at its
 * first chunk and includes any uncovered text following until the next
 * line's first chunk. Last line ends at target end.
 */
function extractLineHtml(targetEl, lines, lineIdx) {
  const line = lines[lineIdx];
  const range = document.createRange();
  if (lineIdx === 0) {
    range.setStart(targetEl, 0);
  } else {
    range.setStartBefore(line.firstSeg);
  }
  if (lineIdx === lines.length - 1) {
    range.setEnd(targetEl, targetEl.childNodes.length);
  } else {
    range.setEndBefore(lines[lineIdx + 1].firstSeg);
  }
  const wrap = document.createElement("div");
  wrap.appendChild(range.cloneContents());
  return wrap.innerHTML;
}

/* ───────────────────────── page render (Option 2) ───────────────────────── */

/**
 * Render a page's pairs into pageEl as a stack of "blocks", each block
 * containing exactly one visual line of pinyin and the corresponding
 * English directly below it.
 *
 * Algorithm:
 *   1. Build the full pinyin HTML (all pairs concatenated, each chunk
 *      wrapped in a <span> tagged with data-uid + data-pair).
 *   2. Mount it on pageEl temporarily inside a <p class="target">. Browser
 *      lays it out.
 *   3. Walk spans by DOM order, grouping by their offsetTop. Same offsetTop
 *      = same visual line.
 *   4. For each visual line, build a block:
 *       - Pinyin = the spans on that line, in DOM order
 *       - English = for each pair touching this line, the slice of
 *         pair.english between the per-pair cursor and the max englishEnd
 *         of that pair's chunks on this line (extends to pair.english.length
 *         if this is the LAST line containing any chunks of that pair).
 *   5. Replace pageEl.innerHTML with the final blocks.
 *   6. Verification: after layout, warn if any final target wrapped.
 */
function renderPageInto(pageEl, pairs) {
  // Step 1: build pinyin html + chunk metadata.
  const { html: pinyinHtml, chunkMeta } = buildPinyinHtml(pairs);

  // Step 2: mount measurement-only structure on the page.
  pageEl.innerHTML = `<p class="target measure-target">${pinyinHtml}</p>`;
  const measureTarget = pageEl.querySelector(".measure-target");

  // Force layout to be current before measuring.
  void measureTarget.offsetHeight;

  // Step 3: group ALL .seg spans (chunks + uncov) by visual line.
  const lines = groupSegsByLine(measureTarget);

  // chunk uid -> visual line index
  const chunkLine = new Map();
  // pair index -> Set of visual line indices it touches
  const pairLines = new Map();

  lines.forEach((line, lineIdx) => {
    for (const span of line.chunks) {
      const pairIdx = parseInt(span.dataset.pair, 10);
      if (Number.isFinite(pairIdx)) {
        if (!pairLines.has(pairIdx)) pairLines.set(pairIdx, new Set());
        pairLines.get(pairIdx).add(lineIdx);
      }
      if (span.dataset.uid) {
        chunkLine.set(span.dataset.uid, lineIdx);
      }
    }
  });

  // Step 4: build blocks.
  const englishCoverages = pairs.map((p) =>
    Array.isArray(p.alignment) && p.alignment.length > 0 ? buildEnglishCoverage(p) : null
  );
  const englishCursor = new Map(); // pairIdx -> position in pair.english already emitted
  const blocks = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    // Pinyin = the Range between this line's first chunk and the next line's
    // first chunk (or end of target for the last line). Captures all
    // inter-chunk text and spaces verbatim.
    const pinyinLineHtml = extractLineHtml(measureTarget, lines, lineIdx);

    // English = for each pair touching this line, in pair order.
    const pairsOnLine = [];
    for (const [pairIdx, lineSet] of pairLines.entries()) {
      if (lineSet.has(lineIdx)) pairsOnLine.push(pairIdx);
    }
    pairsOnLine.sort((a, b) => a - b);

    const englishParts = [];
    for (const pairIdx of pairsOnLine) {
      const pair = pairs[pairIdx];

      if (!Array.isArray(pair.alignment) || pair.alignment.length === 0) {
        // No chunks — emit the whole English on the first line we see this pair,
        // and nothing on subsequent lines.
        const cursor = englishCursor.get(pairIdx) || 0;
        if (cursor === 0 && pair.english.length > 0) {
          englishParts.push(escape(pair.english));
          englishCursor.set(pairIdx, pair.english.length);
        }
        continue;
      }

      // Find chunks of this pair on this line (with locatable english).
      const chunksHere = chunkMeta.filter(
        (m) => m.pairIdx === pairIdx && chunkLine.get(m.uid) === lineIdx && m.eEnd > 0
      );
      // Find chunks of this pair on subsequent lines.
      const chunksLater = chunkMeta.filter(
        (m) => m.pairIdx === pairIdx && (chunkLine.get(m.uid) ?? -1) > lineIdx && m.eEnd > 0
      );

      // If no content-bearing chunks of this pair are on this line, we may
      // still need to emit residual english IF this is the last line touched.
      const cursor = englishCursor.get(pairIdx) || 0;
      let cut;
      if (chunksHere.length === 0) {
        // Last line for this pair? Emit remaining english.
        if (chunksLater.length === 0 && cursor < pair.english.length) {
          cut = pair.english.length;
        } else {
          continue; // No new English to emit on this line.
        }
      } else {
        const maxEnd = Math.max(...chunksHere.map((m) => m.eEnd));
        // If no later chunks of this pair, extend cut to end of pair.english
        // so trailing punctuation/articles aren't dropped.
        cut = chunksLater.length === 0 ? pair.english.length : Math.max(maxEnd, cursor);
        // Also ensure we don't emit less than maxEnd (in case earlier line
        // already emitted past it due to reordering).
        cut = Math.max(cut, maxEnd);
      }

      if (cut > cursor) {
        englishParts.push(
          emitEnglishSlice(pair, englishCoverages[pairIdx], cursor, cut)
        );
        englishCursor.set(pairIdx, cut);
      }
    }

    blocks.push({
      pinyinHtml: pinyinLineHtml,
      englishHtml: englishParts.join(" "),
    });
  }

  // Step 5: replace pageEl with final block HTML.
  pageEl.innerHTML = blocks
    .map(
      (b) => `
        <div class="reader-block">
          <p class="target">${b.pinyinHtml}</p>
          <p class="english">${b.englishHtml}</p>
        </div>
      `
    )
    .join("");

  // Step 6: verification — log loudly if any block ended up wrapped.
  // This means our measurement disagreed with the final layout (rare; e.g.
  // if a font hasn't loaded yet between measure and render).
  requestAnimationFrame(() => {
    const blockTargets = pageEl.querySelectorAll(".reader-block > .target");
    const lineHeight = parseFloat(getComputedStyle(blockTargets[0] || pageEl).lineHeight) || 24;
    blockTargets.forEach((t, i) => {
      if (t.offsetHeight > lineHeight * 1.5) {
        console.warn(
          `[reader] Block ${i} pinyin wrapped after layout: height=${t.offsetHeight}px, expected ≤${(lineHeight * 1.5).toFixed(0)}px. Text:`,
          t.textContent.slice(0, 80)
        );
      }
    });
  });
}

/* ───────────────────────── chapter / navigation ───────────────────────── */

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

  // Content pages — append first so renderPageInto can measure real width.
  const chunks = chunkPairs(chapter.pairs, perPage);
  for (const pageChunk of chunks) {
    const page = document.createElement("section");
    page.className = "reader-page";
    container.appendChild(page);
    renderPageInto(page, pageChunk);
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
