#!/usr/bin/env node
// Bilingual Reader translation CLI (v2 — book-aware).
//
// Usage:
//   node tools/translate --in books_for_processing/treasure-island.docx
//
// The tool now auto-detects the book/chapters and generates ids, titles,
// and synopses via an LLM pre-pass. Most flags are optional.

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

import { readAndClean } from "./lib/docx.js";
import { splitClauses, clauseStats } from "./lib/clauses.js";
import {
  buildClient,
  translateClauses,
  translateTitle,
  validatePairs,
  estimateCost,
} from "./lib/translate.js";
import { analyzeContent, sliceByMarkers } from "./lib/analyze.js";
import { renderCover } from "./lib/cover.js";
import { readLibrary, upsertBook, writeLibrary } from "./lib/library.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Auto-load tool-scoped .env so OPENAI_API_KEY doesn't have to live in shell.
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch (err) {
  if (err.code !== "ENOENT") console.warn(`Warning: could not load .env: ${err.message}`);
}

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CONTENT_DIR = path.join(REPO_ROOT, "content");
const BOOKS_DIR = path.join(CONTENT_DIR, "books");
const LIBRARY_PATH = path.join(CONTENT_DIR, "library.json");

function fmt(n) { return n.toLocaleString("en-US"); }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }
function bold(s) { return `\x1b[1m${s}\x1b[0m`; }
function cyan(s) { return `\x1b[36m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }
function red(s) { return `\x1b[31m${s}\x1b[0m`; }

async function prompt(question) {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim().toLowerCase();
}

const program = new Command();
program
  .name("translate")
  .description("Convert an English book/chapter .docx into bilingual pinyin/English chapters in the reader library.")
  .requiredOption("--in <file>", "Input file (.docx, .txt, or .md)")
  .option("--book-id <id>", "Override the auto-detected book id (kebab-case)")
  .option("--include-front-matter", "Translate sections the analyzer flagged as skip (title pages, dedications, etc)")
  .option("--length <preset>", "Clause length: short | medium | long", "medium")
  .option("--model <name>", "OpenAI model for translation", "gpt-4o")
  .option("--analyzer-model <name>", "OpenAI model for the pre-pass analysis (cheap)", "gpt-4o-mini")
  .option("--dry-run", "Analyze + show plan, but no translation API calls and no writes")
  .option("--yes", "Skip all confirmation prompts")
  .option("--no-cover", "Skip generating an auto cover")
  .parse(process.argv);

const opts = program.opts();

async function main() {
  console.log(`\n${bold("📖 Bilingual Reader — translate")}`);
  console.log(`   In:           ${opts.in}`);
  console.log(`   Model:        ${opts.model}  ${dim("(analysis: " + opts.analyzerModel + ")")}`);
  console.log(`   Clause length: ${opts.length}\n`);

  // ────────────────────────────────────────────────────────────
  // Step 1. Read + clean
  // ────────────────────────────────────────────────────────────
  console.log(bold("1.") + " Reading and cleaning input…");
  const { cleaned, stats: cleanStats } = await readAndClean(opts.in);
  console.log(`   ${fmt(cleaned.length)} chars after cleaning`);
  if (cleanStats.pageNumbers || cleanStats.repeatedHeaders || cleanStats.blankRuns) {
    console.log(dim(`   removed: ${cleanStats.pageNumbers} page numbers, ${cleanStats.repeatedHeaders} repeated headers, ${cleanStats.blankRuns} extra blank lines`));
  }
  if (!opts.yes && !opts.dryRun) {
    // Show preview only on real runs, not dry-runs (where we want the analyzer output to be the focus)
  }

  // ────────────────────────────────────────────────────────────
  // Step 2. Analyze structure (LLM pre-pass)
  // ────────────────────────────────────────────────────────────
  console.log("\n" + bold("2.") + " Analyzing structure (LLM pre-pass)…");
  const client = buildClient(process.env.OPENAI_API_KEY);

  let analysis, analyzerUsage;
  try {
    const r = await analyzeContent(client, cleaned, { model: opts.analyzerModel });
    analysis = r.analysis;
    analyzerUsage = r.usage;
  } catch (err) {
    console.error(red(`   ❌ Analyzer call failed: ${err.message}`));
    if (err.status === 401) console.error(red("   Your OPENAI_API_KEY appears invalid. Check tools/translate/.env"));
    process.exit(1);
  }

  console.log(dim(`   analyzer tokens: ${fmt(analyzerUsage.total_tokens)}`));

  const sections = sliceByMarkers(cleaned, analysis);

  // ────────────────────────────────────────────────────────────
  // Step 3. Show plan
  // ────────────────────────────────────────────────────────────
  const bookId = opts.bookId || analysis.book.book_id_suggestion;
  const bookTitle = analysis.book.english_title || "(unknown title)";
  const bookAuthor = analysis.book.author || "(unknown author)";

  console.log("\n" + bold("📚 Detected: ") + bold(cyan(bookTitle)) + dim(`  ${bookAuthor}`));
  if (analysis.book.book_synopsis) console.log(dim(`   ${analysis.book.book_synopsis}`));
  console.log(dim(`   Content type: ${analysis.book.looks_like}    Book id: ${bookId}`));
  console.log("\n   Sections found:");

  let chapterIndex = 0;
  for (const s of sections) {
    const status = s.markerFound ? "" : red("  [marker not found in input]");
    const skip = (opts.includeFrontMatter ? false : s.skip);
    const icon = skip ? "✗" : "✓";
    const colorFn = skip ? dim : (x) => x;
    if (!skip) chapterIndex++;
    const idLabel = !skip && s.kind === "chapter" ? cyan(` → ${bookId}/${s.id_suggestion}`) : "";
    console.log(`   ${colorFn(icon)} ${colorFn(s.kind.padEnd(20))} ${colorFn(s.english_title || "")}${idLabel}${status}`);
    if (s.synopsis && !skip) {
      console.log(dim(`     ${s.synopsis.replace(/\n/g, " ")}`));
    }
  }

  const toProcess = sections.filter((s) => (opts.includeFrontMatter ? true : !s.skip) && s.markerFound && s.text.length > 50);
  console.log(`\n   Will translate ${bold(toProcess.length)} section${toProcess.length === 1 ? "" : "s"}.`);

  if (toProcess.length === 0) {
    console.log(red("\n   Nothing to translate. Either everything is flagged as skippable front matter, or the analyzer couldn't find marker matches. Try --include-front-matter or inspect the input."));
    process.exit(opts.dryRun ? 0 : 1);
  }

  if (!opts.yes && !opts.dryRun) {
    const ok = await prompt("\n   Proceed? [Y/n]: ");
    if (ok && ok !== "y" && ok !== "yes") {
      console.log("   Aborted.");
      process.exit(0);
    }
  }

  // ────────────────────────────────────────────────────────────
  // Step 4. Split each section into clauses + estimate cost
  // ────────────────────────────────────────────────────────────
  console.log("\n" + bold("3.") + " Splitting each section into clauses…");
  let totalClauses = 0;
  for (const s of toProcess) {
    s._clauses = splitClauses(s.text, opts.length);
    const cs = clauseStats(s._clauses);
    totalClauses += cs.n;
    console.log(dim(`   ${s.english_title || s.kind}: ${cs.n} clauses (${cs.min}-${cs.max} words, mean ${cs.mean})`));
  }
  console.log(`   Total: ${bold(totalClauses)} clauses across ${toProcess.length} section${toProcess.length === 1 ? "" : "s"}`);

  // Cost estimate
  const inputChars = toProcess.reduce((a, s) => a + s.text.length + s._clauses.join("\n").length, 0) + 1500;
  const outputCharsExpected = toProcess.reduce((a, s) => a + s._clauses.reduce((b, c) => b + c.length * 1.1 + 4, 0), 0);
  const est = estimateCost({ inputChars, expectedOutputChars: outputCharsExpected }, opts.model);
  console.log(`\n   ${bold("Cost estimate")}: ~$${est.cost.toFixed(3)}  ${dim(`(${fmt(est.inputTokens)} in / ${fmt(est.outputTokens)} out tokens, ${opts.model})`)}`);

  if (opts.dryRun) {
    console.log(yellow("\nDry run complete. No translation calls made, no files written."));
    process.exit(0);
  }

  if (!opts.yes) {
    const ok = await prompt("   Proceed with translation API calls? [y/N]: ");
    if (ok !== "y" && ok !== "yes") {
      console.log("   Aborted.");
      process.exit(0);
    }
  }

  // ────────────────────────────────────────────────────────────
  // Step 5. Translate each section
  // ────────────────────────────────────────────────────────────
  console.log("\n" + bold("4.") + " Translating sections…");
  const bookDir = path.join(BOOKS_DIR, bookId);
  await fs.mkdir(bookDir, { recursive: true });

  // Translate the book title once (used for cover + library)
  const bookTitleResult = await translateTitle(client, bookTitle, { model: opts.model });

  const chapterEntries = [];
  let i = 0;
  for (const s of toProcess) {
    i++;
    console.log(`\n   [${i}/${toProcess.length}] ${cyan(s.english_title || s.kind)}…`);

    let titleResult, bodyResult;
    try {
      [titleResult, bodyResult] = await Promise.all([
        translateTitle(client, s.english_title || "Untitled", { model: opts.model }),
        translateClauses(client, s._clauses, {
          model: opts.model,
          fullText: s.text,
          englishTitle: s.english_title || "",
        }),
      ]);
    } catch (err) {
      console.error(red(`     ❌ Translation failed: ${err.message}`));
      console.error(red(`     Skipping this section. You can re-run the tool to retry.`));
      continue;
    }

    const v = validatePairs(s._clauses, bodyResult.pairs);
    if (!v.ok) {
      console.error(yellow(`     ⚠ Validation: ${v.problems.length} problem${v.problems.length === 1 ? "" : "s"}`));
      v.problems.slice(0, 3).forEach((p) => console.error(yellow(`       - ${p}`)));
    } else {
      console.log(green(`     ✓ ${bodyResult.pairs.length} pairs, validation clean`));
    }

    const chapterId = s.id_suggestion || `ch-${i}`;
    const chapterJson = {
      id: chapterId,
      book_id: bookId,
      language: "zh",
      version: 1,
      title: { target: titleResult.target, english: titleResult.english },
      pairs: bodyResult.pairs.map((p) => ({ target: p.target, english: p.english })),
      meta: {
        source: path.basename(opts.in),
        createdAt: new Date().toISOString().slice(0, 10),
        model: opts.model,
        synopsis: s.synopsis || null,
      },
    };

    const chapterPath = path.join(bookDir, `${chapterId}.json`);
    await fs.writeFile(chapterPath, JSON.stringify(chapterJson, null, 2) + "\n", "utf8");
    console.log(dim(`     written: ${path.relative(REPO_ROOT, chapterPath)}`));

    chapterEntries.push({
      id: chapterId,
      title: { target: titleResult.target, english: titleResult.english },
      url: `books/${bookId}/${chapterId}.json`,
    });
  }

  // ────────────────────────────────────────────────────────────
  // Step 6. Cover + library upsert
  // ────────────────────────────────────────────────────────────
  console.log("\n" + bold("5.") + " Writing book metadata…");

  let coverRel = null;
  if (opts.cover !== false) {
    const coverPath = path.join(bookDir, "cover.svg");
    const svg = renderCover({
      englishTitle: bookTitle,
      targetTitle: bookTitleResult.target,
    });
    await fs.writeFile(coverPath, svg, "utf8");
    coverRel = `books/${bookId}/cover.svg`;
    console.log(dim(`   written: ${path.relative(REPO_ROOT, coverPath)}`));
  }

  const library = await readLibrary(LIBRARY_PATH);
  const bookEntry = {
    id: bookId,
    language: "zh",
    title: { target: bookTitleResult.target, english: bookTitle },
    author: bookAuthor === "(unknown author)" ? "" : bookAuthor,
    synopsis: analysis.book.book_synopsis || "",
    chapters: chapterEntries,
  };
  if (coverRel) bookEntry.cover = coverRel;

  const upsertResult = upsertBook(library, bookEntry);
  await writeLibrary(LIBRARY_PATH, library);
  console.log(dim(`   library.json: ${upsertResult.action}, +${upsertResult.chaptersAdded} chapter(s), ~${upsertResult.chaptersUpdated} updated`));

  console.log("\n" + green(bold("✨ Done.")));
  console.log("\nReview, then publish:");
  console.log(dim(`   git add content/`));
  console.log(dim(`   git commit -m "Add ${bookId}"`));
  console.log(dim(`   git push`));
}

main().catch((err) => {
  console.error("\n" + red("❌ Failed:") + " " + err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
