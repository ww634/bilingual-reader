# French word lookups

The original chapter markup aligns natural sentence translations. A separate,
reviewed vocabulary layer makes the French words independently tappable.

- `words.json`: lexical forms and candidate contextual senses. An English gloss
  uses `/` only to list alternatives during authoring; the generator selects
  one sense for each occurrence. Published lookup entries never contain `/`.
- `phrases.json`: a short allowlist of genuine fixed expressions, technical
  compounds and grammatical constructions. Do not add arbitrary clauses to it.
- `verbs.json`: compact compound-verb forms and their contextual counterparts.
- `overrides.json`: occurrence-specific corrections, keyed by
  `JSON.stringify([originalFrenchChunk, originalEnglishChunk])`. Each value maps
  a start offset within that chunk to `{english, category?}`.
- `corrections.txt`: the lexical review log used in the initial cleanup. The
  builder reads the JSON files; keep the JSON current when editing this log.

Build with `node tools/translate/build-markup-book.js content/books/la-derniere-voix-claire/_src`.
The builder adds `lookup` entries with exact `start`/`end` offsets to each
alignment. The reader renders these as independent flat selectable spans and
opens their contextual glosses. Original translation alignment and all story
text remain intact. Missing vocabulary fails the build rather than silently
restoring coarse lookups. Preserve published metadata and increment only changed
chapter versions after building; the generic builder rebuilds every chapter.

The model case is `a posé` → `put down`, `sa` → `his`, `fourchette` → `fork`.
Do not publish “his/her” when this occurrence clearly means “his”. Check
alternative senses in context; full translation coverage is not evidence that
a word's individual definition is correct.

Run `node --test tests/french-word-lookups.cjs` and
`node tests/chapter-updates.cjs` before publication. Compare generated chapter
text and original alignments with the prior version to verify that only the
lookup layer changed.
