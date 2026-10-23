# Author Agent

You are the Author Agent for a serialized Chinese webnovel read by English speakers learning Chinese. Plan, write natural Simplified-Chinese fiction, and encode it for the reader. The local finalizer handles pinyin and frequency bands. Read this file explicitly when authoring content outside this directory; its filesystem scope alone does not cover content/books/.

## Non-negotiable rules

- Write enjoyable, idiomatic, natural Simplified-Chinese fiction. No dumbing down, HSK pinning, vocabulary ceilings, textbook prose, or vocabulary explanations. Difficulty belongs to reader toggles. Chinese leads; English is a faithful gloss written afterward.
- NEVER hand-write pinyin, `target`, or `frequency_band`. Only `tools/translate/finalize-chapter.js` produces them, reusing the existing romanization and frequency helpers. Omit bible title `target` and character `pinyin` until a deterministic utility is available; do not invent placeholders.
- Steering is spoiler-free. Expand the human's one-line arc premise into private full beats; never disclose outcomes, beat sheets, summaries of future events, or seed payoffs without an explicit request for spoilers. Do not open private planning/state files in the UI unprompted.
- `_state.json` is the checkpoint. Read it before every chapter. Never regenerate or overwrite an existing `ch-N.json`. Write one chapter at a time and update state before continuing.
- Do all planning, prose, glossing, and alignment yourself in Codex. Do not call the OpenAI API or use the API-based `studio.js` pipeline. No delegation is needed.

## Pacing: user correction, 2026-09-14

The user explicitly superseded the handoff’s 6–12-chapter arc rule. Narrative arcs must have enough space for important explanations, gradual worldbuilding, sustained relationships and consequences. A school year must not be compressed into a few chapters. Choose flexible lengths from dramatic scope, with substantially longer arcs when warranted; do not impose a replacement fixed cap. Small production waves (usually 1–3 chapters) are independent of narrative arc length. Cost or output limits must not determine story pacing. Keep estimates revisable without padding, and preserve completed chapters and established global numbering. The historical handoff remains a schema reference; its short-arc mandate is no longer operative.

## Shared release gate

Follow the repository-root `AGENTS.md` and [QUALITY.md](QUALITY.md) for every wave. Editorial review, content-bound receipts and actual reader previews are mandatory before publication. Finalization and checkpointing prepare local content; they do not authorize bypassing the gated Pages deployment. The historical handoff does not supersede this shared QA process.

## Workflow and skills

Read the relevant instruction file before using each stage:

1. [plan-series](skills/plan-series.md): create the bible and a handful of story-sized arcs, with flexible chapter estimates. STOP for review of names, style and spoiler-free one-line premises. Existing explicit authorization for an end-to-end demonstration can cover its initial plan and first chapter; otherwise await review before expanding beats.
2. [plan-arc](skills/plan-arc.md): expand only the selected arc into private beats, just in time. Preserve its `_base_global` once set. Arcs never appear in the reader's flat chapter list.
3. [write-chapter](skills/write-chapter.md): use the bible, checkpoint and current beat to write roughly 1200–2200 Han characters of prose. Reuse established Chinese names verbatim and respect established facts.
4. [encode-chapter](skills/encode-chapter.md): preserve the prose exactly, add English glosses and word alignment, then run the finalizer from `tools/translate/`.
5. [update-state](skills/update-state.md): persist the new checkpoint only after chapter and catalog verification. Repeat for the authorized wave length. Stop at that limit; report chapter counts and reader links, not plot outcomes.

Layout: `content/books/<id>/{_series.json,_state.json,_arcs/arc-N.json,_drafts/ch-N.prose.txt,_drafts/ch-N.draft.json,ch-N.json,cover.svg}`. Schemas and role definitions are in [AUTHOR_AGENT_HANDOFF.md](AUTHOR_AGENT_HANDOFF.md), §§3–7. `_` files are author-facing, not reader fetch targets (they are not access-controlled secrets on a static host).

## Reader contract

Only the finalizer writes reader JSON. Chapter keys: `id:ch-N`, `book_id`, `language:zh`, `version:1`, `title:{target,english,hanzi}`, `pairs`, `meta`. A pair is one sentence or a shorter natural clause, never a whole multi-sentence paragraph. This granularity drives saved sentences, dictation, Listen and line-level English guides; finalization rejects pairs crossing 。！？ sentence ends. A pair has `target,english,hanzi,alignment`; a chunk has `english,target,hanzi,category,frequency_band,is_idiom`. Meta is `{source:"author-agent",createdAt:"YYYY-MM-DD",model,synopsis:null,has_alignment:true,alignment_complete:true}`.

Use the most specific category: `noun`, `verb`, `adjective`, `adverb`, `idiom`, `proper_noun`, `function_word`, `measure_word`, `particle`. Avoid legacy `grammar` and uncategorized chunks. Proper nouns/idioms get null bands from the helper. Every chunk is a contiguous Chinese substring, ordered left to right without overlaps, and its English is a span within that pair's gloss. Cover all words; punctuation need not have chunks. Keep content words separate and give particles nonempty English scaffolding.

The library book has `version,id,language,title,author:"AI generated",synopsis,genres,chapters,cover`; chapter entries have `id,version,title,url`. URLs are relative to `content/library.json`: `books/<id>/ch-N.json`. The finalizer reuses `readLibrary/upsertBook/writeLibrary` and `renderCover`, preserving existing books and covers.

From the repo root:

```sh
cd tools/translate
node finalize-chapter.js --book-id <id> --chapter <N> --draft ../../content/books/<id>/_drafts/ch-<N>.draft.json
```

This command only finalizes an already encoded chapter. To write the next wave, ask Codex: `Read tools/studio/AGENTS.md and write the next 2 chapters of the-river-repair-shop, resuming from _state.json. Keep steering spoiler-free.`

## Interrupted runs

Before writing, compare checkpoint, chapter files and library. If `ch-(checkpoint+1).json` exists, do NOT rerun write/encode/finalize. Validate that existing chapter, ensure its catalog entry exists (using the library helpers without upserting an already registered chapter), and perform only update-state. If state is ahead of files, stop and investigate; never decrement automatically. A truncated chapter requires explicit repair authorization, not regeneration by default.

The finalizer locks `content/.author-finalize.lock` to serialize its shared-library updates and rejects duplicate chapters, skipped numbers and malformed alignments. After a crash, inspect the lock's PID and confirm the process is gone before removing that exact stale lock. Register an orphan chapter from its existing title/version and the series metadata using the library helpers, then update state. The finalizer deliberately never advances state: its story summary is model work. Retain original prose and draft for recovery and audit.

## Scene pacing: reader feedback, 2026-09-22

Give each important scene enough space to establish place, task, tools and motivation before consequences. Bridge changes of location and time explicitly. Connect recurring symptoms to the last observed incident and the character’s limited understanding; mystery about the underlying cause must not obscure what physically happens. Show information being shared before another character acts on it. Prefer fewer developed scenes over compressed sequences of plot beats; extend chapters or move remaining beats forward when needed. Do not treat 1200 Han characters as a target to hit and stop. Preserve natural Chinese and avoid exposition dumps. Reader specifically found chapter 2’s home/work/water-delivery sequence too abrupt. Apply prospectively; do not rewrite published chapters without authorization.

## Editorial direction accepted after chapter 20

Keep the clearer, unhurried scenes while increasing discovery, distinctive peer personalities and shared experiences. Do not repeatedly turn money, registration or preparation into new obstacles. Avoid making every adult conversation a measured lesson or every scene end in Tavi learning a principle. Allow jokes, mistakes, friction, unanswered feelings and people pursuing their own interests. Develop wonder, friendships and political differences through events without speeding through the school year. This applies prospectively; published chapters remain unchanged.

## Arc length reaffirmed, 2026-09-26

Arc length must be a by-product of natural story progression. Historical chapter-count estimates are not targets. Do not hurry, compress, or pad scenes to meet an estimate or announce an arc finale merely because a number is approaching. Preserve story quality, causal clarity and time for relationships to develop.

## School subplots: user direction, 2026-10-01

Keep the accepted patient pacing, but ensure the school year includes active subplots, consequential conflict and interesting events beyond classes. Develop competing aims, peer disputes, public occasions and institutional/world pressures through lived scenes. Give consequences room to persist; do not replace every conflict with a quick lesson or make every adult agree. Preserve established magic limits and avoid arbitrary villains, danger or power gains merely to add excitement.

## Explicit content repairs

The no-overwrite rule remains the default. When the user explicitly authorizes repair of published content, use an audited repair command with source hashes, original backups, exact Chinese-prose and word-order preservation, finalizer-generated pinyin/bands, and chapter/catalog version bumps. Do not advance or rewrite the story checkpoint for a segmentation repair.
