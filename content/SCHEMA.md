# Content schema (v2)

The reader PWA fetches a `library.json` index, then per-chapter JSON files. v2 introduces **books** as containers around chapters.

## File layout

```
content/
├── library.json                   ← the index (single file the PWA fetches first)
└── books/
    └── <book-id>/                 ← one directory per book, kebab-case id
        ├── cover.svg              ← book cover (auto-generated or hand-replaced)
        ├── ch-1.json              ← per-chapter content
        ├── ch-2.json
        └── ...
```

## `library.json`

```json
{
  "version": 2,
  "books": [
    {
      "id": "treasure-island",
      "language": "zh",
      "version": 1,
      "title": {
        "target": "Jīnyín Dǎo",
        "english": "Treasure Island"
      },
      "author": "Robert Louis Stevenson",
      "synopsis": "A boy's coming-of-age adventure aboard a ship hunting buried gold. Narrated by young Jim Hawkins, who finds a treasure map among a dead pirate's belongings.",
      "cover": "books/treasure-island/cover.svg",
      "chapters": [
        {
          "id": "ch-1",
          "version": 1,
          "title": {
            "target": "Dì yī zhāng: Lǎo hǎi dǎo zài hǎi jūn jiàng zhāo dài suǒ",
            "english": "Chapter 1: The Old Sea-Dog at the Admiral Benbow"
          },
          "url": "books/treasure-island/ch-1.json"
        }
      ]
    }
  ]
}
```

### Field reference

**Book:**
- `id` — kebab-case, globally unique. Used as the directory name and as the IndexedDB key prefix.
- `language` — `"zh"` for Mandarin, `"es"` for Spanish (later). The whole book is one language.
- `version` — bump when book metadata changes (title, synopsis, cover). Per-chapter content has its own version.
- `title.target` / `title.english` — book title in both languages.
- `author` — display string. Plain English/Latin, even for Chinese-language books.
- `synopsis` — 1–3 sentences, English. Shown on the book detail screen.
- `cover` — URL relative to `library.json`. SVG preferred (vector scales infinitely).
- `chapters` — ordered array. Reading order = array order.

**Chapter (inside a book):**
- `id` — local to the book (e.g. `ch-1`). The combined `book_id/chapter_id` is globally unique.
- `version` — bump when content changes; the PWA shows "Update" badges.
- `title.target` / `title.english`
- `url` — relative to `library.json`. Points to the per-chapter JSON file.

## `chapter.json`

```json
{
  "id": "ch-1",
  "book_id": "treasure-island",
  "language": "zh",
  "version": 1,
  "title": {
    "target": "Dì yī zhāng: ...",
    "english": "Chapter 1: The Old Sea-Dog at the Admiral Benbow"
  },
  "pairs": [
    { "target": "...", "english": "..." }
  ],
  "meta": {
    "source": "treasure-island.docx",
    "createdAt": "2026-05-26",
    "model": "gpt-4o",
    "synopsis": "Squire Trelawney narrates how Billy Bones arrives at the Admiral Benbow inn..."
  }
}
```

`book_id` lets the PWA route chapter IDs cleanly without parsing the URL. `meta.synopsis` is a per-chapter teaser (different from the book-level synopsis).

## Migration from v1

v1 had a flat `chapters` list on `library.json` with no book grouping. The tool migrates any v1 chapters into single-chapter book containers. See `MIGRATION.md` (generated during the migration script).

## Versioning

- **library.json** has a top-level `version` field (currently `2`). The PWA checks this and refuses to load v1.
- **Book version** bumps for metadata changes.
- **Chapter version** bumps for content changes (re-translation). The PWA shows an "Update" badge so the user can re-download.
