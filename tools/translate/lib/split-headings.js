// Deterministic chapter splitter for well-formatted sources.
//
// When a source has explicit "Chapter N: Title" headings (each on its own
// line), we don't need the LLM structure analyzer at all — we split on the
// headings with a regex. This removes the analyzer's single-large-call cost
// and its rate-limit ceiling, so an entire multi-chapter book can go through
// in ONE run. Produces the same section shape the analyzer path yields, so
// the rest of the pipeline is unchanged.

// A heading line: optional markdown #'s, then "Chapter <number>", an optional
// separator, and the (optional) title. Matched case-insensitively, anchored
// to its own line.
const HEADING_RE = /^[ \t]*#{0,6}[ \t]*chapter[ \t]+(\d+)[ \t]*[:.\-—)]*[ \t]*(.*?)[ \t]*$/i;

/**
 * Split cleaned text into chapter sections by "Chapter N" headings.
 * Lines before the first heading (book title, epigraph, front matter) are
 * ignored. Each section's `text` INCLUDES its heading line, so deriveChapterId
 * can read the number and stripLeadingHeading can remove it before clausing.
 *
 * @returns {Array<{kind, chapterNum, english_title, text, synopsis, skip, markerFound, id_suggestion}>}
 */
export function splitByHeadings(rawText) {
  const lines = String(rawText || "").split(/\r?\n/);
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      if (cur) sections.push(cur);
      const num = parseInt(m[1], 10);
      const title = (m[2] || "").trim() || `Chapter ${num}`;
      cur = { kind: "chapter", chapterNum: num, english_title: title, _lines: [line] };
    } else if (cur) {
      cur._lines.push(line);
    }
  }
  if (cur) sections.push(cur);

  for (const s of sections) {
    s.text = s._lines.join("\n").trim();
    delete s._lines;
    s.synopsis = null;
    s.skip = false;
    s.markerFound = true;
    s.id_suggestion = `ch-${s.chapterNum}`;
  }
  return sections;
}

/** How many "Chapter N" headings the text contains (for auto-detect / preflight). */
export function countHeadings(rawText) {
  let n = 0;
  for (const line of String(rawText || "").split(/\r?\n/)) {
    if (HEADING_RE.test(line)) n++;
  }
  return n;
}
