# Bilingual Pinyin/English Reader — App Brief

Build me an app that takes English prose and produces a clean, portable bilingual reading document I can use to learn Mandarin. The format is designed for a learner who reads pinyin (with tone marks) but not Chinese characters, and who wants the English on hand as a glossary while reading the Chinese.

## What the document needs to look like

**Layout: paired lines, stacked.** For every clause of the source text, the document shows two lines:

- Line 1: pinyin translation, **bold**, on its own line
- Line 2: the matching English clause, regular weight, on its own line
- Then the next pair, and so on

So the page reads: pinyin, English, pinyin, English, pinyin, English…

**Clause-by-clause, not sentence-by-sentence.** Long source sentences must be broken into short clauses (typically 3–10 English words each), with one clause per pair. This is essential — because Chinese and English have different word order (time and place markers move to the front, modifiers precede nouns), if you try to align a full long sentence the mapping becomes unreadable. Short clauses keep the alignment legible.

**Pinyin requirements:**
- Tone marks are mandatory (mā / má / mǎ / mà). Numbered pinyin (ma1, ma2) is not acceptable.
- Word spacing follows standard pinyin orthography: syllables of a single word run together (e.g., `zhàndòu`, not `zhàn dòu`), separate words are space-separated.
- Proper nouns are transliterated to pinyin by default, with an option to keep them in English instead (some learners prefer this so the pinyin stays focused on actual Chinese vocab).

**Visual grouping:**
- Tight spacing between a pinyin line and its English line (they read as one unit).
- Larger gap before the next pair, so the eye can latch onto each pairing.
- Same font size for pinyin and English so visual line lengths roughly correspond — this helps the user infer rough word-to-word mapping.
- Clean, readable sans-serif font with good support for combining diacritics (Arial, Inter, or similar).

**Title block:** The chapter/document title appears at the top in the same paired format (bold pinyin, then English subtitle).

## What the app needs to do

**Input:** Accept English prose — either pasted into a text box or uploaded as `.txt` / `.md`. Should handle a single chapter at a time (~500–3,000 words).

**Processing pipeline:**
1. Split the input into clauses suitable for pair-by-pair display. Heuristics: split on commas, semicolons, em dashes, and sentence boundaries; collapse very short fragments into the next clause; cap any single clause at roughly 12 words.
2. Translate each clause into natural Chinese (rendered as pinyin with tone marks). Translation should preserve the meaning and tone of the source, not be word-for-word. Use an LLM call for this — Claude (Anthropic API) is the recommended translator; the prompt should explicitly ask for: pinyin only (no characters), tone marks, standard pinyin word-spacing, and natural Chinese phrasing within the constraint of each clause.
3. Assemble the paired output.

**Output formats:** Should support at least two of these (HTML is the priority for portability; the other two are bonuses):
- **HTML** — single self-contained file, inline CSS, print-friendly stylesheet so the user can also "Print to PDF" from the browser. Should look good both on screen and on paper.
- **PDF** — direct PDF export (via headless Chromium, ReportLab, or similar).
- **DOCX** — Word document, for users who want to edit or annotate.

**User-facing settings** (sensible defaults, but exposed as toggles):
- Proper nouns: transliterate to pinyin / keep in English (default: transliterate)
- Clause length target: short (5–7 words) / medium (8–12 words) / long (12–18 words) (default: medium)
- Font size: small / medium / large (default: medium, ~12pt)
- Show tone-color highlighting on pinyin: yes / no (each of the four tones gets a distinct subtle color — a popular learning convention; default: off)
- Add chapter title and metadata (title, source, date)

## Tech suggestions (not prescriptive — pick what fits)

- **Stack:** Python CLI is fine if you prefer something simple; a small Next.js or SvelteKit web app is fine if you want a UI. A CLI plus a static HTML output template is probably the lowest-friction first version.
- **Translation:** Anthropic Claude API, model `claude-sonnet-4-6` or `claude-haiku-4-5-20251001` for cost. Prompt the model with the full source so it has context, then have it return a structured list of `{english_clause, pinyin}` pairs. Validate that every English clause comes back with a pinyin counterpart before assembling output.
- **HTML rendering:** plain HTML/CSS, no framework needed for the document itself. Use `font-family: "Inter", "Arial", sans-serif;` and set a print stylesheet with sensible page margins.
- **Persistence:** save generated documents to a local folder so they accumulate as a reading library; name files by chapter title.

## Definition of done

The app, given a chapter of English prose, produces a portable bilingual document in which:

1. Every clause of the source text is paired with a pinyin translation.
2. Pinyin uses tone marks, correct word spacing, and natural Chinese phrasing.
3. The layout makes pair-by-pair mapping visually unambiguous.
4. The output file is self-contained and shareable (HTML preferred; PDF/DOCX optional).
5. Settings (clause length, proper noun handling, font size, tone colors) are user-adjustable.

## Nice-to-haves (don't block v1)

- Hover or tap on a pinyin word to reveal the underlying Chinese character (useful if the user later wants to start learning characters).
- A vocabulary side-panel that pulls out the unique pinyin words used in the chapter, with English glosses, sorted by frequency or by appearance.
- Audio: TTS for each pinyin line so the user can hear pronunciation. Free options: browser's built-in `SpeechSynthesis` API with a `zh-CN` voice.
- Reading progress: remember scroll position per chapter.
- Library view: list of all generated chapters with last-read timestamp.
