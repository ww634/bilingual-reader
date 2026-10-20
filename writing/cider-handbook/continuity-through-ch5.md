# Continuity and editorial handoff — chapters 1–5

## Established content

The manuscript uses contemporary French, addressed to « vous », with natural English translations. The first five chapters are approximately 900 French words each. They cover the planned opening topics and end by preparing the workspace chapter.

The example remains hypothetical: ten litres of starting juice, selected yeast, an intended dry, still cider. It has not yet been made. No final yield, fruit weight, variety blend, yeast product, temperature, additives or calendar dates have been established. Chapter 5 selects sound, identifiable, tree-picked fruit for the introductory route and records varieties and harvest dates. No subsequent chapter may treat these as observations from a real batch.

## Vocabulary first introduced

- Chapter 1: cidre, jus, levure, fermentation, sec, tranquille, lot; milling, pressing and racking are previewed, not taught as procedures.
- Chapter 2: acidité, amertume, astringence, tanins, arôme, assemblage; dry style and drying mouthfeel are distinguished.
- Chapter 3: variété, porte-greffe, greffe, vigueur, pollinisation, floraison, autofertile, pépiniériste.
- Chapter 4: bourgeon, rameau, taille, bois fructifère, nouaison, éclaircissage, alternance, paillage.
- Chapter 5: maturité, échantillon, pépin, amidon, tri, patuline, rendement. The iodine test is mentioned, not prescribed.

## Chapter 6 handoff

Begin with the clean, identifiable fruit crates and the need to prepare the workspace. Explain equipment by function, distinguish cleaning from sanitation, and provide the promised alternative of selecting suitable purchased juice. Research equipment, materials and any product-specific instructions before drafting. No need to repeat the entire orchard or sensory introduction.

## Validation

The five markup chapters build successfully with the existing French builder. The book has 377 bilingual pairs and 1,846 translation chunks, plus a separate word-lookup layer. Natural sentence translations remain available even when a word has a shorter contextual gloss.

All 14 checks passed with `node --test tests/cider-handbook.cjs tests/french-word-lookups.cjs tests/chapter-updates.cjs`. Checks include exact source-text preservation, catalogue versions, complete ordered lookup coverage, technical meanings, negation/reflexive overrides and reader-rendered text preservation for every sentence. Existing French-book and download/update checks also pass.

Local UI review: five chapters visible in the catalogue and downloadable; bilingual reading page renders; « tranquille » opens “still” with the correct full-sentence context; French-only mode retains continuous paragraphs. The preview used only public static assets and this book, on localhost.

Technical references and limitations are recorded in `research-chapters-1-5.md`. Future chapters still need their own research and review. Initial chapter/catalogue versions are 1. Manuscript reading copies are in `writing/manuscript/le-petit-manuel-du-cidrier-amateur/`.
