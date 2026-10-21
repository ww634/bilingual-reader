# Continuity and editorial handoff — through chapter 10

Read after `continuity-through-ch5.md`. Updated 21 October 2026.

## New chapters

6. Un petit atelier bien préparé — equipment by function, purchased juice, cleaning/sanitising, materials, assembly and hygienic handling.
7. Broyer et presser — the separate whole-fruit route, milling, pressing, collection, variable yields and prompt cleaning.
8. Lire son jus — sampling, hydrometer technique, specific gravity, temperature, refractometer limits, pH and titratable acidity.
9. Choisir un équilibre — separate A/B trials, sensory decisions, scaling and why a juice blend is not yet a finished-cider blend.
10. Les levures entrent en scène — selected/spontaneous routes, strain terminology, current product guidance, temperature, nutrition and inoculation preparation.

## Main example: explicit sourcing decision

Chapter 6 deliberately chooses purchased pasteurised apple juice without fermentation-inhibiting preservatives for the continuing hypothetical batch. The orchard apples illustrate the separate whole-fruit route and are not added to this batch. No actual fruit was purchased or processed. This decision is explicit in chapters 6 and 7 and must remain clear in later chapters.

- Starting nominal juice volume remains ten litres. Samples and any subsequent losses must be deducted; ten litres is not a promised packaged yield.
- Intended style remains dry and still. No carbonation or sweetness adjustment introduced.
- Chapter 10 names SafCider AB-1 by Fermentis as the reference selected yeast, without claiming it is the only suitable strain.
- Manufacturer page consulted October 2026: primary-fermentation recommendation 20–30 g/hL and fermentation range 10–30 °C.
- Illustrative dose at exactly ten litres: 2.5 grams, within the calculated 2–3 gram interval. Actual dose must follow the actual volume and current product directions.
- Illustrative working temperature: around twenty degrees Celsius. Not a universal optimum.
- Product permits direct inoculation; chapter describes the principle and points to its current instructions, rather than combining rehydration and direct-pitch methods.
- No actual density, pH, titratable acidity or YAN result has been established. The chapter-8 reading 1.050 is an independent hypothetical measurement example.
- No nutrient product or dose has been selected. Nutrition remains a measurement-led decision; no invented analysis fills this gap.
- No precise vessel size, fermentation start date, activity rate, completion time or bottle-readiness has been established.

## Separate examples

Chapter 7: hypothetical ten kilograms yielding six litres, used only to show 0.6 L/kg arithmetic. It is not the main batch's fruit weight or measured yield.

Chapter 9: pasteurised juices A and B, small 100 mL trials at 75:25, 50:50 and 25:75; a scale example gives 7.5 plus 2.5 litres. No blend is added to the main batch. Tasting samples do not return to a batch.

## Vocabulary and language

New terms include nettoyage, désinfection, barboteur, poussoir, pulpe, marc, rendement, densimètre, éprouvette, ménisque, densité relative, réfractomètre, acidité titrable, souche, moût, azote assimilable and ensemencement. Continue to explain technical words in French and reuse them through tasks.

Context matters: frais can mean fresh in fruit/juice passages; échelle is a scale in measurement; mélange is a noun in blend trials; doux means gentle in mixing; A is a blend label, never the verb “has”. Preserve individual vocabulary access alongside larger translation alignments.

## Chapter 11 handoff

Begin with the prepared illustrative batch and establish how to record and interpret fermentation observations. Keep the source's current yeast instructions and the example's around-twenty-degree working choice distinct from a universal recipe. Address temperature and density trends, sampling hygiene and why bubbles alone cannot establish completion. Do not invent an actual successful fermentation, a nutrient analysis or a fixed timetable to bridge the teaching example.

Read `research-chapters-6-10.md` for technical scope, verified arithmetic and the resolved conflict between older and current yeast dosing guidance. Later chapters retain their own research requirements.

## Validation

All ten chapters are covered by the content/lookup/renderer checks. Fifteen checks passed with `node --test tests/cider-handbook.cjs tests/french-word-lookups.cjs tests/chapter-updates.cjs`. Added checks cover hydrometer and must terminology, specific gravity, negative expressions, contextual senses and A/B labels. Published chapter files 1–5 were restored byte for byte after building; chapters 6–10 begin at version 1. Book metadata version increases for the expanded synopsis.
