# Encode chapter

Read ../AGENTS.md and handoff §§3,7. Read the finished prose and titles. Do linguistic encoding yourself; no API calls or automatic dictionary-gloss substitutes.

Split prose into sentence-sized or shorter clause-sized units at natural boundaries. A pair MUST NOT cross a Chinese sentence end (。！？, including closing quotes). Paragraphs are not pairs. The finalizer rejects multi-sentence pairs; write a faithful English gloss and word alignment separately for each sentence or clause. Do not make a paragraph gloss and then attach it to each smaller unit. Keep punctuation, quotes, paragraph breaks and whitespace exactly: joining all pair.hanzi with no separator MUST reproduce the prose file byte for byte. Do not rewrite the Chinese to simplify translation or alignment.

Write `_drafts/ch-N.draft.json` containing only title:{english,hanzi}, pairs:[{english,hanzi,alignment:[{english,hanzi,category,is_idiom}]}]. English is a faithful readable clause gloss. Each chunk's Hanzi is an ordered, non-overlapping contiguous substring of its pair; its English is a span in that pair's English (English order may differ). One Chinese word per chunk, usually 1–2 characters; preserve lexical compounds/idioms. Separate content words, pronouns, prepositions, classifiers with determiners, and particles. Use nonempty English scaffolding for particles, allowing shared English spans where Chinese grammar has no separate English word. Cover every word; unaligned gaps may contain only punctuation/whitespace. Use the category enum in AGENTS.md and boolean is_idiom; use proper_noun for names. Never supply target or frequency_band at any level.

Review every pair for faithful translation and fine-grained alignment, then run from tools/translate/:
`node finalize-chapter.js --book-id <id> --chapter <N> --draft ../../content/books/<id>/_drafts/ch-<N>.draft.json`

The finalizer reuses all four deterministic helpers, validates text/coverage, produces pinyin and bands, creates a cover if missing, and registers the chapter. If validation fails, fix the draft only while no finalized chapter exists. Verify the final chapter/catalog and reader before update-state. Never manually patch generated pinyin or bands.

Finalization prepares local content only. Before publishing, follow `../QUALITY.md`: shared validator, actual reader previews, and a fresh chapter/catalog/renderer-bound QA receipt with screenshot evidence. Do not treat successful finalization as publication approval.
