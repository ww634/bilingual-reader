# French vocabulary chunking review — 19 October 2026

Scope: alignment data in all 41 published chapter files and the reader's rendering/tap-handler code. This is a diagnosis of vocabulary granularity, not another prose rewrite. No chapter text, alignment data or app behaviour was changed in this review.

## Finding

The app displays the alignment group stored in the book. A tap within that group opens its complete French target and English gloss. It does not perform a separate word lookup inside the group. Consequently, content authored as a clause behaves as a clause-sized vocabulary entry.

Phrase-based alignment was intentional, partly to preserve idiomatic translation, compound verbs and complete English coverage. Its application is too broad for the user's desired word-by-word lookup. This is a content-design problem, with a limitation in the current popup model, rather than a download or rendering fault.

The previous bilingual review verified coverage, quotation balance and translation consistency. Those checks did not establish that the grouping was pedagogically useful. Some merges introduced during that review compounded the problem by making long clauses into single clickable entries.

## Complete-book measurements

Counting space-separated words, with apostrophised forms treated as one word:

- 13,510 alignment groups.
- 1,995 single-word groups: 14.8%.
- 11,515 multiword groups: 85.2%.
- 1,213 groups contain five or more words: 9.0% of groups, accounting for approximately 17.9% of the aligned French words.
- The longest group has ten words.
- The problem is particularly noticeable in chapters 13–22: average groups there contain roughly 3.1–3.6 words, compared with roughly 2.4–2.6 in many closing chapters.

These counts describe length, not correctness. A two-word expression can be a useful unit; a four-word group can conceal a word the learner needs to inspect separately.

## Examples

| Current group | Assessment |
| --- | --- |
| « a posé sa fourchette » → “put down his fork” | Overgrouped: fourchette should be individually accessible. The verb and possessive need not be tied to the noun. |
| « des pommes de terre, des œufs et du pain » → “potatoes, eggs and bread” | Overgrouped: three distinct food vocabulary items are bundled together. Pommes de terre is a legitimate lexical unit; the whole shopping list is not. |
| « qui maintenait la bande contre la tête de lecture » | Overgrouped: independent vocabulary and a technical term are hidden inside a relative clause. |
| « Lui non plus n'en était pas tout à fait sûr » | Overgrouped: a ten-word clause, merged during the previous review. Complete translation coverage was prioritised over useful lookup granularity. |
| « tête de lecture » | Sensible technical expression to retain as a phrase, while ideally allowing component-word inspection too. |
| « tout à fait » | A useful fixed expression whose meaning is not taught well by three isolated literal glosses. |

## Recommended correction policy

Use the smallest meaningful vocabulary unit as the default. Separate subjects, ordinary nouns, adjectives, possessives and independent complements. Keep genuine fixed expressions, compound nouns and technical terms together where useful. Compound tense constructions may need contextual grouping, but they should not absorb their object or an entire clause merely to make the English alignment convenient.

Do not simply split every existing chunk at spaces and copy its gloss to each resulting word. That would replace an oversized translation with misleading individual translations. Each smaller unit needs an accurate contextual gloss; the natural full-sentence English translation must remain separately available.

For the strongest word-lookup experience, distinguish individual-word meaning from phrase meaning in the content/UI model. Otherwise even legitimate idioms and compound constructions will still prevent literal component-word lookup. That is a separate implementation decision from correcting obviously overlong book annotations.

A corrective pass should preserve the manuscript, clue wording and sentence translations, re-annotate all chapters at finer granularity, and validate actual lookup examples as well as text coverage. Chapters 13–22 and the longest groups deserve priority, but a five-word cutoff alone will miss smaller overgrouped combinations.

## Implemented correction — 19 October 2026

All 41 chapters now carry a separate fine-grained French lookup layer. The
reader renders its entries independently while retaining the original natural
sentence translation alignment. The story, sentence translations and manuscript
reading copies are unchanged.

The user's example is verified in the reader: a posé → put down; sa → his;
fourchette → fork. Contextual glosses replace generic alternatives such as
his/her. Compound verbs, fixed expressions and proper names remain meaningful
units. The build fails for missing lexical forms; all lookup offsets and word
coverage are checked across the complete book. The implementation and reference
resources are documented in the book's `_src/vocabulary/README.md`.
