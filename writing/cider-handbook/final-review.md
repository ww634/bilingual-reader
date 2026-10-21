# Final whole-book quality review

Completed 21 October 2026. Scope: the existing twenty-chapter handbook, with no additional chapters. Reviewed against the book brief, French/bilingual editorial guide, drafting workflow and final continuity record.

## Outcome

The book received a complete prose and translation review, followed by a focused copy-edit affecting **96 bilingual passages**. It retains its warm, observational voice, vous/on address, practical cider vocabulary and light humour. The opening-to-closing progression remains intact. No tables, diagrams, extra lessons or unsupported reader widgets were introduced.

Final content: **20 chapters, 1,349 bilingual passages, 321 paragraph starts, 5,151 alignment chunks and 15,022 contextual lookup entries**. The French manuscript is 15,664 whitespace-delimited words. These are content counts, not a standardized reading-level assessment.

## French and English

The review covered all chapters for idiomatic French, readable rhythm, clear pronouns, technical terminology and equivalents in natural British English. Revisions remove literal or awkward phrasing such as mixing “the vessels” when the intended action is combining their contents, a deposit described as “mainly yeasted,” and storage recommendations attributed to the closure itself rather than its manufacturer.

The early whole-apple route is now explicitly separate from the bought-pasteurised-juice example established in chapter 6. The ten-litre dry/still example, separate arithmetic demonstrations, strain reference and hypothetical status remain consistent. No observed fermentation, final yield, bottling date or shelf life was invented to complete the narrative.

English revisions preserve negation, modality, quantities and prerequisites. One damaged-packet sentence was restructured because a repeated English noun was visible in the full translation but absent from its alignment. Quotation punctuation was tidied in the opening tasting examples. All twenty French and English manuscript reading copies were regenerated and checked against the app paragraphs.

The existing AB-1 manufacturer reference was rechecked against the [current Fermentis page](https://fermentis.com/en/product/safcider-ab-1/) on the review date; the published dose and temperature example did not require changing. This was not an expansion into new finishing procedures. The previous chapter-specific research records remain the evidence trail for technical claims.

## Chunks and vocabulary

Sentence translations and word-level definitions were reviewed separately. Ordinary words remain independently tappable; genuine compounds and compact grammatical constructions can remain grouped. Revised chunk boundaries keep nouns, modifiers, verb meanings and units with the corresponding English phrase rather than shifting meaning across adjacent chunks.

Context corrections include:

- *leur donner*: “them,” not the possessive “their.”
- *à plusieurs moments*: “at several,” not “with other people.”
- *tout à la fois*: “at once,” while *un élément à la fois* retains “at a time.”
- *vaut mieux*: the complete construction, with the context-appropriate meaning.
- *réserve*: reserve or reservation according to context, rather than a borrowed story-specific sense.
- A/B labels: proper nouns rather than the auxiliary *a*.

The shared French lookup generator now applies its single-token grammar heuristics only to single-token units. It no longer overwrites an allowlisted negative/reflexive expression or a prepositional phrase with the meaning of its first token. Explicit grammatical-category overrides also control frequency and idiom metadata. A capital A label is no longer joined to a following verb as if it were an auxiliary.

The old `less_common` spelling was removed from this book's published metadata: **234 unsupported band occurrences became supported values**. Current values are `very_common`, `common`, `uncommon` and `rare`; proper nouns have no frequency band. Bands remain editorial estimates. Sixty-one obsolete contextual keys were removed after the copy-edit.

All lookup annotations now reproduce from the reviewed source/vocabulary files. No manual patch of the built annotations is required to retain these corrections.

## Validation

Executed:

`node --test tests/cider-handbook.cjs tests/french-word-lookups.cjs tests/chapter-updates.cjs`

**25 checks passed.** Coverage includes all twenty catalogue entries and versions; complete, ordered French alignment and lookup offsets; unambiguous glosses; supported metadata; exact French rendering through the actual reader; an anchor for every English word; paragraph boundaries used by French-only mode; all forty manuscript reading copies; reproducible lookup generation; chapter-update behaviour preserving progress; and regression cases for the generator/context issues above. Whitespace/error checks also passed.

The review preserves chapter IDs, chapter order and bilingual-pair counts. Each changed chapter receives a version increment and the handbook edition advances from 6 to 7. Other books, their catalogue entries, cover art and unrelated workspace work are excluded from this publication. Live download, representative reading/lookup behaviour and French-only presentation are checked after deployment and reported in the delivery message.
