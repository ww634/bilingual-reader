#!/usr/bin/env node
// Mechanical authoring only. No model/API calls. Run in tools/translate/.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { romanize, romanizeWithMap, chunkPinyinFromPair } from './lib/romanize.js';
import { applyFrequencyBands } from './lib/frequency.js';
import { readLibrary, upsertBook, writeLibrary } from './lib/library.js';
import { renderCover } from './lib/cover.js';
import { assertSentenceUnit } from './lib/sentences.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const categories = new Set(['noun', 'verb', 'adjective', 'adverb', 'idiom', 'proper_noun', 'function_word', 'measure_word', 'particle']);
const han = /\p{Script=Han}/u;
const meaningful = /[\p{L}\p{N}]/u;
const json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const serialized = value => JSON.stringify(value, null, 2) + '\n';
function requireThat(ok, message) { if (!ok) throw new Error(message); }
function nonempty(s, label) { requireThat(typeof s === 'string' && s.trim(), `${label} must be non-empty text`); }
function target(s, label) { nonempty(s, label); requireThat(!han.test(s), `${label} contains unromanized Han`); return s; }
function cleanKeys(object, allowed, label) {
  requireThat(object && typeof object === 'object' && !Array.isArray(object), `${label} must be an object`);
  for (const key of Object.keys(object)) requireThat(allowed.includes(key), `${label}: unexpected field ${key}; do not supply pinyin or frequency bands`);
}

export function finalizeDraft(draft) {
  cleanKeys(draft, ['title', 'pairs'], 'draft');
  cleanKeys(draft.title, ['english', 'hanzi'], 'title');
  nonempty(draft.title.english, 'title.english');
  nonempty(draft.title.hanzi, 'title.hanzi');
  requireThat(Array.isArray(draft.pairs) && draft.pairs.length, 'pairs must be a non-empty array');
  const pairs = draft.pairs.map((pair, i) => {
    const label = `pair ${i + 1}`;
    cleanKeys(pair, ['english', 'hanzi', 'alignment'], label);
    nonempty(pair.english, `${label}.english`);
    nonempty(pair.hanzi, `${label}.hanzi`);
    assertSentenceUnit(pair.hanzi, label);
    requireThat(Array.isArray(pair.alignment) && pair.alignment.length, `${label}: alignment required`);
    const map = romanizeWithMap(pair.hanzi);
    let cursor = 0;
    const alignment = pair.alignment.map((chunk, j) => {
      const where = `${label}, chunk ${j + 1}`;
      cleanKeys(chunk, ['english', 'hanzi', 'category', 'is_idiom'], where);
      nonempty(chunk.english, `${where}.english`);
      nonempty(chunk.hanzi, `${where}.hanzi`);
      requireThat(chunk.hanzi === chunk.hanzi.trim(), `${where}: trim chunk hanzi`);
      requireThat(categories.has(chunk.category), `${where}: invalid category`);
      requireThat(typeof chunk.is_idiom === 'boolean' && (chunk.category !== 'idiom' || chunk.is_idiom), `${where}: invalid is_idiom`);
      requireThat(pair.english.toLowerCase().includes(chunk.english.toLowerCase()), `${where}: English must be a span of its clause`);
      const start = pair.hanzi.indexOf(chunk.hanzi, cursor);
      requireThat(start >= 0, `${where}: Hanzi missing, overlapping, or out of order`);
      requireThat(!meaningful.test(pair.hanzi.slice(cursor, start)), `${where}: uncovered text before chunk`);
      // The reused helper selects the first occurrence. Slice the SOURCE and
      // its already-contextualized map together to locate repeated words at
      // their actual occurrence, without romanizing them in isolation.
      const cpStart = [...pair.hanzi.slice(0, start)].length;
      const suffixMap = { ...map, srcChars: map.srcChars.slice(cpStart), spans: map.spans.slice(cpStart) };
      const pinyin = chunkPinyinFromPair(pair.hanzi.slice(start), chunk.hanzi, suffixMap);
      cursor = start + chunk.hanzi.length;
      return { english: chunk.english, target: target(pinyin, `${where}.target`), hanzi: chunk.hanzi, category: chunk.category, is_idiom: chunk.is_idiom };
    });
    requireThat(!meaningful.test(pair.hanzi.slice(cursor)), `${label}: uncovered trailing text`);
    return { target: target(romanize(pair.hanzi), `${label}.target`), english: pair.english, hanzi: pair.hanzi, alignment };
  });
  applyFrequencyBands(pairs);
  return { title: { target: target(romanize(draft.title.hanzi), 'title.target'), english: draft.title.english, hanzi: draft.title.hanzi }, pairs };
}

export async function finalizeChapter({ bookId, chapter, draftPath, model = 'Codex (GPT-6)', root = ROOT }) {
  requireThat(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(bookId || ''), 'Invalid --book-id');
  requireThat(Number.isSafeInteger(chapter) && chapter > 0, '--chapter must be a positive integer');
  nonempty(model, 'model');
  const dir = path.join(root, 'content/books', bookId);
  const output = path.join(dir, `ch-${chapter}.json`);
  // One lock for the shared catalog, including checkpoint checks. Never
  // silently remove a stale lock: another writer may still be alive.
  const lockPath = path.join(root, 'content/.author-finalize.lock');
  const lock = await fs.open(lockPath, 'wx');
  const temporaryLibrary = path.join(root, 'content/.author-library.tmp.json');
  const temporaryChapter = path.join(dir, `.ch-${chapter}.author.tmp.json`);
  try {
    await lock.writeFile(serialized({ pid: process.pid, bookId, chapter }));
    const names = await fs.readdir(dir);
    requireThat(!names.includes(`ch-${chapter}.json`), `${output} already exists; never regenerate. Repair registration/checkpoint from the existing chapter if interrupted.`);
    const state = await json(path.join(dir, '_state.json'));
    requireThat(Number.isSafeInteger(state.chapters_written) && state.chapters_written >= 0 && chapter === state.chapters_written + 1, 'Chapter must be _state.chapters_written + 1');
    const existing = names.filter(n => /^ch-\d+\.json$/.test(n)).map(n => Number(n.slice(3, -5))).sort((a,b) => a-b);
    requireThat(existing.length === state.chapters_written && existing.every((n,i) => n === i+1), 'Chapter files and checkpoint disagree; recover state before writing');
    const series = await json(path.join(dir, '_series.json'));
    nonempty(series.title?.hanzi, 'series.title.hanzi');
    nonempty(series.title?.english, 'series.title.english');
    nonempty(series.synopsis, 'series.synopsis');
    requireThat(Array.isArray(series.genres) && series.genres.every(g => typeof g === 'string' && g.trim()), 'series.genres must be strings');
    const result = finalizeDraft(await json(draftPath));
    // Retained prose is optional for external drafts, mandatory in our skills.
    const prosePath = path.join(dir, '_drafts', `ch-${chapter}.prose.txt`);
    try {
      const prose = await fs.readFile(prosePath, 'utf8');
      requireThat(result.pairs.map(p => p.hanzi).join('') === prose, 'Encoded Hanzi does not reproduce retained prose exactly');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const title = { target: target(romanize(series.title.hanzi), 'series.title.target'), english: series.title.english, hanzi: series.title.hanzi };
    const chapterJSON = { id: `ch-${chapter}`, book_id: bookId, language: 'zh', version: 1, ...result, meta: { source: 'author-agent', createdAt: new Date().toISOString().slice(0,10), model, synopsis: null, has_alignment: true, alignment_complete: true } };
    const libraryPath = path.join(root, 'content/library.json');
    const library = await readLibrary(libraryPath);
    const prior = library.books.find(b => b.id === bookId);
    requireThat(!prior?.chapters?.some(c => c.id === chapterJSON.id), 'Catalog already contains this chapter; reconcile before finalizing');
    upsertBook(library, { id: bookId, language: 'zh', title, author: 'AI generated', synopsis: series.synopsis, genres: series.genres, cover: `books/${bookId}/cover.svg`, chapters: [{ id: chapterJSON.id, version: 1, title: result.title, url: `books/${bookId}/ch-${chapter}.json` }] });
    library.books.find(b => b.id === bookId).chapters.sort((a,b) => Number(a.id.slice(3)) - Number(b.id.slice(3)));
    // Prepare the catalog with the existing writer, then replace atomically.
    // A crash between chapter creation and catalog rename is recoverable:
    // keep the chapter, register it with library helpers, then update state.
    await writeLibrary(temporaryLibrary, library);
    try { await fs.writeFile(path.join(dir, 'cover.svg'), renderCover({ englishTitle: title.english, targetTitle: title.target }), { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await fs.writeFile(temporaryChapter, serialized(chapterJSON));
    // Publish a complete file atomically without replacing any existing file.
    await fs.link(temporaryChapter, output);
    await fs.rename(temporaryLibrary, libraryPath);
    return { output, pairs: result.pairs.length, chunks: result.pairs.reduce((n,p) => n+p.alignment.length, 0) };
  } finally {
    await fs.rm(temporaryChapter, { force: true });
    await fs.rm(temporaryLibrary, { force: true });
    await lock.close();
    await fs.unlink(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'book-id': { type: 'string' }, chapter: { type: 'string' }, draft: { type: 'string' }, model: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('From tools/translate/: node finalize-chapter.js --book-id <id> --chapter <N> --draft <path> [--model <label>]');
    else {
      requireThat(values.draft, '--draft is required');
      requireThat(/^[1-9]\d*$/.test(values.chapter || ''), '--chapter must be a positive integer');
      console.log(JSON.stringify(await finalizeChapter({ bookId: values['book-id'], chapter: Number(values.chapter), draftPath: path.resolve(values.draft), model: values.model })));
    }
  } catch (error) { console.error(`finalize-chapter: ${error.message}`); process.exitCode = 1; }
}
