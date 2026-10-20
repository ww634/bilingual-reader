# Cider handbook vocabulary

French sentence translations and phrase alignments are authored in `../ch-N.txt`.
The four JSON resources follow the existing French vocabulary schema. Ordinary
words have independent tap targets; genuine compounds and grammatical
constructions may stay together. Specialist senses were reviewed for this book.

`words.json` contains contextual candidate senses. The published lookup has one
selected sense, never slash-separated alternatives. `phrases.json` contains the
reviewed compounds/constructions. `verbs.json` is currently empty because the
needed compound forms are handled by the phrase resource or the standard builder.

`overrides.json` includes explicit senses for negative and reflexive expressions.
The shared generator applies some single-token heuristics after phrase matching;
without these local overrides it can replace an entire expression's meaning with
“negation marker” or “reflexive pronoun”. Preserve and check the overrides after
edits. Keys are JSON-encoded `[FrenchChunk, EnglishChunk]`, with offsets relative
to that chunk. Do not reuse the other French book's story-specific senses.

Build with `node tools/translate/build-markup-book.js content/books/le-petit-manuel-du-cidrier-amateur/_src`.
The builder writes the catalogue as well as chapter files: review its version
changes and preserve unrelated books. Initial publication versions are 1.

Run `node --test tests/cider-handbook.cjs tests/french-word-lookups.cjs tests/chapter-updates.cjs`.
Regenerate manuscript reading copies when the source changes.
