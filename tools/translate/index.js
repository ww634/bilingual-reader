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
  tokenCost,
} from "./lib/translate.js";
import { analyzeContent, sliceByMarkers } from "./lib/analyze.js";
import { alignAll, estimateAlignmentCost } from "./lib/align.js";
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
  .option("--in <file>", "Input file (.docx, .txt, or .md). Required unless --realign-only is used.")
  .option("--book-id <id>", "Override the auto-detected book id (kebab-case)")
  .option("--include-front-matter", "Translate sections the analyzer flagged as skip (title pages, dedications, etc)")
  .option("--length <preset>", "Clause length: short | medium | long", "medium")
  .option("--model <name>", "OpenAI model for translation + alignment", "gpt-4.1")
  .option("--analyzer-model <name>", "OpenAI model for the pre-pass analysis (defaults to the same model as --model for reliability; pass gpt-5.4-nano to save a few cents on small runs)", undefined)
  .option("--dry-run", "Analyze + show plan, but no translation API calls and no writes")
  .option("--yes", "Skip all confirmation prompts")
  .option("--no-cover", "Skip generating an auto cover")
  .option("--no-alignment", "Skip the word-level alignment pass. Cheaper but disables tap-to-learn / color-coding in the reader.")
  .option("--align-retries <n>", "Max solo-retry attempts per pair that fails hard alignment validation. Default 0 (fastest/cheapest — pinyin still colors ~100%, a few english highlights are skipped). Set 1+ to polish english-highlight coverage on a single chapter at higher token cost.", (v) => parseInt(v, 10))
  .option("--force", "Re-translate chapters that already exist on disk. Default: skip already-done chapters (resumable).")
  .option("--realign-only <chapterFile>", "Re-run JUST the alignment pass on an existing chapter.json. Skips translation entirely. Useful after improving the alignment prompt.")
  // Strict is on by default — silently saving a chapter with half its text
  // missing is a real data-integrity bug. Pass --no-strict to opt out (e.g.
  // for fast iteration on a small test sample where you'd rather see what
  // got through than fail on a single warning).
  .option("--no-strict", "Don't abort on translator validation failure — warn and continue. Default is to abort.")
  .parse(process.argv);

const opts = program.opts();

// Default the analyzer to the main model — gpt-5.4-nano was unreliable for
// structural decisions like "is this one chapter or two?" Costs a few extra
// cents per run vs nano; that's nothing compared to the cost of mis-detecting
// chapters and re-running.
if (!opts.analyzerModel) opts.analyzerModel = opts.model;

async function realignOnly(chapterFile) {
  console.log(`\n${bold("🔁 Realign-only: " + chapterFile)}`);
  const absPath = path.resolve(chapterFile);
  const raw = await fs.readFile(absPath, "utf8");
  const chapter = JSON.parse(raw);
  if (!Array.isArray(chapter.pairs) || chapter.pairs.length === 0) {
    throw new Error("Chapter file has no pairs to align.");
  }
  const client = buildClient(process.env.OPENAI_API_KEY);
  // Strip any existing alignment so we get a clean re-run.
  const inputPairs = chapter.pairs.map((p) => ({ english: p.english, target: p.target, hanzi: p.hanzi }));
  if (inputPairs.some((p) => !p.hanzi)) {
    console.error(red("\n❌ This chapter has no `hanzi` field — it predates the Hanzi-alignment refactor."));
    console.error(red("   Re-translate it (drop the file and run --in ...) rather than realigning."));
    process.exit(1);
  }
  const est = estimateAlignmentCost(inputPairs, opts.model);
  console.log(`   ${inputPairs.length} pairs · cost estimate: ~$${est.cost.toFixed(3)}  ${dim("(" + fmt(est.inputTokens) + " in / " + fmt(est.outputTokens) + " out)")}`);
  if (!opts.yes) {
    const ok = await prompt("   Proceed? [y/N]: ");
    if (ok !== "y" && ok !== "yes") { console.log("   Aborted."); process.exit(0); }
  }

  const result = await alignAll(client, inputPairs, {
    model: opts.model,
    englishTitle: chapter.title?.english || "",
    maxRetries: opts.alignRetries,
    onProgress: (b, total) => { if (total > 1) process.stdout.write(dim(`   batch ${b}/${total}\r`)); },
    onRetry: (n) => process.stdout.write(dim(`   retrying ${n} pair${n === 1 ? "" : "s"} solo…\n`)),
  });
  console.log("");
  if (result.retryStats && result.retryStats.candidates > 0) {
    console.log(dim(`   retry pass: ${result.retryStats.fixes}/${result.retryStats.candidates} pairs fixed (${result.retryStats.calls} extra call${result.retryStats.calls === 1 ? "" : "s"})`));
  }
  if (result.softProblemCount > 0) {
    console.log(dim(`   ${result.softProblemCount} benign warning${result.softProblemCount === 1 ? "" : "s"} (grammatical-word glosses / punctuation) — not retried, render fine`));
  }
  if (result.problems.length > 0) {
    console.error(yellow(`   ⚠ ${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}:`));
    result.problems.slice(0, 8).forEach((p) => console.error(yellow(`     - ${p}`)));
    if (result.problems.length > 8) console.error(yellow(`     ... and ${result.problems.length - 8} more`));
  }
  const aligned = result.aligned.filter((p) => p.alignment).length;
  const chunkCount = result.aligned.reduce((a, p) => a + (p.alignment?.length || 0), 0);
  const meanChunks = aligned > 0 ? (chunkCount / aligned).toFixed(1) : "0";
  console.log(green(`   ✓ aligned ${aligned}/${result.aligned.length} pairs · ${chunkCount} chunks (${meanChunks}/pair) · ${fmt(result.totalTokens)} tokens`));

  // Safety: if NOTHING got aligned, refuse to overwrite — the existing
  // alignment (even if coarse) is more useful than no alignment.
  if (aligned === 0) {
    console.error(red("\n❌ Zero pairs were successfully aligned. Refusing to overwrite the chapter file."));
    console.error(red("   The original chapter.json is unchanged."));
    process.exit(1);
  }

  // Merge back into chapter.json.
  chapter.pairs = result.aligned.map((p) => {
    const out = { target: p.target, english: p.english, hanzi: p.hanzi };
    if (Array.isArray(p.alignment)) out.alignment = p.alignment;
    return out;
  });
  chapter.version = (chapter.version || 1) + 1;
  if (!chapter.meta) chapter.meta = {};
  chapter.meta.has_alignment = true;
  chapter.meta.realignedAt = new Date().toISOString().slice(0, 10);

  await fs.writeFile(absPath, JSON.stringify(chapter, null, 2) + "\n", "utf8");
  console.log(green(bold("\n✨ Wrote ") + path.relative(REPO_ROOT, absPath)));
  console.log("\nReview, then publish:");
  console.log(dim("   git add " + path.relative(REPO_ROOT, absPath)));
  console.log(dim('   git commit -m "Realign ' + path.basename(absPath, ".json") + '"'));
  console.log(dim("   git push"));
  console.log(dim("\nThe chapter version was bumped — the PWA will show an 'Update available' badge so you can re-download."));
}

async function main() {
  if (opts.realignOnly) {
    await realignOnly(opts.realignOnly);
    return;
  }
  if (!opts.in) {
    console.error(red("\n❌ --in <file> is required (unless using --realign-only)\n"));
    process.exit(1);
  }
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

  // Track real token usage across every API call so we can show the user
  // what the run actually cost (vs the upfront estimate). We split by which
  // model was used so the rate lookup is correct — analyzer typically runs
  // on a cheaper model than translation/alignment.
  const usage = {
    analyzer: { in: 0, out: 0, model: opts.analyzerModel },
    main:     { in: 0, out: 0, model: opts.model },
  };
  function addUsage(u, bucket = "main") {
    if (!u) return;
    usage[bucket].in  += u.prompt_tokens || 0;
    usage[bucket].out += u.completion_tokens || 0;
  }

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
  addUsage(analyzerUsage, "analyzer");

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
  const transEst = estimateCost({ inputChars, expectedOutputChars: outputCharsExpected }, opts.model);
  let alignEst = { cost: 0, inputTokens: 0, outputTokens: 0 };
  if (opts.alignment !== false) {
    // We don't have target text yet (translation hasn't run), so estimate
    // alignment based on the English clauses doubled (rough proxy for english+pinyin).
    const fakePairs = toProcess.flatMap((s) => s._clauses.map((c) => ({ english: c, target: c })));
    alignEst = estimateAlignmentCost(fakePairs, opts.model);
  }
  const totalCost = transEst.cost + alignEst.cost;
  console.log(`\n   ${bold("Cost estimate")}: ~$${totalCost.toFixed(3)}  ${dim(`(translation ~$${transEst.cost.toFixed(3)}, alignment ~$${alignEst.cost.toFixed(3)}, ${opts.model})`)}`);

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

  // Translate the book title once (used for cover + library + as a canonical
  // name passed into every chapter's body translation for consistency).
  // isBookTitle prevents the model from adding a "Dì N zhāng:" chapter prefix.
  const bookTitleResult = await translateTitle(client, bookTitle, { model: opts.model, isBookTitle: true });
  const canonicalNames = bookTitle && bookTitleResult.target
    ? [{ english: bookTitle, target: bookTitleResult.target }]
    : [];

  const chapterEntries = [];
  let i = 0;
  let skippedCount = 0;
  for (const s of toProcess) {
    i++;
    console.log(`\n   [${i}/${toProcess.length}] ${cyan(s.english_title || s.kind)}…`);

    // Resumability: if this chapter's JSON already exists on disk, skip it
    // unless --force was passed. Lets a long multi-chapter run be re-invoked
    // after a partial failure without redoing work.
    const provisionalChapterId = s.id_suggestion || `ch-${i}`;
    const existingPath = path.join(bookDir, `${provisionalChapterId}.json`);
    if (!opts.force) {
      try {
        const raw = await fs.readFile(existingPath, "utf8");
        const existing = JSON.parse(raw);
        if (existing && Array.isArray(existing.pairs) && existing.pairs.length > 0) {
          console.log(dim(`     ⟳ skipping — ${path.basename(existingPath)} already exists (--force to retranslate)`));
          chapterEntries.push({
            id: existing.id || provisionalChapterId,
            title: existing.title || { target: "", english: s.english_title || "" },
            url: `books/${bookId}/${provisionalChapterId}.json`,
          });
          skippedCount++;
          continue;
        }
      } catch (err) {
        // File doesn't exist or isn't valid JSON — fall through and translate.
      }
    }

    // Truncation handler — if the translator hits its output-token cap, give
    // the user one chance to bump up to gpt-4.1's ceiling (32k). With --yes
    // (unattended runs) we auto-bump once; without it we prompt. If the
    // ceiling itself is too small, the chapter genuinely needs splitting and
    // we let the inner Error propagate.
    const onTruncation = async ({ attempt, currentBudget, ceiling }) => {
      if (currentBudget >= ceiling) return null;
      const next = ceiling;
      console.warn(yellow(`\n     ⚠ Translator output truncated at ${currentBudget} tokens (attempt ${attempt}).`));
      if (opts.yes) {
        console.warn(yellow(`     Auto-bumping to ${next} (model ceiling) and retrying…`));
        return next;
      }
      const ans = await prompt(`     Retry with max ${next} tokens? [Y/n]: `);
      if (ans === "" || ans === "y" || ans === "yes") return next;
      console.warn(yellow(`     Aborting this section.`));
      return null;
    };

    let titleResult, bodyResult;
    try {
      [titleResult, bodyResult] = await Promise.all([
        translateTitle(client, s.english_title || "Untitled", { model: opts.model }),
        translateClauses(client, s._clauses, {
          model: opts.model,
          fullText: s.text,
          englishTitle: s.english_title || "",
          canonicalNames,
          onTruncation,
          onBatch: (i, total, size) => {
            if (total > 1) {
              process.stdout.write(dim(`     translating batch ${i}/${total} (${size} clauses)…\n`));
            }
          },
          onCoverageRetry: (attempt, max, fault) => {
            process.stdout.write(yellow(`       ⟳ batch fault (${fault}) — retrying (${attempt}/${max - 1})…\n`));
          },
        }),
      ]);
    } catch (err) {
      console.error(red(`     ❌ Translation failed: ${err.message}`));
      console.error(red(`     Skipping this section. You can re-run the tool to retry.`));
      continue;
    }
    addUsage(bodyResult.usage);
    addUsage(titleResult.usage);

    const v = validatePairs(s._clauses, bodyResult.pairs);
    if (!v.ok) {
      console.error(yellow(`     ⚠ Validation: ${v.problems.length} problem${v.problems.length === 1 ? "" : "s"}`));
      v.problems.slice(0, 3).forEach((p) => console.error(yellow(`       - ${p}`)));
      if (opts.strict) {
        console.error(red(`\n❌ Aborting: translator validation failed (see problem(s) above).`));
        console.error(red(`   The output didn't pass the integrity checks (coverage / pinyin-only / merge ratio).`));
        console.error(red(`   Re-run with --no-strict to save the partial output anyway,`));
        console.error(red(`   or split the chapter into smaller sections and retry.`));
        process.exit(2);
      }
    } else {
      console.log(green(`     ✓ ${bodyResult.pairs.length} pairs, validation clean`));
    }

    // Alignment pass (optional, on by default).
    let finalPairs = bodyResult.pairs.map((p) => ({ english: p.english, target: p.target, hanzi: p.hanzi }));
    if (opts.alignment !== false) {
      console.log(dim(`     aligning words…`));
      try {
        const alignResult = await alignAll(client, finalPairs, {
          model: opts.model,
          englishTitle: s.english_title || "",
          maxRetries: opts.alignRetries,
          onProgress: (b, total) => {
            if (total > 1) process.stdout.write(dim(`       batch ${b}/${total}\r`));
          },
          onRetry: (n) => process.stdout.write(dim(`       retrying ${n} pair${n === 1 ? "" : "s"} solo…\n`)),
        });
        if (alignResult.retryStats && alignResult.retryStats.candidates > 0) {
          console.log(dim(`       retry pass: ${alignResult.retryStats.fixes}/${alignResult.retryStats.candidates} pairs fixed (${alignResult.retryStats.calls} extra call${alignResult.retryStats.calls === 1 ? "" : "s"})`));
        }
        if (alignResult.softProblemCount > 0) {
          console.log(dim(`       ${alignResult.softProblemCount} benign warning${alignResult.softProblemCount === 1 ? "" : "s"} (grammatical-word glosses / punctuation) — render fine`));
        }
        if (alignResult.problems.length > 0) {
          console.error(yellow(`     ⚠ Alignment had ${alignResult.problems.length} hard problem${alignResult.problems.length === 1 ? "" : "s"} after retries`));
          alignResult.problems.slice(0, 3).forEach((p) => console.error(yellow(`       - ${p}`)));
        }
        const chunkCount = alignResult.aligned.reduce((a, p) => a + (p.alignment?.length || 0), 0);
        console.log(green(`     ✓ aligned ${alignResult.aligned.filter((p) => p.alignment).length}/${alignResult.aligned.length} pairs, ${chunkCount} chunks (${fmt(alignResult.totalTokens)} tokens)`));
        addUsage({ prompt_tokens: alignResult.inputTokens, completion_tokens: alignResult.outputTokens }, "main");
        finalPairs = alignResult.aligned;
      } catch (err) {
        console.error(yellow(`     ⚠ Alignment failed: ${err.message}. Continuing without alignment.`));
      }
    }

    const chapterId = s.id_suggestion || `ch-${i}`;
    const alignedPairCount = finalPairs.filter((p) => Array.isArray(p.alignment) && p.alignment.length > 0).length;
    const chapterJson = {
      id: chapterId,
      book_id: bookId,
      language: "zh",
      version: 1,
      title: { target: titleResult.target, english: titleResult.english, hanzi: titleResult.hanzi },
      pairs: finalPairs.map((p) => {
        const pair = { target: p.target, english: p.english, hanzi: p.hanzi };
        if (Array.isArray(p.alignment)) pair.alignment = p.alignment;
        return pair;
      }),
      meta: {
        source: path.basename(opts.in),
        createdAt: new Date().toISOString().slice(0, 10),
        model: opts.model,
        synopsis: s.synopsis || null,
        // Only true if alignment was requested AND at least one pair was successfully aligned.
        has_alignment: opts.alignment !== false && alignedPairCount > 0,
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
    genres: Array.isArray(analysis.book.genres) ? analysis.book.genres : [],
    chapters: chapterEntries,
  };
  if (coverRel) bookEntry.cover = coverRel;

  const upsertResult = upsertBook(library, bookEntry);
  await writeLibrary(LIBRARY_PATH, library);
  console.log(dim(`   library.json: ${upsertResult.action}, +${upsertResult.chaptersAdded} chapter(s), ~${upsertResult.chaptersUpdated} updated`));

  // Actual cost — computed from the real prompt_tokens / completion_tokens
  // the API charged us, not the upfront character-based estimate.
  const mainCost = tokenCost(usage.main.in, usage.main.out, usage.main.model);
  const analyzerCost = tokenCost(usage.analyzer.in, usage.analyzer.out, usage.analyzer.model);
  const actualCost = mainCost + analyzerCost;
  const mainTokens = usage.main.in + usage.main.out;
  const analyzerTokens = usage.analyzer.in + usage.analyzer.out;
  console.log("\n" + bold("Actual cost: ") + `$${actualCost.toFixed(3)}` + dim(
    `  (translation+alignment ~$${mainCost.toFixed(3)} on ${usage.main.model}, ${fmt(mainTokens)} tokens; ` +
    `analyzer ~$${analyzerCost.toFixed(3)} on ${usage.analyzer.model}, ${fmt(analyzerTokens)} tokens)` +
    (skippedCount > 0 ? "  — only counts API calls actually made this run" : "")
  ));

  console.log("\n" + green(bold("✨ Done.")));
  if (skippedCount > 0) {
    console.log(dim(`   ${skippedCount} chapter${skippedCount === 1 ? "" : "s"} skipped (already existed). Use --force to retranslate.`));
  }
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
