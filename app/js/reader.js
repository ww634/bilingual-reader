import { getChapter, getProgress, putProgress, getSettings, getBook, bumpActivity, updateSettings } from "./db.js";
import { openPopover } from "./popover.js";
import { ensureMastered, getMasteredHanziSync, chapterWatchWords, startQuizWithItems, startCardQuiz, vaultBucketMap } from "./vault.js";
import { learnerLevel, LEVELS, levelName, loadLevels, chapterKnowledge, clampLevel } from "./levels.js";
import { buildChapterQuiz, nextChapterQuiz, bookQuizPrefs } from "./chapterquiz.js";
import { isTargetOnly } from "./reader-options.js";

const pagesEl = () => document.getElementById("reader-pages");
const indicatorEl = () => document.getElementById("page-indicator");

/**
 * Mark English chunk spans whose word the learner has mastered, so CSS can fade
 * them (when body.hide-mastered is on). Called after each render.
 */
export function applyMasteredHiding() {
  const set = getMasteredHanziSync();
  // English spans (their translation fades) and target-word spans (their pinyin
  // fades in the characters-with-pinyin mode).
  const spans = document.querySelectorAll("#reader-pages .english .chunk[data-hanzi], #reader-pages .target .chunk[data-hanzi]");
  spans.forEach((el) => {
    el.classList.toggle("mastered", set.has(_state.chapter?.language === "fr" ? el.getAttribute("data-hanzi").toLocaleLowerCase("fr") : el.getAttribute("data-hanzi")));
  });
}

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
  script: "pinyin",
  targetOnly: false,   // English hidden: text flows like a normal book
  pairPage: new Map(), // sentence (pair) index -> page index
};

// A run of target text that can be shown in either script. `pairIdx` (optional)
// tags which sentence it belongs to, for Listen mode's sentence highlight.
function scriptSpan(pinyin, hanzi, pairIdx) {
  const pairAttr = Number.isFinite(pairIdx) ? ` data-pair="${pairIdx}"` : "";
  return `<span data-pinyin="${escape(pinyin)}" data-hanzi="${escape(hanzi ?? pinyin)}"${pairAttr}>${escape(pinyin)}</span>`;
}

// Script modes: "pinyin", "hanzi", or "ruby" (characters with pinyin above).
// Keep the original line grouping and English DOM intact when switching. Line
// breaks are measured in pinyin, the widest form, so the other modes always fit.
const HAN = /[\u3400-\u9fff]/;
const EDGE_PUNCT = /^([\p{P}\p{S}\s]*)([\s\S]*?)([\p{P}\p{S}\s]*)$/u;
function renderScriptInto(el, script) {
  const py = el.dataset.pinyin, hz = el.dataset.hanzi;
  // Pinyin lines carry a space before punctuation ("yíbàn , mén"); drop it so a
  // line never wraps to start with a comma.
  if (script !== "ruby") { el.textContent = script === "hanzi" ? hz : py.replace(/\s+(?=[,.!?;:)\]…])/g, ""); return; }
  if (!HAN.test(hz) || hz === py) { el.textContent = hz; return; }
  // Punctuation stays outside the annotation; only the words get pinyin.
  const [, lead, core, trail] = hz.match(EDGE_PUNCT);
  const rt = py.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "");
  el.innerHTML = `${escape(lead)}<ruby>${escape(core)}<rt>${escape(rt)}</rt></ruby>${escape(trail)}`;
}
const normScript = (script) => (script === "hanzi" || script === "ruby" ? script : "pinyin");
function setReaderScript(script) {
  _state.script = normScript(script);
  document.body.dataset.script = _state.script;
  for (const el of pagesEl().querySelectorAll("[data-pinyin]")) renderScriptInto(el, _state.script);
}

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
// Apostrophes inside a contraction belong to the word; quotation marks do not.
function englishBoundary(text, start, end) {
  const word = c => /[\p{L}\p{N}]/u.test(c || "");
  const internal = i => /['’]/.test(text[i] || "") && word(text[i - 1]) && word(text[i + 1]);
  return !(word(text[start]) && (word(text[start - 1]) || internal(start - 1))) &&
    !(word(text[end - 1]) && (word(text[end]) || internal(end)));
}
function findFirstUnclaimed(text, needle, claimed = new Set(), boundary = false, insensitive = false, from = 0) {
  if (!needle) return -1;
  const hay = insensitive ? text.toLowerCase() : text;
  const probe = insensitive ? needle.toLowerCase() : needle;
  for (let i = hay.indexOf(probe, from); i >= 0; i = hay.indexOf(probe, i + 1)) {
    if (boundary && !englishBoundary(text, i, i + needle.length)) continue;
    if (Array.from({ length: needle.length }, (_, k) => i + k).some(k => claimed.has(k))) continue;
    return i;
  }
  return -1;
}

function findChunkPositions(pair) {
  // Track which character positions are already claimed for target and english.
  const claimedTarget = new Set();
  const claimedEnglish = new Set();


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

  const exactPositions = findChunkPositions(pair);
  const pairToks = wordTokens(text);
  const tokenClaimed = new Array(pairToks.length).fill(false);
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
    const idx = exactPositions[ci].eStart;
    if (idx !== -1) {
      for (let p = idx; p < idx + span.length; p++) {
        if (coverage[p] === null) coverage[p] = ci;
      }
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
        if (!STOPWORDS.has(ct) && !STOPWORDS.has(pairToks[found].lower) && ct.length >= 3) {
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
  pair.alignment.forEach((chunk, ci) => {
    const pos = exactPositions[ci];
    if (pos.eStart < 0 || !chunk.lookup?.length) return;
    const inside = text.slice(pos.eStart, pos.eEnd), claimed = new Set();
    chunk.lookup.forEach((word, wi) => {
      const at = findFirstUnclaimed(inside, word.english, claimed, true, true);
      if (at < 0) return;
      for (let k = at; k < at + word.english.length; k++) {
        claimed.add(k); coverage[pos.eStart + k] = `${ci}:${wi}`;
      }
    });
  });
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
      const [ci, wi] = String(claim).split(":").map(Number);
      const parent = pair.alignment[ci];
      const chunk = Number.isInteger(wi) ? parent.lookup[wi] : parent;
      // Word key for vault/mastered matching: the target-language headword —
      // hanzi for Chinese, the target text for languages without a separate
      // script (e.g. French).
      const wordKey = chunk.hanzi || chunk.target || "";
      const attrs = [
        chunk.category ? `data-cat="${escape(chunk.category)}"` : "",
        chunk.frequency_band ? `data-freq="${escape(chunk.frequency_band)}"` : "",
        chunk.is_idiom ? `data-idiom="true"` : "",
        wordKey ? `data-hanzi="${escape(wordKey)}"` : "",
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
    if (localIdx > 0 && pair.paragraph_start) parts.push("<br>");

    if (!Array.isArray(pair.alignment) || pair.alignment.length === 0) {
      parts.push(`<span class="seg uncov" data-pair="${pairIdx}">${scriptSpan(pair.target, pair.hanzi)}</span>`);
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
    let hanziCursor = 0;
    for (const { idx: chunkIdx, pos } of ordered) {
      if (pos.tStart < cursor) continue; // overlap — skip (shouldn't happen with claim-based finder)

      const chunk = pair.alignment[chunkIdx];
      const hanziStart = chunk.hanzi && pair.hanzi
        ? pair.hanzi.indexOf(chunk.hanzi, hanziCursor) : -1;
      if (hanziStart >= 0) {
        parts.push(scriptSpan(pair.target.slice(cursor, pos.tStart), pair.hanzi.slice(hanziCursor, hanziStart), pairIdx));
      } else if (pos.tStart > cursor) {
        pushUncoveredText(parts, pair.target.slice(cursor, pos.tStart), pairIdx);
      }

      const uid = `p${pairIdx}c${chunkIdx}`;
      const attrs = [
        `class="seg chunk"`,
        `data-uid="${uid}"`,
        `data-pinyin="${escape(chunk.target)}"`,
        `data-hanzi="${escape(chunk.hanzi || chunk.target)}"`,
        `data-pair="${pairIdx}"`,
        chunk.category ? `data-cat="${escape(chunk.category)}"` : "",
        chunk.frequency_band ? `data-freq="${escape(chunk.frequency_band)}"` : "",
        chunk.is_idiom ? `data-idiom="true"` : "",
      ].filter(Boolean).join(" ");
      if (Array.isArray(chunk.lookup) && chunk.lookup.length) {
        // A phrase may have one sentence-alignment span but several vocabulary
        // units. Emit flat, independently selectable spans; preserve every
        // intervening apostrophe, space and punctuation mark exactly.
        let wordCursor = 0;
        for (let wi = 0; wi < chunk.lookup.length; wi++) {
          const word = chunk.lookup[wi];
          parts.push(escape(chunk.target.slice(wordCursor, word.start)));
          const wordAttrs = [
            `class="seg chunk"`, `data-uid="${uid}"`, `data-line-key="${uid}w${wi}"`, `data-lookup="${wi}"`,
            `data-pinyin="${escape(word.target)}"`, `data-hanzi="${escape(word.target)}"`,
            `data-pair="${pairIdx}"`,
            word.category ? `data-cat="${escape(word.category)}"` : "",
            word.frequency_band ? `data-freq="${escape(word.frequency_band)}"` : "",
            word.is_idiom ? `data-idiom="true"` : "",
          ].filter(Boolean).join(" ");
          parts.push(`<span ${wordAttrs}>${escape(word.target)}</span>`);
          chunkMeta.push({ uid: `${uid}w${wi}`, pairIdx, chunkIdx, lookupIdx: wi,
            claim: `${chunkIdx}:${wi}`, tStart: pos.tStart + word.start, tEnd: pos.tStart + word.end });
          wordCursor = word.end;
        }
        parts.push(escape(chunk.target.slice(wordCursor)));
      } else {
        parts.push(`<span ${attrs}>${escape(chunk.target)}</span>`);
      }

      if (!chunk.lookup?.length) chunkMeta.push({
        uid, pairIdx, chunkIdx, claim: chunkIdx, tStart: pos.tStart, tEnd: pos.tEnd,
        eStart: pos.eStart, eEnd: pos.eEnd,
        isGrammar: chunk.category === "grammar",
      });

      cursor = pos.tEnd;
      if (hanziStart >= 0) hanziCursor = hanziStart + chunk.hanzi.length;
    }

    if (cursor < pair.target.length) {
      if (pair.hanzi && hanziCursor) parts.push(scriptSpan(pair.target.slice(cursor), pair.hanzi.slice(hanziCursor), pairIdx));
      else pushUncoveredText(parts, pair.target.slice(cursor), pairIdx);
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
    segs: l.segs,
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
// Opening quotation marks belong to the first word on the next visual line.
// They are plain text, so starting a Range at the word alone would leave the
// opening mark under the previous sentence even when the browser kept it with
// this word during measurement.
function lineStartBoundary(seg) {
  const text = seg.previousSibling;
  const opening = text?.nodeType === 3 && text.data.match(/[«“]\s*$/u);
  return opening ? { node: text, offset: opening.index }
    : { node: seg.parentNode, offset: [...seg.parentNode.childNodes].indexOf(seg) };
}

function extractLineHtml(targetEl, lines, lineIdx) {
  const line = lines[lineIdx];
  const range = document.createRange();
  if (lineIdx === 0) {
    range.setStart(targetEl, 0);
  } else {
    const start = lineStartBoundary(line.firstSeg);
    range.setStart(start.node, start.offset);
  }
  if (lineIdx === lines.length - 1) {
    range.setEnd(targetEl, targetEl.childNodes.length);
  } else {
    const end = lineStartBoundary(lines[lineIdx + 1].firstSeg);
    range.setEnd(end.node, end.offset);
  }
  const wrap = document.createElement("div");
  wrap.appendChild(range.cloneContents());
  return wrap.innerHTML.replace(/<br\s*\/?>/gi, "");
}

// Choose a monotonic word-boundary cut with the fewest characters assigned to
// the wrong target line. Source share breaks ties when order differs or a gloss
// is absent. Reserve words for remaining lines whenever the sentence permits it.
function bestEnglishCut(text, coverage, ownerLines, line, cursor, fraction, remainingLines) {
  const tokens = wordTokens(text).filter(t => t.end > cursor);
  const canReserve = tokens.length > remainingLines;
  const candidates = tokens.map(t => t.end).filter(end => !canReserve ||
    tokens.filter(t => t.start >= end).length >= remainingLines);
  if (!canReserve) candidates.push(cursor);
  if (!candidates.length) return text.length;
  let best = candidates[0], score = Infinity, distance = Infinity;
  for (const cut of candidates) {
    let cost = 0;
    for (let k = cursor; k < coverage.length; k++) {
      const owner = ownerLines.get(String(coverage[k]));
      if (owner == null) continue;
      if ((owner <= line && k >= cut) || (owner > line && k < cut)) cost++;
    }
    const d = Math.abs(cut - fraction * text.length);
    if (cost < score || (cost === score && d < distance)) { best = cut; score = cost; distance = d; }
  }
  // Keep sentence punctuation with its preceding word.
  while (best < text.length && !/[\p{L}\p{N}]/u.test(text[best])) best++;
  return best;
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
 *         pair.english between the per-pair cursor and a forward word-boundary
 *         cut that minimises misplaced English; source share breaks ties.
 *         The last line touched by the pair takes the remainder.
 *   5. Replace pageEl.innerHTML with the final blocks.
 *   6. Verification: after layout, warn if any final target wrapped.
 */
function renderPageInto(pageEl, pairs, pageStartIdx) {
  // Step 1: build pinyin html + chunk metadata (uids use chapter-global pair index).
  const { html: pinyinHtml, chunkMeta } = buildPinyinHtml(pairs, pageStartIdx);

  // Step 2: mount measurement-only structure on the page.
  pageEl.innerHTML = `<p class="target measure-target">${pinyinHtml}</p>`;
  const measureTarget = pageEl.querySelector(".measure-target");

  // French quote spacing must stay attached to its word when measuring.
  // Keep the source JSON untouched; NBSP is a display-only typographic space.
  if (pairs.some(p => !p.hanzi)) {
    const walker = document.createTreeWalker(measureTarget, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) walker.currentNode.data = walker.currentNode.data
      .replace(/([«“]) +/gu, "$1\u00a0").replace(/ +(?=»)/gu, "\u00a0");
  }

  // Force layout to be current before measuring.
  void measureTarget.offsetHeight;

  // Step 3: group ALL .seg spans (chunks + uncov) by visual line.
  const lines = groupSegsByLine(measureTarget);

  // chunk uid -> visual line index
  const chunkLine = new Map();
  // pair index -> Set of visual line indices it touches
  const pairLines = new Map();

  const targetEnds = new Map();
  const targetCursors = new Map();
  lines.forEach((line, lineIdx) => {
    for (const span of line.segs) {
      const pairIdx = parseInt(span.dataset.pair, 10);
      if (Number.isFinite(pairIdx)) {
        if (!pairLines.has(pairIdx)) pairLines.set(pairIdx, new Set());
        pairLines.get(pairIdx).add(lineIdx);
        const pair = pairs[pairIdx - pageStartIdx];
        const text = span.dataset.pinyin || span.textContent;
        const at = pair.target.indexOf(text, targetCursors.get(pairIdx) || 0);
        if (at >= 0) { targetCursors.set(pairIdx, at + text.length); targetEnds.set(`${pairIdx}:${lineIdx}`, at + text.length); }
      }
      if (span.dataset.uid) {
        const key = span.dataset.lineKey || span.dataset.uid;
        if (!chunkLine.has(key)) chunkLine.set(key, lineIdx);
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

      const cursor = englishCursor.get(pairIdx) || 0;
      const touched = [...pairLines.get(pairIdx)];
      const lastLine = Math.max(...touched);
      const coverage = englishCoverages.get(pairIdx) || new Array(pair.english.length).fill(null);
      const fraction = (targetEnds.get(`${pairIdx}:${lineIdx}`) || 0) / Math.max(1, pair.target.length);
      const units = chunkMeta.filter(m => m.pairIdx === pairIdx).map(m => ({ ...m, line: chunkLine.get(m.uid) }));
      // Parent fallback belongs to the first line of a phrase, never its last.
      const ownerLines = new Map();
      for (const m of units) {
        ownerLines.set(String(m.claim), m.line);
        const parent = String(m.chunkIdx);
        if (!ownerLines.has(parent) || m.line < ownerLines.get(parent)) ownerLines.set(parent, m.line);
      }
      const cut = lineIdx === lastLine ? pair.english.length : bestEnglishCut(
        pair.english, coverage, ownerLines, lineIdx, cursor, fraction,
        touched.filter(l => l > lineIdx).length
      );

      if (cut > cursor) {
        englishParts.push(
          emitEnglishSlice(pair, coverage, cursor, cut)
        );
        englishCursor.set(pairIdx, cut);
      }
    }

    blocks.push({
      paragraphStart: pairsOnLine.some(g => pairByGlobal.get(g)?.paragraph_start && Math.min(...pairLines.get(g)) === lineIdx),
      pinyinHtml: pinyinLineHtml,
      englishHtml: englishParts.join(" "),
    });
  }

  // Step 5: replace pageEl with final block HTML.
  pageEl.innerHTML = blocks
    .map(
      (b) => `
        <div class="reader-block${b.paragraphStart ? " paragraph-start" : ""}">
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
    <div class="target">${scriptSpan(chapter.title.target, chapter.title.hanzi)}</div>
    <div class="english">${escape(chapter.title.english)}</div>
    <div class="chapter-known-line" hidden></div>
    <div class="chapter-watch" hidden></div>
  `;
  container.appendChild(titlePage);

  if (_state.targetOnly) {
    renderFlowPages(container, chapter);
  } else {
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
      <div class="end-quiz" hidden></div>
      <div class="end-card">
        <div class="end-label">You've finished this chapter</div>
        <div class="end-divider"></div>
        <div class="end-next-label">Next up</div>
        <div class="end-target">${scriptSpan(nextChapter.title?.target || "", nextChapter.title?.hanzi)}</div>
        <h3 class="end-title">${escape(nextChapter.title?.english || nextChapter.id)}</h3>
        <button class="end-next-btn" data-next-id="${escape(nextChapter.id)}">Read →</button>
      </div>
    `;
  } else {
    endPage.innerHTML = `
      <div class="end-quiz" hidden></div>
      <div class="end-card">
        <div class="end-label">End of book</div>
        <p class="end-msg">You've finished the last chapter.</p>
      </div>
    `;
  }
  container.appendChild(endPage);

  _state.pagesCount = container.children.length;
  buildPairPageMap();
}

/* ───────────────────────── target language only (book layout) ───────────────────────── */

// Where paragraphs start, best source first:
//   1. `paragraph_start: true` on pairs (if any pair in the chapter has the field);
//   2. a line break in the text — the AI-written books begin each new
//      paragraph's first sentence with "\n";
//   3. otherwise, where a line of dialogue starts or ends (the usual shape of a novel).
const OPEN_QUOTE = /^[“"«「『‘]/;
const CLOSE_QUOTE = /[”"»」』’][。.!?！？,，…]?$/;
const rawText = (p) => p.hanzi || p.target || "";
const NO_LINE_START = /^[，。、！？；：”’）》」』,.!?;:)\]…]/;
function paragraphStarts(pairs) {
  const marked = pairs.some((p) => "paragraph_start" in p);
  const hasBreaks = !marked && pairs.some((p) => rawText(p).includes("\n"));
  return pairs.map((p, i) => {
    if (i === 0) return true;
    if (marked) return !!p.paragraph_start;
    if (hasBreaks) return /^\s*\n/.test(rawText(p)) || /\n\s*$/.test(rawText(pairs[i - 1]));
    return OPEN_QUOTE.test(rawText(p).trim()) || CLOSE_QUOTE.test(rawText(pairs[i - 1]).trim());
  });
}

/**
 * Lay the chapter out as flowing paragraphs (no English lines), filling each
 * page to the screen: sentences are added until the page would overflow, then
 * a new page starts (continuing the paragraph). Measured in the current script,
 * so it's re-run when the script changes.
 */
function renderFlowPages(container, chapter) {
  const pairs = chapter.pairs;
  const starts = paragraphStarts(pairs);
  // Chinese characters run together; pinyin and other languages are spaced.
  const joiner = (chapter.language || "zh") === "zh" && _state.script !== "pinyin" ? "" : " ";
  let page, block, para;
  const newPage = () => {
    page = document.createElement("section");
    page.className = "reader-page flow-page";
    block = document.createElement("div");
    block.className = "reader-block flow";
    page.appendChild(block);
    container.appendChild(page);
    para = null;
  };
  const newPara = (continued) => {
    para = document.createElement("p");
    para.className = continued ? "target cont" : "target";
    block.appendChild(para);
  };
  newPage();
  pairs.forEach((pair, i) => {
    if (!para || starts[i]) newPara(false);
    const sep = para.childNodes.length && joiner ? document.createTextNode(joiner) : null;
    if (sep) para.appendChild(sep);
    const span = document.createElement("span");
    span.className = "flow-pair";
    span.innerHTML = buildPinyinHtml([pair], i).html;
    for (const el of span.querySelectorAll("[data-pinyin]")) renderScriptInto(el, _state.script);
    // Allow a line break between any two words (characters with pinyin above
    // otherwise run together with nowhere to wrap).
    // Never before closing punctuation, so no line starts with "，" or "。".
    for (const el of span.querySelectorAll(".seg, [data-pinyin]")) {
      let sib = el.nextSibling;
      while (sib && !(sib.textContent || "").trim()) sib = sib.nextSibling;   // skip empty gaps
      if (!NO_LINE_START.test((sib?.textContent || "").trimStart())) el.after(document.createElement("wbr"));
    }
    para.appendChild(span);
    // Overflowed (and not the page's only sentence)? Move it to a fresh page.
    if (page.scrollHeight > page.clientHeight + 1 && block.querySelectorAll(".flow-pair").length > 1) {
      span.remove();
      if (sep) sep.remove();
      if (!para.childNodes.length) para.remove();
      newPage();
      newPara(!starts[i]);
      para.appendChild(span);
    }
  });
}

function buildPairPageMap() {
  _state.pairPage = new Map();
  [...pagesEl().children].forEach((page, pi) => {
    for (const el of page.querySelectorAll(".reader-block > p.target [data-pair]")) {
      const i = parseInt(el.dataset.pair, 10);
      if (Number.isFinite(i) && !_state.pairPage.has(i)) _state.pairPage.set(i, pi);
    }
  });
}

// First sentence on a page: null on the title page, -1 on the end page.
function anchorPair(page) {
  if (page <= 0) return null;
  if (page >= _state.pagesCount - 1) return -1;
  let min = null;
  for (const [i, p] of _state.pairPage) if (p === page && (min === null || i < min)) min = i;
  return min;
}
function pageForAnchor(anchor, fallbackPage) {
  if (anchor === -1) return _state.pagesCount - 1;
  if (anchor !== null && anchor !== undefined && _state.pairPage.has(anchor)) return _state.pairPage.get(anchor);
  return Math.min(Math.max(fallbackPage ?? 0, 0), _state.pagesCount - 1);
}

/** Re-render the open chapter (English on/off, or a script change in book layout), keeping the place. */
async function relayout() {
  if (!_state.chapter) return;
  const settings = await getSettings();
  const anchor = anchorPair(_state.currentPage);
  const fromPage = _state.currentPage;
  _state.targetOnly = isTargetOnly(settings);
  document.body.classList.toggle("target-only", _state.targetOnly);
  renderChapter(_state.chapter, settings.pairsPerPage);
  setReaderScript(_state.script);
  applyMasteredHiding();
  renderChapterWatch();
  renderKnownLine();
  renderEndQuiz();
  const page = fromPage === 0 ? 0 : pageForAnchor(anchor, fromPage);
  _state.currentPage = page;
  scrollToPage(pagesEl(), page);
  updateIndicator();
  window.dispatchEvent(new CustomEvent("reader:rerendered"));
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
  bumpActivity({ pages: 1 }).catch(() => {});
  window.dispatchEvent(new CustomEvent("reader:page", { detail: { page } }));
  clearTimeout(_state.saveTimer);
  _state.saveTimer = setTimeout(() => {
    if (_state.bookId && _state.chapterId) {
      putProgress(_state.bookId, _state.chapterId, _state.currentPage, anchorPair(_state.currentPage));
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
    const parent = pair?.alignment?.[chunkIdx];
    const lookupIdx = segEl.hasAttribute("data-lookup") ? Number(segEl.dataset.lookup) : null;
    const align = lookupIdx !== null ? parent?.lookup?.[lookupIdx] : parent;
    if (!align) return;

    openPopover(
      {
        target: _state.script !== "pinyin" ? (align.hanzi || align.target) : align.target,
        english: align.english,
        category: align.category,
        frequency_band: align.frequency_band,
        is_idiom: align.is_idiom,
        hanzi: align.hanzi || null,      // for TTS + the "other script" line
        pinyin: align.target || null,    // the chunk's pinyin (for the "other script" line)
        pairIdx,
        chunkIdx,
        targetStart: findChunkPositions(pair)[chunkIdx].tStart + (lookupIdx !== null ? align.start : 0),
        targetEnd: findChunkPositions(pair)[chunkIdx].tStart + (lookupIdx !== null ? align.end : align.target.length),
        hanziStart: align.hanzi ? pair.hanzi?.indexOf(align.hanzi) : null,
        script: _state.script === "pinyin" ? "pinyin" : "hanzi",
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
      // No per-word hanzi for an uncovered token; fall back to the whole pair's
      // characters so "Hear pronunciation" still speaks something sensible.
      hanzi: _state.chapter?.pairs?.[pairIdx]?.hanzi || null,
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

  // Tell the Language Assistant which book (and language) is open, so it tutors
  // in the right language and scopes its conversation to this book.
  window.dispatchEvent(new CustomEvent("reader:opened", {
    detail: {
      bookId,
      language: chapter.language || book?.language || "",
      title: chapter.title?.english || book?.title?.english || "",
    },
  }));

  // The pinyin/characters toggle only makes sense for Chinese; hide it for other
  // languages (e.g. French), which have a single written form.
  const isChinese = (chapter.language || "zh") === "zh";
  const scriptSection = document.getElementById("reader-script-section");
  if (scriptSection) scriptSection.hidden = !isChinese;
  const hasHanzi = isChinese && chapter.pairs.every(pair => pair.hanzi &&
    (pair.alignment || []).every(chunk => chunk.hanzi));
  document.getElementById("reader-script").disabled = !hasHanzi;
  document.getElementById("reader-script-hint").textContent = hasHanzi
    ? "Switch anytime. English and word colours stay the same."
    : "Chinese characters aren't included in this book yet.";
  // Books without characters (pinyin-only, or other languages) always show plain text.
  const script = hasHanzi ? settings.readerScript : "pinyin";
  _state.script = normScript(script);   // the book layout measures in the shown script
  document.body.dataset.script = _state.script;   // (with its styles applied)
  _state.targetOnly = isTargetOnly(settings);
  document.body.classList.toggle("target-only", _state.targetOnly);
  renderChapter(chapter, settings.pairsPerPage);
  setReaderScript(script);

  // Mastered-word English hiding: refresh the set, apply the body flag, and mark
  // the matching English spans so they fade (if the setting is on).
  await ensureMastered();
  document.body.classList.toggle("hide-mastered", settings.hideMastered !== false);
  applyMasteredHiding();
  renderChapterWatch();
  renderKnownLine();
  renderEndQuiz();

  document.getElementById("title").textContent = chapter.title.english;

  const container = pagesEl();
  // Prefer the saved sentence: page numbers differ between layouts. Position now
  // (layout is already done — the pages were measured) and again after the next
  // paint in case the browser hadn't applied the scroll yet.
  const startPage = (progress?.lastPage ?? 0) === 0 ? 0 : pageForAnchor(progress?.pair, progress?.lastPage);
  const position = () => {
    _state.currentPage = startPage;
    scrollToPage(container, startPage);
    updateIndicator();
  };
  position();
  requestAnimationFrame(() => { if (_state.chapter === chapter && _state.currentPage === startPage) position(); });

  container.removeEventListener("scroll", handleScroll);
  container.addEventListener("scroll", handleScroll, { passive: true });
  container.removeEventListener("click", handleChunkTap);
  container.addEventListener("click", handleChunkTap);
  container.removeEventListener("click", handleNextChapterTap);
  container.addEventListener("click", handleNextChapterTap);

  return true;
}

/* ───────────────────────── words to watch (title page) ───────────────────────── */

// Saved words that appear in this chapter and aren't mastered yet, shown on the
// title page with a button to quiz them before reading.
async function renderChapterWatch() {
  const slot = pagesEl().querySelector(".title-page .chapter-watch");
  if (!slot || !_state.chapter) return;
  const words = await chapterWatchWords(_state.chapter);
  if (!words.length) { slot.hidden = true; slot.innerHTML = ""; return; }
  const counts = { new: 0, learning: 0 };
  for (const w of words) counts[w.bucket] = (counts[w.bucket] || 0) + 1;
  const summary = [counts.learning && `${counts.learning} learning`, counts.new && `${counts.new} new`].filter(Boolean).join(" · ");
  const shown = words.slice(0, 10);
  const wordLabel = (w) => (_state.script === "pinyin" && w.item.pinyin ? w.item.pinyin : w.item.hanzi);
  slot.innerHTML = `
    <div class="watch-label">Words to watch</div>
    <div class="watch-summary">${escape(summary)} from your Memory Vault</div>
    <div class="watch-chips">${shown.map((w) => `<span class="watch-chip ${w.bucket}">${escape(wordLabel(w))}</span>`).join("")}${words.length > shown.length ? `<span class="watch-more">+${words.length - shown.length}</span>` : ""}</div>
    <button class="watch-quiz">Quiz ${words.length === 1 ? "this word" : `these ${words.length}`} first</button>`;
  slot.hidden = false;
  slot.querySelector(".watch-quiz").addEventListener("click", () => {
    startQuizWithItems(words.map((w) => w.item), { title: "Chapter words" });
  });
}

/* ───────────────────────── how much you know (title page) ───────────────────────── */

async function renderKnownLine() {
  const el = pagesEl().querySelector(".title-page .chapter-known-line");
  const chapter = _state.chapter;
  if (!el || !chapter) return;
  const lang = chapter.language || "zh";
  if (lang === "fr") { el.hidden = true; return; }
  if (lang === "zh") await loadLevels();
  const level = learnerLevel(await getSettings(), lang);
  const k = chapterKnowledge(chapter, level, await vaultBucketMap(lang));
  if (_state.chapter !== chapter || !k.total) return;
  const n = k.newWords.length;
  el.innerHTML = `<b>≈${k.pct}%</b> of the words here are ones you know <span>${n} new word${n === 1 ? "" : "s"} · at ${escape(levelName(level))} level</span>`;
  el.className = `chapter-known-line ${k.pct >= 95 ? "easy" : k.pct >= 85 ? "ok" : "hard"}`;
  el.hidden = false;
}

/* ───────────────────────── end-of-chapter quiz ───────────────────────── */

async function renderEndQuiz() {
  const slot = pagesEl().querySelector(".end-page .end-quiz");
  const chapter = _state.chapter, bookId = _state.bookId;
  if (!slot || !chapter) return;
  const settings = await getSettings();
  const prefs = bookQuizPrefs(settings, bookId, chapter.language);
  if (!prefs.on) { slot.hidden = true; return; }
  const lang = chapter.language || "zh";
  if (lang === "zh") await loadLevels();
  if (_state.chapter !== chapter) return;

  const draw = async (level) => {
    const latest = await getSettings();
    if (_state.chapter !== chapter) return;
    const quiz = buildChapterQuiz(chapter, level, { bookId, history: latest.chapterQuizHistory?.[`${bookId}/${chapter.id}/${level}`] || [] });
    if (!quiz.cards.length) { slot.hidden = true; return; }
    slot.innerHTML = `
      <div class="end-quiz-head">
        <div>
          <div class="end-label">Chapter quiz</div>
          <div class="end-quiz-sub">${quiz.cards.length} questions on this chapter's words</div>
        </div>
        <select class="end-quiz-level" aria-label="Quiz level">
          ${LEVELS.map((l) => `<option value="${l.n}"${l.n === level ? " selected" : ""}>${l.name}</option>`).join("")}
        </select>
      </div>
      <button class="end-quiz-start">Start quiz</button>
      <p class="end-quiz-note">Optional. Turn it off or set the default level on the book's page.</p>`;
    slot.hidden = false;
    slot.querySelector(".end-quiz-start").addEventListener("click", async () => {
      const next = await nextChapterQuiz(chapter, level, { bookId });
      startCardQuiz(next.cards, { title: `${levelName(level)} chapter quiz`, lang });
    });
    slot.querySelector(".end-quiz-level").addEventListener("change", async (e) => {
      const lvl = clampLevel(e.target.value);
      draw(lvl);
      // Remember the choice for this book, like the book page's level picker.
      await updateSettings(s => ({ bookQuiz: { ...(s.bookQuiz || {}), [bookId]: { ...bookQuizPrefs(s, bookId), level: lvl } } }));
    });
  };
  draw(prefs.level);
}

/** Read-only view of the open chapter, for Listen mode. */
export function getReaderContext() {
  if (!_state.chapter) return null;
  return {
    bookId: _state.bookId,
    chapterId: _state.chapterId,
    chapter: _state.chapter,
    language: _state.chapter.language || "zh",
    currentPage: _state.currentPage,
    pagesCount: _state.pagesCount,
    script: _state.script,
  };
}

/** The page <section> elements, in order (title, content…, end). */
export function getPageElements() {
  return [...pagesEl().children];
}

/** Turn to a page programmatically (fires the normal page-change handling). */
export function goToPage(page) {
  const container = pagesEl();
  const p = Math.min(Math.max(page, 0), _state.pagesCount - 1);
  scrollToPage(container, p);
}

export function closeReader() {
  const container = pagesEl();
  container.removeEventListener("scroll", handleScroll);
  container.removeEventListener("click", handleChunkTap);
  container.removeEventListener("click", handleNextChapterTap);
  clearTimeout(_state.saveTimer);
  if (_state.bookId && _state.chapterId) {
    putProgress(_state.bookId, _state.chapterId, _state.currentPage, anchorPair(_state.currentPage));
  }
  _state.bookId = null;
  _state.chapterId = null;
  _state.chapter = null;
  _state.bookChapters = [];
  _state.pagesCount = 0;
  _state.currentPage = 0;
  pagesEl().innerHTML = "";
}

window.addEventListener("reader:script", (event) => {
  setReaderScript(event.detail);
  if (_state.targetOnly) relayout();   // re-paginate: characters take less room than pinyin
});
window.addEventListener("reader:layout", () => relayout());

window.addEventListener("view:changed", e => {
  if (e.detail !== "reader" || !_state.chapter) return;
  const chapter = _state.chapter;
  ensureMastered().then(() => { if (_state.chapter !== chapter) return; applyMasteredHiding(); renderChapterWatch(); renderKnownLine(); renderEndQuiz(); });
});
