// Split English prose into short clauses suitable for paired-line display.
//
// Heuristic (per the brief):
//   - Split on , ; — sentence boundaries
//   - Cap any single clause at ~12 words
//   - Merge very short fragments (< 3 words) into the next clause
//
// Each output clause keeps its surrounding punctuation context naturally
// (we don't strip commas/dashes); the LLM uses these to phrase the
// translation accurately.

const MIN_WORDS = 3;
const TARGETS = {
  short:  { max: 7,  cap: 9  },
  medium: { max: 12, cap: 15 },
  long:   { max: 18, cap: 22 },
};

function wordCount(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Split text into raw clause-ish chunks on punctuation.
 * Keeps the punctuation as the boundary so we can rebuild fluent text.
 */
function splitOnPunct(text) {
  // Use a regex that captures the splitter. We split on:
  //   . ! ? (followed by whitespace or end)
  //   , ; : (anywhere — comma is the most common in-sentence split)
  //   — – (em/en dashes)
  //   newline
  const parts = [];
  let buf = "";
  const SPLIT_RE = /([.!?])(\s|$)|([,;:])|(\s*[—–]\s*)|(\n+)/g;
  let lastIndex = 0;
  let m;
  while ((m = SPLIT_RE.exec(text)) !== null) {
    const chunkEnd = m.index + (m[1] ? 1 : m[3] ? 1 : m[4] ? m[4].length : 0);
    const chunk = text.slice(lastIndex, chunkEnd).trim();
    if (chunk) parts.push(chunk);
    lastIndex = SPLIT_RE.lastIndex;
  }
  const tail = text.slice(lastIndex).trim();
  if (tail) parts.push(tail);
  return parts.filter(Boolean);
}

/**
 * Hard cap by word count: if a clause is longer than `cap` words, slice it
 * at the nearest whitespace before the cap. Repeats until under cap.
 */
function hardCap(clause, cap) {
  const out = [];
  let remaining = clause.trim();
  while (wordCount(remaining) > cap) {
    const words = remaining.split(/\s+/);
    const slice = words.slice(0, cap).join(" ");
    out.push(slice);
    remaining = words.slice(cap).join(" ");
  }
  if (remaining) out.push(remaining);
  return out;
}

/**
 * Merge clauses that are too short (< MIN_WORDS) into their neighbor.
 */
function mergeShort(clauses) {
  const out = [];
  for (const c of clauses) {
    if (out.length > 0 && wordCount(out[out.length - 1]) < MIN_WORDS) {
      out[out.length - 1] = out[out.length - 1] + " " + c;
    } else {
      out.push(c);
    }
  }
  return out;
}

/**
 * Main entry: split English prose into an array of clause strings.
 * @param {string} text Cleaned English prose.
 * @param {'short'|'medium'|'long'} length Clause-length target.
 */
export function splitClauses(text, length = "medium") {
  const target = TARGETS[length] || TARGETS.medium;

  // Split into paragraphs first to preserve paragraph boundaries — we don't
  // want a clause to span two paragraphs.
  const paragraphs = text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);

  const all = [];
  for (const para of paragraphs) {
    const collapsed = para.replace(/\s+/g, " ");
    let parts = splitOnPunct(collapsed);
    // Apply hard cap to each part
    parts = parts.flatMap((p) => hardCap(p, target.cap));
    // Merge runaway-short fragments
    parts = mergeShort(parts);
    all.push(...parts);
  }
  return all;
}

/**
 * For diagnostics: report word-count distribution of a clause array.
 */
export function clauseStats(clauses) {
  const counts = clauses.map(wordCount);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  return { n: clauses.length, min, max, mean: +mean.toFixed(1) };
}
