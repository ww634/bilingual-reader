// Read, upsert, and write content/library.json — the catalog index.

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_LIBRARY = { version: 1, chapters: [] };

export async function readLibrary(libraryPath) {
  try {
    const raw = await fs.readFile(libraryPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.chapters) parsed.chapters = [];
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") return structuredClone(DEFAULT_LIBRARY);
    throw err;
  }
}

/**
 * Upsert an entry by id. If a chapter with the same id exists, replace it
 * and bump its version. Otherwise append.
 *
 * @param {object} library
 * @param {object} entry { id, language, version?, title, cover, url }
 */
export function upsert(library, entry) {
  const i = library.chapters.findIndex((c) => c.id === entry.id);
  if (i >= 0) {
    const existing = library.chapters[i];
    const merged = {
      ...existing,
      ...entry,
      version: (existing.version || 1) + 1,
    };
    library.chapters[i] = merged;
    return { action: "updated", version: merged.version };
  } else {
    library.chapters.push({ version: 1, ...entry });
    return { action: "added", version: entry.version || 1 };
  }
}

export async function writeLibrary(libraryPath, library) {
  await fs.mkdir(path.dirname(libraryPath), { recursive: true });
  await fs.writeFile(libraryPath, JSON.stringify(library, null, 2) + "\n", "utf8");
}
