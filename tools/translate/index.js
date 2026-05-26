#!/usr/bin/env node
// Bilingual Reader translation CLI.
// Usage: node tools/translate --in chapter.docx --id ch-2002 --title "Chapter 2002: Title"

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
import { renderCover } from "./lib/cover.js";
import { readLibrary, upsert, writeLibrary } from "./lib/library.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Auto-load a tool-scoped .env so OPENAI_API_KEY doesn't have to live in
// your shell. The file lives in tools/translate/.env and is gitignored.
// A shell-exported OPENAI_API_KEY still wins if both are set.
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch (err) {
  // No .env file is fine — we fall back to process.env from the shell.
  if (err.code !== "ENOENT") {
    console.warn(`Warning: could not load .env: ${err.message}`);
  }
}
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CONTENT_DIR = path.join(REPO_ROOT, "content");
const CHAPTERS_DIR = path.join(CONTENT_DIR, "chapters");
const COVERS_DIR = path.join(CONTENT_DIR, "covers");
const LIBRARY_PATH = path.join(CONTENT_DIR, "library.json");

function fmt(n) { return n.toLocaleString("en-US"); }

async function prompt(question) {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim().toLowerCase();
}

const program = new Command();
program
  .name("translate")
  .description("Convert an English .docx/.txt chapter into a bilingual chapter.json + cover + library entry.")
  .requiredOption("--in <file>", "Input file (.docx, .txt, or .md)")
  .requiredOption("--id <id>", "Chapter id, kebab-case (e.g. ch-2002)")
  .requiredOption("--title <title>", "English chapter title")
  .option("--length <preset>", "Clause length: short | medium | long", "medium")
  .option("--model <name>", "OpenAI model", "gpt-4o")
  .option("--dry-run", "Run preprocessing + clause split, print stats, then stop. No API calls, no writes.")
  .option("--yes", "Skip all confirmation prompts")
  .option("--no-cover", "Skip generating an auto cover")
  .parse(process.argv);

const opts = program.opts();

async function main() {
  console.log(`\n📖 Translating ${opts.in} -> ${opts.id}`);
  console.log(`   Title: ${opts.title}`);
  console.log(`   Model: ${opts.model}    Clause length: ${opts.length}\n`);

  // 1. Read + clean
  console.log("1/5  Reading and cleaning input…");
  const { cleaned, stats } = await readAndClean(opts.in);
  console.log(`     Cleaned text: ${fmt(cleaned.length)} chars`);
  if (stats.pageNumbers || stats.repeatedHeaders || stats.blankRuns) {
    console.log(`     Removed: ${stats.pageNumbers} page numbers, ${stats.repeatedHeaders} repeated headers, ${stats.blankRuns} extra blank lines`);
  }
  console.log("");
  console.log("     ┌─ Preview (first 400 chars) ─────────────────────");
  console.log(cleaned.slice(0, 400).split("\n").map((l) => "     │ " + l).join("\n"));
  console.log("     └─");
  console.log("");

  if (!opts.yes) {
    const ok = await prompt("     Cleaned text look right? [y/N]: ");
    if (ok !== "y" && ok !== "yes") {
      console.log("     Aborted.");
      process.exit(0);
    }
  }

  // 2. Split into clauses
  console.log("\n2/5  Splitting into clauses…");
  const clauses = splitClauses(cleaned, opts.length);
  const cstats = clauseStats(clauses);
  console.log(`     ${cstats.n} clauses · words per clause: min ${cstats.min}, max ${cstats.max}, mean ${cstats.mean}`);

  if (opts.dryRun) {
    console.log("\n--- DRY RUN: first 12 clauses ---");
    clauses.slice(0, 12).forEach((c, i) => console.log(`[${(i + 1).toString().padStart(3)}] ${c}`));
    console.log(`\n(${clauses.length - 12} more not shown)`);
    console.log("\nDry run complete. No API calls made, no files written.");
    process.exit(0);
  }

  // 3. Cost estimate + confirm
  const inputChars = cleaned.length + clauses.join("\n").length + 800; // + system prompt overhead
  const expectedOutputChars = clauses.reduce((a, c) => a + c.length * 1.1 + 4, 0);
  const est = estimateCost({ inputChars, expectedOutputChars }, opts.model);
  console.log(`\n     Cost estimate: ~$${est.cost.toFixed(3)}  (${fmt(est.inputTokens)} in / ${fmt(est.outputTokens)} out tokens, ${opts.model})`);
  if (!opts.yes) {
    const ok = await prompt("     Proceed with API call? [y/N]: ");
    if (ok !== "y" && ok !== "yes") {
      console.log("     Aborted.");
      process.exit(0);
    }
  }

  // 4. Call OpenAI
  console.log("\n3/5  Calling OpenAI (this can take 30-90s for a long chapter)…");
  const client = buildClient(process.env.OPENAI_API_KEY);

  const [titleResult, bodyResult] = await Promise.all([
    translateTitle(client, opts.title, { model: opts.model }),
    translateClauses(client, clauses, {
      model: opts.model,
      fullText: cleaned,
      englishTitle: opts.title,
    }),
  ]);

  console.log(`     Returned ${bodyResult.pairs.length} pairs. Tokens used: ${fmt(bodyResult.usage.total_tokens)}`);

  // 5. Validate
  console.log("\n4/5  Validating output…");
  const v = validatePairs(clauses, bodyResult.pairs);
  if (!v.ok) {
    console.error("     ⚠️  Validation problems:");
    v.problems.slice(0, 10).forEach((p) => console.error(`       - ${p}`));
    if (v.problems.length > 10) console.error(`       ... and ${v.problems.length - 10} more`);
    if (!opts.yes) {
      const ok = await prompt("     Write outputs anyway? [y/N]: ");
      if (ok !== "y" && ok !== "yes") {
        console.log("     Aborted.");
        process.exit(1);
      }
    }
  } else {
    console.log("     All checks pass: count matches, tone marks present, no Han characters.");
  }

  // 6. Build chapter.json
  console.log("\n5/5  Writing outputs…");
  const chapterJson = {
    id: opts.id,
    language: "zh",
    version: 1,
    title: { target: titleResult.target, english: titleResult.english },
    pairs: bodyResult.pairs.map((p) => ({ target: p.target, english: p.english })),
    meta: {
      source: path.basename(opts.in),
      createdAt: new Date().toISOString().slice(0, 10),
      model: opts.model,
    },
  };

  await fs.mkdir(CHAPTERS_DIR, { recursive: true });
  const chapterPath = path.join(CHAPTERS_DIR, `${opts.id}.json`);
  await fs.writeFile(chapterPath, JSON.stringify(chapterJson, null, 2) + "\n", "utf8");
  console.log(`     ✓ ${path.relative(REPO_ROOT, chapterPath)}`);

  // 7. Cover
  let coverRelPath = null;
  if (opts.cover !== false) {
    await fs.mkdir(COVERS_DIR, { recursive: true });
    const coverPath = path.join(COVERS_DIR, `${opts.id}.svg`);
    const svg = renderCover({ englishTitle: opts.title, targetTitle: titleResult.target });
    await fs.writeFile(coverPath, svg, "utf8");
    coverRelPath = `covers/${opts.id}.svg`;
    console.log(`     ✓ ${path.relative(REPO_ROOT, coverPath)}`);
  }

  // 8. library.json upsert
  const library = await readLibrary(LIBRARY_PATH);
  const entry = {
    id: opts.id,
    language: "zh",
    title: { target: titleResult.target, english: titleResult.english },
    url: `chapters/${opts.id}.json`,
  };
  if (coverRelPath) entry.cover = coverRelPath;
  const upsertResult = upsert(library, entry);
  // Sync the chapter.json version to match the library entry's version
  chapterJson.version = upsertResult.version;
  await fs.writeFile(chapterPath, JSON.stringify(chapterJson, null, 2) + "\n", "utf8");
  await writeLibrary(LIBRARY_PATH, library);
  console.log(`     ✓ content/library.json (${upsertResult.action}, version ${upsertResult.version})`);

  console.log("\n✨ Done.");
  console.log("\nNext steps:");
  console.log(`   git add content/`);
  console.log(`   git commit -m "Add ${opts.id}"`);
  console.log(`   git push`);
  console.log("\nThen open the app: Browse → ${opts.id} → Add. (Or use 'Update' if it was already in your library.)");
}

main().catch((err) => {
  console.error("\n❌ Failed:", err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
