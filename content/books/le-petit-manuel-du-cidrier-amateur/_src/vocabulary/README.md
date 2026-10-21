# Cider handbook vocabulary

French sentence translations and phrase alignments are authored in `../ch-N.txt`.
The four JSON resources follow the existing French vocabulary schema. Ordinary
words have independent tap targets; genuine compounds and grammatical
constructions may stay together. Specialist senses were reviewed for this book.

`words.json` contains contextual candidate senses. The published lookup has one
selected sense, never slash-separated alternatives. `phrases.json` contains the
reviewed compounds/constructions. `verbs.json` is currently empty because the
needed compound forms are handled by the phrase resource or the standard builder.

`overrides.json` holds meanings and grammatical roles tied to an exact
`[FrenchChunk, EnglishChunk]` key and an offset within that chunk. Use it when
context requires a different sense. The generator preserves reviewed phrases
before applying single-token grammatical heuristics; explicit categories also
control proper-noun frequency metadata. Recheck offsets whenever a chunk changes.
Do not reuse the other French book's story-specific senses.

Build with `node tools/translate/build-markup-book.js content/books/le-petit-manuel-du-cidrier-amateur/_src`.
The builder writes the catalogue as well as chapter files: review its version
changes and preserve unrelated books. Compare against the previous release and increment only changed chapters; keep original creation dates. The final-review tests verify that built lookups reproduce from these resources.

Run `node --test tests/cider-handbook.cjs tests/french-word-lookups.cjs tests/chapter-updates.cjs`.
Regenerate manuscript reading copies when the source changes.
