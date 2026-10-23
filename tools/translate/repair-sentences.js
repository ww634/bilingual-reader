#!/usr/bin/env node
// Explicit, hash-guarded repair of reader segmentation, never story generation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { finalizeDraft } from './finalize-chapter.js';
import { readLibrary, upsertBook, writeLibrary } from './lib/library.js';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const stringify = value => JSON.stringify(value, null, 2) + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const readJSON = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const words = c => c.pairs.flatMap(p => p.alignment.map(w => [w.hanzi, w.category, w.is_idiom]));

export async function repairSentences({ plan, root = ROOT, apply = false }) {
  requireThat(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plan.book_id ?? ''), 'Invalid book_id');
  requireThat(Array.isArray(plan.chapters) && plan.chapters.length, 'Repair chapters required');
  const dir = path.join(root, 'content/books', plan.book_id);
  const libraryPath = path.join(root, 'content/library.json');
  const lockPath = path.join(root, 'content/.author-finalize.lock');
  const lock = await fs.open(lockPath, 'wx');
  const temporary = [];
  try {
    await lock.writeFile(stringify({ pid: process.pid, operation: 'sentence-repair', bookId: plan.book_id }));
    const library = await readLibrary(libraryPath);
    const book = library.books.find(b => b.id === plan.book_id);
    requireThat(book, 'Book missing from catalog');
    const seen = new Set(), prepared = [];
    for (const entry of plan.chapters) {
      const n = entry.chapter;
      requireThat(Number.isSafeInteger(n) && n > 0 && !seen.has(n), 'Invalid or repeated chapter');
      seen.add(n);
      const output = path.join(dir, `ch-${n}.json`);
      const bytes = await fs.readFile(output);
      requireThat(hash(bytes) === entry.source_sha256, `ch-${n}: source changed; review again before repair`);
      const old = JSON.parse(bytes);
      requireThat(old.id === `ch-${n}` && old.book_id === plan.book_id, 'Chapter identity mismatch');
      const result = finalizeDraft(entry.draft);
      requireThat(result.pairs.map(p => p.hanzi).join('') === old.pairs.map(p => p.hanzi).join(''), `ch-${n}: repair changed Chinese prose`);
      requireThat(JSON.stringify(words(result)) === JSON.stringify(words(old)), `ch-${n}: repair changed word order/categories`);
      requireThat(JSON.stringify(result.title) === JSON.stringify(old.title), `ch-${n}: repair changed title`);
      const catalog = book.chapters.find(c => c.id === old.id);
      requireThat(catalog && catalog.version === old.version, `ch-${n}: chapter/catalog version mismatch`);
      const repaired = { ...old, ...result, version: old.version + 1 };
      upsertBook(library, { ...book, chapters: [{ ...catalog, version: repaired.version }] });
      requireThat(book.chapters.find(c => c.id === old.id).version === repaired.version, 'Version did not advance');
      prepared.push({ n, output, bytes, repaired, source: entry.source_sha256 });
    }
    book.version = (book.version || 1) + 1;
    if (apply) {
      // All inputs validate before any content changes. Keep exact originals for
      // recovery; source hashes prevent accidental repeated repairs/version bumps.
      for (const item of prepared) {
        const backup = path.join(dir, '_drafts', 'sentence-repairs', `${item.n}-${item.source}.json`);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        try { await fs.writeFile(backup, item.bytes, { flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; requireThat((await fs.readFile(backup)).equals(item.bytes), 'Backup conflict'); }
        const tmp = path.join(dir, `.ch-${item.n}.sentence-repair.tmp.json`);
        await fs.writeFile(tmp, stringify(item.repaired), { flag: 'wx' });
        temporary.push(tmp);
      }
      const tmpLibrary = path.join(root, 'content/.sentence-repair-library.tmp.json');
      const handle = await fs.open(tmpLibrary, 'wx');
      await handle.close();
      temporary.push(tmpLibrary);
      await writeLibrary(tmpLibrary, library);
      for (let i = 0; i < prepared.length; i++) await fs.rename(temporary[i], prepared[i].output);
      await fs.rename(tmpLibrary, libraryPath);
    }
    return { applied: apply, chapters: prepared.map(x => ({ chapter: x.n, version: x.repaired.version, pairs: x.repaired.pairs.length })) };
  } finally {
    for (const tmp of temporary) await fs.rm(tmp, { force: true });
    await lock.close(); await fs.unlink(lockPath);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { plan: { type: 'string' }, apply: { type: 'boolean', default: false } } });
    requireThat(values.plan, 'Usage: node repair-sentences.js --plan <reviewed-plan.json> [--apply]');
    console.log(JSON.stringify(await repairSentences({ plan: await readJSON(values.plan), apply: values.apply })));
  } catch (error) { console.error(`repair-sentences: ${error.message}`); process.exitCode = 1; }
}
