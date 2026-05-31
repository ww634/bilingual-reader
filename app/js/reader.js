import { getChapter, getProgress, putProgress, getSettings, getBook } from "./db.js";
import { openPopover } from "./popover.js";

const pagesEl = () => document.getElementById("reader-pages");
const indicatorEl = () => document.getElementById("page-indicator");

let _state = {
  bookId: null,
  chapterId: null,
  chapter: null,
  // Ordered chapter list for the current book, used by the end-of-chapter
  // "Next chapter" affordance.
  bookChapters: [],
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

/* ───────────────────────── chunk positioning ───────────────────────── */

/**
 * For each chunk in pair.alignment, find its target span [start, end) and
 * its english span [start, end) inside pair.target / pair.english.
 *
 * Locates each chunk INDEPENDENTLY (not with a left-to-right scanner) so
 * the function works whether the LLM gave chunks in target order or in
 * english reading order. The buildPinyinHtml caller is responsible for
 * sorting by target position before emission.
 *
 * Duplicate-target handling: when a chunk's target string appears multiple
 * times in pair.target, we greedily assign each chunk to the earliest
 * unclaimed occurrence (processing chunks in alignment array order).
 */
function findChunkPositions(pair) {
  // Track which character positions are already claimed for target and english.
  const claimedTarget = new Set();
  const claimedEnglish = new Set();

  const findFirstUnclaimed = (text, needle, claimed, requireWordBoundary = false, caseInsensitive = false) => {
    if (!needle) return -1;
    const isWordChar = (c) => /[a-zA-Z0-9]/.test(c);
    // Case-insensitive English matching: needle is usually Title/lowercase
    // but headers in the .docx may be ALL CAPS. Comparing lowercased copies
    // lets us find the right span without changing the underlying text.
    const haystack = caseInsensitive ? text.toLowerCase() : text;
    const probe = caseInsensitive ? needle.toLowerCase() : needle;
    let from = 0;
    while (from <= haystack.length - probe.length) {
      const idx = haystack.indexOf(probe, from);
      if (idx === -1) return -1;
      // Check if any position in [idx, idx+len) is already claimed.
      let collision = false;
      for (let p = idx; p < idx + needle.length; p++) {
        if (claimed.has(p)) { collision = true; break; }
      }
      if (collision) { from = idx + 1; continue; }
      // For English: require the match to be on word boundaries so a short
      // function word like "a" doesn't match INSIDE "seaman" (sub-word).
      if (requireWordBoundary) {
        const charBefore = idx > 0 ? text[idx - 1] : "";
        const charAfter = idx + needle.length < text.length ? text[idx + needle.length] : "";
        const needleFirst = needle[0];
        const needleLast = needle[needle.length - 1];
        const leftBoundary = !charBefore || !isWordChar(charBefore) || !isWordChar(needleFirst);
        const rightBoundary = !charAfter || !isWordChar(charAfter) || !isWordChar(needleLast);
        if (!leftBoundary || !rightBoundary) { from = idx + 1; continue; }
      }
      return idx;
    }
    return -1;
  };

  return pair.alignment.map((chunk) => {
    let tStart = -1, tEnd = -1, eStart = -1, eEnd = -1;
    if (chunk.target) {
      const idx = findFirstUnclaimed(pair.target, chunk.target, claimedTarget);
      if (idx !== -1) {
        tStart = idx;
        tEnd = idx + chunk.target.length;
        for (let p = tStart; p < tEnd; p++) claimedTarget.add(p);
      }
    }
    if (chunk.english) {
      // English requires word boundaries so a short word like "a" doesn't
      // match inside a longer word like "se_a_man". Case-insensitive so
      // all-caps headers in the source .docx still align.
      const idx = findFirstUnclaimed(pair.english, chunk.english, claimedEnglish, true, true);
      if (idx !== -1) {
        eStart = idx;
        eEnd = idx + chunk.english.length;
        for (let p = eStart; p < eEnd; p++) claimedEnglish.add(p);
      }
    }
    return { tStart, tEnd, eStart, eEnd };
  });
}

/* ───────────────────────── english coverage ───────────────────────── */

// Function words carry no positional signal — they appear everywhere — so we
// don't let a lone stopword match anchor a fuzzy alignment. Content words do.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "and", "or", "but", "in", "on", "at", "by",
  "is", "was", "were", "are", "be", "been", "it", "i", "he", "she", "we",
  "they", "you", "his", "her", "my", "our", "their", "that", "this", "as",
  "for", "with", "from", "had", "has", "have", "did", "do", "not", "so",
]);

/**
 * Tokenise text into word tokens, keeping each token's [start,end) char span
 * in the ORIGINAL string so we can map matches back to highlight positions.
 */
function wordTokens(text) {
  const toks = [];
  const re = /[A-Za-z0-9'’]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    toks.push({ lower: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return toks;
}

/**
 * Light English stemmer — strips the common inflections so "keeping" and
 * "keep" compare equal. Not linguistically perfect; just enough to absorb
 * -ing/-ed/-s/-ly/-'s etc. for highlight matching.
 */
function stem(w) {
  w = w.toLowerCase().replace(/['’]s$/, "");
  return (
    w
      .replace(/(ically|ing|edly|edge|ed|ly|ies|es|s|er|est|en)$/, "")
      || w
  );
}

/** Token equality with stemming + a 4-char prefix fallback for inflection. */
function tokenMatch(a, b) {
  if (a === b) return true;
  const sa = stem(a), sb = stem(b);
  if (sa === sb) return true;
  const n = Math.min(4, sa.length, sb.length);
  return n >= 3 && sa.slice(0, n) === sb.slice(0, n);
}

/**
 * Build a coverage array for pair.english: for each character, the chunk
 * index that "owns" it (for coloring + per-category visibility toggling),
 * or null.
 *
 * Two-stage matching per chunk:
 *   1. EXACT — chunk.english is a contiguous substring of the sentence
 *      (case-insensitive). Precise; preferred. Handles ALL-CAPS headers.
 *   2. FUZZY FALLBACK — when exact fails (the aligner gave a base-form gloss
 *      like "keep back" for "keeping…back", or a discontinuous span), match
 *      the chunk's word tokens to sentence tokens with stemming, allowing
 *      DISCONTINUOUS highlights, advancing monotonically so chunks don't grab
 *      words out of order. Requires a content-word anchor so a lone stopword
 *      gloss (把→"of") doesn't paint a random "of".
 *
 * Stage 2 is what recovers the lemmatisation / discontinuous cases that used
 * to fall through as uncoloured. Stage 1 still wins when it can, so precise
 * matches stay precise. Grammatical chunks whose gloss legitimately isn't in
 * the sentence simply find no anchor and stay uncoloured — which is correct
 * (Chinese omits those words; there's nothing to highlight).
 */
function buildEnglishCoverage(pair) {
  const text = pair.english;
  const coverage = new Array(text.length).fill(null);
  if (!Array.isArray(pair.alignment)) return coverage;

  const textLower = text.toLowerCase();
  const pairToks = wordTokens(text);
  const tokenClaimed = new Array(pairToks.length).fill(false);
  let scanFrom = 0;   // char cursor for exact matches
  let tokCursor = 0;  // token cursor for fuzzy matches (keeps order monotonic)

  // Mark every pair token whose span lies within [start,end) as claimed, and
  // push the fuzzy token cursor past them.
  const claimTokensInRange = (start, end) => {
    for (let ti = 0; ti < pairToks.length; ti++) {
      if (pairToks[ti].start >= start && pairToks[ti].end <= end) {
        tokenClaimed[ti] = true;
        if (ti + 1 > tokCursor) tokCursor = ti + 1;
      }
    }
  };

  for (let ci = 0; ci < pair.alignment.length; ci++) {
    const chunk = pair.alignment[ci];
    const span = (chunk.english || "").trim();
    if (!span) continue;

    // ── Stage 1: exact substring ──
    const needle = span.toLowerCase();
    let idx = textLower.indexOf(needle, scanFrom);
    if (idx === -1) idx = textLower.indexOf(needle);
    if (idx !== -1) {
      for (let p = idx; p < idx + span.length; p++) {
        if (coverage[p] === null) coverage[p] = ci;
      }
      scanFrom = idx + span.length;
      claimTokensInRange(idx, idx + span.length);
      continue;
    }

    // ── Stage 2: fuzzy token match (lemmatisation / discontinuous) ──
    const chunkToks = wordTokens(span).map((t) => t.lower);
    if (chunkToks.length === 0) continue;
    const matched = [];
    let searchFrom = tokCursor;
    let anchored = false; // at least one matched token is a content word
    for (const ct of chunkToks) {
      let found = -1;
      for (let ti = searchFrom; ti < pairToks.length; ti++) {
        if (tokenClaimed[ti]) continue;
        if (tokenMatch(ct, pairToks[ti].lower)) { found = ti; break; }
      }
      if (found !== -1) {
        matched.push(found);
        searchFrom = found + 1;
        if (!STOPWORDS.has(pairToks[found].lower) && pairToks[found].lower.length >= 3) {
          anchored = true;
        }
      }
    }
    // Only commit the fuzzy match if a real (content) word anchored it.
    if (!anchored) continue;
    for (const ti of matched) {
      tokenClaimed[ti] = true;
      for (let p = pairToks[ti].start; p < pairToks[ti].end; p++) {
        if (coverage[p] === null) coverage[p] = ci;
      }
      if (ti + 1 > tokCursor) tokCursor = ti + 1;
    }
  }
  return coverage;
}

/**
 * Wrap an uncovered English run so its WORDS go through .other (hideable via
 * the "Other" toggle) while its punctuation / whitespace stay plain text
 * (always visible — punctuation helps you parse the sentence even when all
 * word translations are hidden).
 *
 * A "word" here is a run of letters / apostrophes / internal hyphens.
 */
function emitOtherRun(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (/[A-Za-z]/.test(text[i])) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9'’\-]/.test(text[j])) j++;
      out += `<span class="other">${escape(text.slice(i, j))}</span>`;
      i = j;
    } else {
      let j = i + 1;
      while (j < text.length && !/[A-Za-z]/.test(text[j])) j++;
      out += escape(text.slice(i, j));
      i = j;
    }
  }
  return out;
}

/**
 * Emit a slice of an English text wrapped in <span class="chunk"> for any
 * colored positions, and <span class="other"> for uncovered word runs
 * (so the "Other" toggle can hide them). Slice bounds: [start, end).
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
      html += emitOtherRun(text.slice(p, stop));
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
 * WORD becomes its own <span class="seg uncov" data-pair> (nowrap) — these
 * are tappable in the reader so users can look up function words / "added"
 * words that the alignment didn't cover. Whitespace and pure punctuation
 * stay as plain text nodes (the only line-break points, and not tappable).
 */
function pushUncoveredText(parts, txt, pairIdx) {
  if (!txt) return;
  // Split into runs of whitespace and runs of non-whitespace.
  const tokens = txt.split(/(\s+)/);
  for (const tok of tokens) {
    if (!tok) continue;
    if (/^\s+$/.test(tok)) {
      parts.push(escape(tok));
    } else if (!/[a-zA-ZāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙǕǗǙǛ]/.test(tok)) {
      // Pure punctuation/symbols — emit as plain text, not a tap target.
      parts.push(escape(tok));
    } else {
      const pairAttr = Number.isFinite(pairIdx) ? ` data-pair="${pairIdx}"` : "";
      parts.push(`<span class="seg uncov"${pairAttr}>${escape(tok)}</span>`);
    }
  }
}

/**
 * Build the full pinyin HTML for a page. Every word — whether part of an
 * alignment chunk or just inter-chunk punctuation/uncovered prose — is
 * wrapped in an atomic <span> with white-space:nowrap. Spaces between
 * spans are plain text nodes (the only break-points).
 *
 * @param {Array} pairs The pairs for THIS page (a slice of the chapter).
 * @param {number} pageStartIdx The GLOBAL index of pairs[0] in the chapter,
 *   so data-uid encodes chapter-global pair indices (not slice-local). The
 *   tap handler looks up _state.chapter.pairs[pairIdx], which expects the
 *   global index.
 *
 * Returns { html, chunkMeta }. chunkMeta's pairIdx is also chapter-global.
 */
function buildPinyinHtml(pairs, pageStartIdx = 0) {
  const chunkMeta = [];
  let parts = [];

  for (let localIdx = 0; localIdx < pairs.length; localIdx++) {
    const pairIdx = pageStartIdx + localIdx; // chapter-global pair index
    const pair = pairs[localIdx];

    if (!Array.isArray(pair.alignment) || pair.alignment.length === 0) {
      pushUncoveredText(parts, pair.target, pairIdx);
      if (localIdx < pairs.length - 1) parts.push(" ");
      continue;
    }

    const positions = findChunkPositions(pair);

    // Build a list of [original chunkIdx, position] and sort by target start.
    // The LLM is supposed to give chunks in target order but sometimes gives
    // english order instead; we sort defensively so emission works regardless.
    const ordered = positions
      .map((pos, idx) => ({ idx, pos }))
      .filter((x) => x.pos.tStart !== -1)
      .sort((a, b) => a.pos.tStart - b.pos.tStart);

    let cursor = 0;
    for (const { idx: chunkIdx, pos } of ordered) {
      if (pos.tStart < cursor) continue; // overlap — skip (shouldn't happen with claim-based finder)

      if (pos.tStart > cursor) {
        pushUncoveredText(parts, pair.target.slice(cursor, pos.tStart), pairIdx);
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
      pushUncoveredText(parts, pair.target.slice(cursor), pairIdx);
    }

    if (localIdx < pairs.length - 1) {
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
function renderPageInto(pageEl, pairs, pageStartIdx) {
  // Step 1: build pinyin html + chunk metadata (uids use chapter-global pair index).
  const { html: pinyinHtml, chunkMeta } = buildPinyinHtml(pairs, pageStartIdx);

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

  // Step 4: build blocks. Index helpers by chapter-global pair index so
  // they line up with the data-pair / data-uid attributes set in step 1.
  const englishCoverages = new Map(); // global pairIdx -> coverage
  const pairByGlobal = new Map();     // global pairIdx -> pair object
  pairs.forEach((p, localIdx) => {
    const g = pageStartIdx + localIdx;
    pairByGlobal.set(g, p);
    if (Array.isArray(p.alignment) && p.alignment.length > 0) {
      englishCoverages.set(g, buildEnglishCoverage(p));
    }
  });
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
      const pair = pairByGlobal.get(pairIdx);
      if (!pair) continue;

      if (!Array.isArray(pair.alignment) || pair.alignment.length === 0) {
        // No chunks — emit the whole English on the first line we see this pair,
        // and nothing on subsequent lines. Wrap word runs in .other so the
        // "Other" toggle still applies even to fully un-aligned pairs.
        const cursor = englishCursor.get(pairIdx) || 0;
        if (cursor === 0 && pair.english.length > 0) {
          englishParts.push(emitOtherRun(pair.english));
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
          emitEnglishSlice(pair, englishCoverages.get(pairIdx), cursor, cut)
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
  let globalStart = 0;
  for (const pageChunk of chunks) {
    const page = document.createElement("section");
    page.className = "reader-page";
    container.appendChild(page);
    renderPageInto(page, pageChunk, globalStart);
    globalStart += pageChunk.length;
  }

  // End-of-chapter page. Shows the next chapter's title with a "Read" button,
  // or an "End of book" message if this is the last chapter.
  const endPage = document.createElement("section");
  endPage.className = "reader-page end-page";
  const currentIdx = _state.bookChapters.findIndex((c) => c.id === _state.chapterId);
  const nextChapter = currentIdx >= 0 && currentIdx < _state.bookChapters.length - 1
    ? _state.bookChapters[currentIdx + 1]
    : null;

  if (nextChapter) {
    endPage.innerHTML = `
      <div class="end-card">
        <div class="end-label">You've finished this chapter</div>
        <div class="end-divider"></div>
        <div class="end-next-label">Next up</div>
        <div class="end-target">${escape(nextChapter.title?.target || "")}</div>
        <h3 class="end-title">${escape(nextChapter.title?.english || nextChapter.id)}</h3>
        <button class="end-next-btn" data-next-id="${escape(nextChapter.id)}">Read →</button>
      </div>
    `;
  } else {
    endPage.innerHTML = `
      <div class="end-card">
        <div class="end-label">End of book</div>
        <p class="end-msg">You've finished the last chapter.</p>
      </div>
    `;
  }
  container.appendChild(endPage);

  _state.pagesCount = 1 + chunks.length + 1;
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

/**
 * Click handler for the "Read →" button on the end-of-chapter page.
 * Loads the next chapter and resets the reader to its first page.
 */
function handleNextChapterTap(event) {
  const btn = event.target.closest(".end-next-btn");
  if (!btn) return;
  const nextId = btn.dataset.nextId;
  if (!nextId || !_state.bookId) return;
  // Open the next chapter — openReader will replace this reader's content.
  openReader(_state.bookId, nextId);
}

/**
 * Click handler: when the user taps any word in the reader (colored chunk
 * OR uncovered word), open the tap-to-learn popover. Pure punctuation and
 * whitespace aren't tappable (they're plain text nodes, not spans).
 *
 * For chunks: full data from the alignment (english, category, freq).
 * For uncov words: just the word itself + pair context — popover gracefully
 *   hides missing fields. "See explanation" still works (asks AI for help).
 */
function handleChunkTap(event) {
  const segEl = event.target.closest(".seg");
  if (!segEl) return;
  // Only spans inside .reader-block targets — ignore the title page.
  if (!segEl.closest(".reader-block")) return;

  const isChunk = segEl.classList.contains("chunk");
  if (isChunk) {
    const uid = segEl.dataset.uid; // "p<pairIdx>c<chunkIdx>"
    const m = uid && uid.match(/^p(\d+)c(\d+)$/);
    if (!m) return;
    const pairIdx = parseInt(m[1], 10);
    const chunkIdx = parseInt(m[2], 10);

    const pair = _state.chapter?.pairs?.[pairIdx];
    const align = pair?.alignment?.[chunkIdx];
    if (!align) return;

    openPopover(
      {
        target: align.target,
        english: align.english,
        category: align.category,
        frequency_band: align.frequency_band,
        is_idiom: align.is_idiom,
        pairIdx,
        chunkIdx,
      },
      _state.chapter
    );
    return;
  }

  // Uncov span — tap on an uncovered word (function word, particle, etc).
  const pairIdx = parseInt(segEl.dataset.pair, 10);
  if (!Number.isFinite(pairIdx)) return;
  openPopover(
    {
      target: segEl.textContent.trim(),
      english: "",
      category: null,
      frequency_band: null,
      is_idiom: false,
      pairIdx,
      chunkIdx: null,
    },
    _state.chapter
  );
}

export async function openReader(bookId, chapterId) {
  const chapter = await getChapter(bookId, chapterId);
  if (!chapter) {
    console.error("Chapter not downloaded:", bookId, chapterId);
    return false;
  }
  const settings = await getSettings();
  const progress = await getProgress(bookId, chapterId);
  const book = await getBook(bookId);

  _state.bookId = bookId;
  _state.chapterId = chapterId;
  _state.chapter = chapter;
  _state.bookChapters = book?.chapters || [];
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
  container.removeEventListener("click", handleChunkTap);
  container.addEventListener("click", handleChunkTap);
  container.removeEventListener("click", handleNextChapterTap);
  container.addEventListener("click", handleNextChapterTap);

  return true;
}

export function closeReader() {
  const container = pagesEl();
  container.removeEventListener("scroll", handleScroll);
  container.removeEventListener("click", handleChunkTap);
  container.removeEventListener("click", handleNextChapterTap);
  clearTimeout(_state.saveTimer);
  if (_state.bookId && _state.chapterId) {
    putProgress(_state.bookId, _state.chapterId, _state.currentPage);
  }
  _state.bookId = null;
  _state.chapterId = null;
  _state.chapter = null;
  _state.bookChapters = [];
  _state.pagesCount = 0;
  _state.currentPage = 0;
  pagesEl().innerHTML = "";
}
