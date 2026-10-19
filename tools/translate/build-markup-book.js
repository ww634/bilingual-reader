#!/usr/bin/env node
// Build reader chapter JSON from hand-authored "markup" chapters — for languages
// with a single written form (French, Spanish, …) where there's no hanzi/pinyin.
//
//   node tools/translate/build-markup-book.js content/books/<book-id>/_src
//
// The source folder holds:
//   book.json   { id, language, title:{target,english}, author, synopsis, genres }
//   ch-N.txt    one chapter each:
//                 # Titre | English title
//                 {Il|It|f|1} {pleuvait|was raining|v|2} {sur|on|f|1} … ||| It was raining on …
//
// Each {target|english|cat|band} tags one chunk. Cat: n v adj adv f(function word)
// pn(proper noun) id(idiom). Band: 1 very_common · 2 common · 3 uncommon ·
// 4 rare · - none. Untagged text (punctuation) stays as plain text.
//
// The pair's target is the markup with the tags stripped, so every chunk's
// target is guaranteed to be an exact, in-order substring of it — which the
// reader's highlighting relies on. We additionally verify each chunk's English
// is found in the pair's English and that every word got tagged.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLibrary, upsertBook, writeLibrary } from "./lib/library.js";
import { renderCover } from "./lib/cover.js";
import { frenchLookups } from "./lib/french-vocabulary.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.resolve(__dirname, "..", "..", "content");
const LIBRARY_PATH = path.join(CONTENT_DIR, "library.json");

const CATS = { n: "noun", v: "verb", adj: "adjective", adv: "adverb", f: "function_word", pn: "proper_noun", id: "idiom" };
const BANDS = { 1: "very_common", 2: "common", 3: "uncommon", 4: "rare", "-": null };
const TAG = /\{([^{}|]+)\|([^{}|]+)\|([a-z]+)\|([1-4-])\}/g;

const problems = [];
const warn = (where, msg) => problems.push(`${where}: ${msg}`);

function parsePair(line, where) {
  const [markup, english] = line.split("|||").map((s) => s.trim());
  if (!markup || !english) { warn(where, "missing ||| separator or empty side"); return null; }

  const chunks = [];
  let target = "";
  let last = 0;
  for (const m of markup.matchAll(TAG)) {
    target += markup.slice(last, m.index);          // plain text between tags
    const [, fr, en, cat, band] = m;
    if (!(cat in CATS)) warn(where, `unknown category "${cat}" in ${m[0]}`);
    if (!(band in BANDS)) warn(where, `unknown band "${band}" in ${m[0]}`);
    chunks.push({ english: en.trim(), target: fr.trim(), category: CATS[cat], frequency_band: BANDS[band] ?? null, is_idiom: cat === "id" });
    target += fr;
    last = m.index + m[0].length;
  }
  target += markup.slice(last);
  target = target.replace(/\s+/g, " ").trim();

  if (/[{}|]/.test(target)) warn(where, `stray markup left in "${target}"`);

  // Every chunk's target must be an in-order substring of the pair target.
  let cursor = 0;
  for (const c of chunks) {
    const i = target.indexOf(c.target, cursor);
    if (i === -1) warn(where, `chunk "${c.target}" not found in order in "${target}"`);
    else cursor = i + c.target.length;
  }
  // Every chunk's English should appear in the English (case-insensitive).
  const enLower = english.toLowerCase();
  for (const c of chunks) {
    if (!enLower.includes(c.english.toLowerCase())) warn(where, `english "${c.english}" not in "${english}"`);
  }
  // Every word of the target should be covered by a chunk.
  const covered = target.split("");
  let pos = 0;
  const mask = new Array(target.length).fill(false);
  for (const c of chunks) {
    const i = target.indexOf(c.target, pos);
    if (i === -1) continue;
    for (let k = i; k < i + c.target.length; k++) mask[k] = true;
    pos = i + c.target.length;
  }
  const uncovered = [];
  let word = "", wordCovered = true;
  for (let k = 0; k <= target.length; k++) {
    const ch = target[k];
    if (ch && /[\p{L}\p{N}'’-]/u.test(ch)) { word += ch; if (!mask[k]) wordCovered = false; }
    else { if (word && !wordCovered && /[\p{L}\p{N}]/u.test(word)) uncovered.push(word); word = ""; wordCovered = true; }
  }
  if (uncovered.length) warn(where, `untagged word(s) ${JSON.stringify(uncovered)}`);

  return { target, english, alignment: chunks };
}

async function main() {
  const srcDir = path.resolve(process.argv[2] || "");
  if (!process.argv[2]) { console.error("usage: build-markup-book.js <_src dir>"); process.exit(1); }
  const book = JSON.parse(await fs.readFile(path.join(srcDir, "book.json"), "utf8"));
  // Optional authored vocabulary keeps word lookups independent of the larger
  // spans needed for a natural sentence translation. Other books are unchanged.
  let vocabulary = null;
  if (book.language === "fr") {
    let words = null;
    try {
      words = JSON.parse(await fs.readFile(path.join(srcDir, "vocabulary", "words.json"), "utf8"));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (words) {
      const names = ["phrases", "verbs", "overrides"];
      const data = await Promise.all(names.map(name => fs.readFile(path.join(srcDir, "vocabulary", `${name}.json`), "utf8")));
      vocabulary = {words, ...Object.fromEntries(names.map((name, i) => [name, JSON.parse(data[i])]))};
    }
  }
  const bookDir = path.dirname(srcDir);
  const files = (await fs.readdir(srcDir)).filter((f) => /^ch-\d+\.txt$/.test(f))
    .sort((a, b) => parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10));

  const chapterEntries = [];
  for (const file of files) {
    const id = file.replace(/\.txt$/, "");
    const lines = (await fs.readFile(path.join(srcDir, file), "utf8")).split(/\r?\n/);
    let title = null;
    const pairs = [];
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith("//")) return;
      const where = `${file}:${i + 1}`;
      if (line.startsWith("#")) {
        const [t, e] = line.replace(/^#\s*/, "").split("|").map((s) => s.trim());
        title = { target: t, english: e };
        return;
      }
      const p = parsePair(line, where);
      if (p) {
        if (vocabulary) for (const chunk of p.alignment) chunk.lookup = frenchLookups(chunk, vocabulary);
        pairs.push(p);
      }
    });
    if (!title) { warn(file, "missing '# Titre | Title' line"); continue; }

    const chapter = {
      id, book_id: book.id, language: book.language, version: 1,
      title,
      pairs,
      meta: {
        source: "markup-authored",
        createdAt: new Date().toISOString().slice(0, 10),
        ...(book.model ? { model: book.model } : {}),
        synopsis: null,
        has_alignment: true,
        alignment_complete: true,
      },
    };
    await fs.writeFile(path.join(bookDir, `${id}.json`), JSON.stringify(chapter, null, 2) + "\n", "utf8");
    chapterEntries.push({ id, title, url: `books/${book.id}/${id}.json` });
    const chunkCount = pairs.reduce((n, p) => n + p.alignment.length, 0);
    console.log(`  ${id}: ${pairs.length} pairs, ${chunkCount} chunks — "${title.english}"`);
  }

  if (problems.length) {
    console.error(`\n✗ ${problems.length} problem(s):`);
    problems.forEach((p) => console.error("  - " + p));
    process.exit(2);
  }

  // Cover + library entry.
  const coverPath = path.join(bookDir, "cover.svg");
  await fs.writeFile(coverPath, renderCover({ englishTitle: book.title.english, targetTitle: book.title.target }), "utf8");
  const library = await readLibrary(LIBRARY_PATH);
  const r = upsertBook(library, {
    id: book.id, language: book.language,
    title: book.title, author: book.author, synopsis: book.synopsis, genres: book.genres,
    cover: `books/${book.id}/cover.svg`,
    chapters: chapterEntries,
  });
  await writeLibrary(LIBRARY_PATH, library);
  console.log(`\n✓ ${book.title.english}: library ${r.action}, ${chapterEntries.length} chapter(s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
