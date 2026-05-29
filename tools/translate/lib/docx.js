// Read a .docx or .txt file and return clean prose text.
//
// For .docx we use mammoth.extractRawText which strips all formatting.
// We then run a cleaning pass to remove the kinds of junk that crop up
// in publisher exports: page numbers on their own lines, running headers,
// soft-hyphenated line breaks, multiple blank lines, weird whitespace.

import fs from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";

export async function readInput(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let raw;
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    raw = result.value;
  } else if (ext === ".txt" || ext === ".md") {
    raw = await fs.readFile(filePath, "utf8");
  } else {
    throw new Error(`Unsupported input extension: ${ext}. Use .docx, .txt, or .md.`);
  }
  return raw;
}

/**
 * Clean publisher-export noise out of extracted text.
 * Returns { cleaned, removed: { pageNumbers, repeatedHeaders, blankRuns } }
 */
export function clean(raw) {
  const stats = { pageNumbers: 0, repeatedHeaders: 0, blankRuns: 0 };

  // Normalize line endings
  let text = raw.replace(/\r\n?/g, "\n");

  // Smart-quote normalization is optional; we keep them since they read better.
  // Replace non-breaking spaces with normal spaces.
  text = text.replace(/ /g, " ");

  // Stitch soft-hyphenated line breaks: "infor-\nmation" -> "information"
  text = text.replace(/(\w)-\n(\w)/g, "$1$2");

  // Strip pipe characters used as soft visual breaks in some publisher
  // exports — they survive .docx → text extraction as literal "|" and
  // confuse downstream prompts (the translator sees them as content). We
  // treat them as a space so clause boundaries that the pipe was marking
  // get picked up by the regex splitter on its own.
  text = text.replace(/\|/g, " ");

  // Split into lines for line-level cleanup
  let lines = text.split("\n");

  // Strip lines that are just a page number (lone digits, optionally Roman)
  lines = lines.filter((line) => {
    const trimmed = line.trim();
    if (/^\d{1,4}$/.test(trimmed)) { stats.pageNumbers++; return false; }
    if (/^[ivxlcdm]{1,8}$/i.test(trimmed) && trimmed.length <= 8 && /^[ivxlcdm]+$/i.test(trimmed)) {
      // Lone roman numeral lines (preface page numbers)
      stats.pageNumbers++; return false;
    }
    return true;
  });

  // Detect repeated short headers/footers. Two pickup criteria:
  //   (a) a line appears 3+ times anywhere
  //   (b) a line appears 2+ times AND at least one of those copies is in the
  //       first or last 10% of the document (where title-page repeats and
  //       running headers cluster)
  const lineCounts = new Map();      // line -> count
  const linePositions = new Map();   // line -> [indices]
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.length > 60) continue;
    lineCounts.set(t, (lineCounts.get(t) || 0) + 1);
    if (!linePositions.has(t)) linePositions.set(t, []);
    linePositions.get(t).push(i);
  }
  const edgeStart = Math.floor(lines.length * 0.1);
  const edgeEnd = Math.ceil(lines.length * 0.9);
  const headerCandidates = new Set();
  for (const [line, count] of lineCounts) {
    if (count >= 3) { headerCandidates.add(line); continue; }
    if (count >= 2) {
      const positions = linePositions.get(line);
      if (positions.some((p) => p < edgeStart || p >= edgeEnd)) {
        headerCandidates.add(line);
      }
    }
  }
  if (headerCandidates.size > 0) {
    lines = lines.filter((line) => {
      if (headerCandidates.has(line.trim())) { stats.repeatedHeaders++; return false; }
      return true;
    });
  }

  // Trim trailing whitespace on each line
  lines = lines.map((line) => line.replace(/[ \t]+$/g, ""));

  // Collapse runs of 3+ blank lines into 2
  const out = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blankRun++;
      if (blankRun > 2) { stats.blankRuns++; continue; }
    } else {
      blankRun = 0;
    }
    out.push(line);
  }

  // Trim doc-level whitespace
  return { cleaned: out.join("\n").trim(), stats };
}

export async function readAndClean(filePath) {
  const raw = await readInput(filePath);
  return clean(raw);
}
