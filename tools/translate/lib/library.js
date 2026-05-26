// Read, upsert, and write content/library.json (v2 schema).

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_LIBRARY = { version: 2, books: [] };

export async function readLibrary(libraryPath) {
  try {
    const raw = await fs.readFile(libraryPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.books) parsed.books = [];
    if (!parsed.version) parsed.version = 2;
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") return structuredClone(DEFAULT_LIBRARY);
    throw err;
  }
}

/**
 * Upsert a whole book entry. If a book with the same id exists, merge its
 * chapter list (upserting each chapter by id), bumping versions where content
 * actually changed.
 *
 * @param {object} library v2 library object
 * @param {object} bookEntry full book entry to upsert: { id, language, title, author, synopsis, cover, chapters: [...] }
 * @returns {{ action: "added" | "updated", chaptersAdded: number, chaptersUpdated: number }}
 */
export function upsertBook(library, bookEntry) {
  const existing = library.books.find((b) => b.id === bookEntry.id);

  if (!existing) {
    library.books.push({ version: 1, ...bookEntry });
    return {
      action: "added",
      chaptersAdded: bookEntry.chapters.length,
      chaptersUpdated: 0,
    };
  }

  // Merge book-level metadata; bump book version if anything material changed.
  const materialChanged =
    existing.title?.english !== bookEntry.title?.english ||
    existing.title?.target !== bookEntry.title?.target ||
    existing.synopsis !== bookEntry.synopsis ||
    existing.author !== bookEntry.author ||
    existing.cover !== bookEntry.cover;

  if (materialChanged) existing.version = (existing.version || 1) + 1;
  if (bookEntry.title) existing.title = bookEntry.title;
  if (bookEntry.author !== undefined) existing.author = bookEntry.author;
  if (bookEntry.synopsis !== undefined) existing.synopsis = bookEntry.synopsis;
  if (bookEntry.cover) existing.cover = bookEntry.cover;
  if (bookEntry.language) existing.language = bookEntry.language;
  if (Array.isArray(bookEntry.genres)) existing.genres = bookEntry.genres;

  // Merge chapters
  let chaptersAdded = 0, chaptersUpdated = 0;
  for (const newCh of bookEntry.chapters) {
    const existingCh = existing.chapters.find((c) => c.id === newCh.id);
    if (!existingCh) {
      existing.chapters.push({ version: 1, ...newCh });
      chaptersAdded++;
    } else {
      existingCh.version = (existingCh.version || 1) + 1;
      existingCh.title = newCh.title || existingCh.title;
      existingCh.url = newCh.url || existingCh.url;
      chaptersUpdated++;
    }
  }

  return { action: "updated", chaptersAdded, chaptersUpdated };
}

export async function writeLibrary(libraryPath, library) {
  await fs.mkdir(path.dirname(libraryPath), { recursive: true });
  await fs.writeFile(libraryPath, JSON.stringify(library, null, 2) + "\n", "utf8");
}
