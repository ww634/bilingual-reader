# Author Agent — build brief for Codex

You (Codex) are being asked to set up an **Author Agent**: a system that writes an
original, serialized Chinese-language webnovel and emits it in the exact JSON a
bilingual reading app already consumes. This document is the complete
specification. Read it fully, then create the agent configuration (`AGENTS.md`),
the skill files, the folder structure, and the one deterministic helper script
described below.

The human (the app owner) will drive you: they steer the story at a high level;
you plan, write, and encode. **You are the author and the linguist — a local
script handles the mechanical romanization and frequency banding.**

---

## 0. Context: what already exists

This repo already contains a working translation toolchain at `tools/translate/`.
You will REUSE two proven, dependency-heavy pieces rather than reinventing them:

- `tools/translate/lib/romanize.js` — deterministic Hanzi → tone-marked pinyin
  with correct word spacing and polyphone resolution (jieba + pinyin-pro).
  Exports: `romanize(text)`, `romanizeWithMap(text)`,
  `chunkPinyinFromPair(pairHanzi, chunkHanzi, map)`, `hasHan(text)`, `segment(text)`.
- `tools/translate/lib/frequency.js` — deterministic frequency banding from the
  bundled jieba dictionary (no download). Exports: `bandForChunk(hanzi)`,
  `bandForWord(word)`, `applyFrequencyBands(pairs)`.
- `tools/translate/lib/library.js` — read/upsert/write the reader's
  `content/library.json`. Exports: `readLibrary`, `upsertBook`, `writeLibrary`.
- `tools/translate/lib/cover.js` — `renderCover({ englishTitle, targetTitle })`
  → an SVG cover string.

These live in the `tools/translate` npm package (its `node_modules` has
`@node-rs/jieba` and `pinyin-pro`). **Any script that imports them must run from
within `tools/translate/` so Node resolves those dependencies.** Put the new
finalize script there (§7).

There is also a richer previous design at `tools/studio/DESIGN.md` and a Node
implementation of the same pipeline as API calls at `tools/translate/lib/`
(`plan.js`, `write.js`, `encode.js`, `state.js`, `studio.js`). You may read them
for reference, but the Author Agent does the model work ITSELF (via Codex)
instead of calling the API, so you are NOT required to use those `.js` files
except the four deterministic ones listed above.

---

## 1. The point (pedagogy — do not violate)

The reader learns Chinese by reading genuinely enjoyable stories with an
always-present English gloss. Difficulty is controlled entirely on the reader's
side (toggles that progressively hide English by word category and frequency),
**never** by the author.

Therefore:

- **Write real, good fiction in natural, idiomatic Simplified Chinese.** Do NOT
  simplify vocabulary, do NOT restrict to HSK levels, do NOT write like a
  textbook, do NOT explain words. Engaging beats easy.
- **Chinese leads; English is a faithful gloss.** Author the Chinese first as
  natural prose; the English exists only to support the reader.
- Retention through enjoyment. A reader should want to read this for years.

---

## 2. Roles and models

| Job | Who does it | Notes |
|---|---|---|
| Series planning (bible + arc roadmap) | Codex (reasoning) | Highest-quality thinking |
| Per-arc beat sheet (spoilers) | Codex (reasoning) | |
| Chapter prose (natural Chinese) | Codex (writing) | The creative core |
| Encoding (clause split + English gloss + word alignment) | Codex | Linguistic, not creative |
| Pinyin romanization + frequency bands | **local script** (`finalize-chapter`) | Deterministic, no model |
| Chapter JSON assembly + `library.json` upsert | local script | |

Because Codex does the inference, this whole flow runs on the ChatGPT/Codex
subscription — no per-token API billing.

---

## 3. The reader contract (the immutable target)

Every chapter you produce must end up as a JSON file at
`content/books/<book-id>/ch-<N>.json` in EXACTLY this shape (do not change field
names — the app depends on them):

```json
{
  "id": "ch-1",
  "book_id": "the-midnight-wonton-stall",
  "language": "zh",
  "version": 1,
  "title": { "target": "<pinyin>", "english": "<English title>", "hanzi": "<汉字标题>" },
  "pairs": [
    {
      "target": "<pinyin of the whole clause>",
      "english": "<English gloss of the clause>",
      "hanzi": "<the Chinese clause, verbatim from the prose>",
      "alignment": [
        {
          "english": "<English span>",
          "target": "<pinyin of this chunk>",
          "hanzi": "<Chinese chunk, a substring of the clause>",
          "category": "noun",
          "frequency_band": "very_common",
          "is_idiom": false
        }
      ]
    }
  ],
  "meta": {
    "source": "author-agent",
    "createdAt": "YYYY-MM-DD",
    "model": "<model label>",
    "synopsis": null,
    "has_alignment": true,
    "alignment_complete": true
  }
}
```

**`category` enum** (use the most specific that applies; keep the
"uncategorised" bucket tiny): `noun`, `verb`, `adjective`, `adverb`, `idiom`,
`proper_noun`, `function_word` (pronouns, prepositions, conjunctions,
auxiliaries/copulas), `measure_word` (classifiers with their determiner),
`particle` (了/着/过/的/把/被/吗/呢/吧 — gloss with the closest English scaffolding
word, never empty). Legacy `grammar` exists but avoid it.

**`frequency_band`**: one of `very_common`, `common`, `uncommon`, `rare`, or
`null`. **You do NOT set this and you do NOT set `target` (pinyin).** The
finalize script fills both deterministically. You only produce `english`,
`hanzi`, `category`, and `is_idiom`.

**Alignment rules:**
- Each chunk's `hanzi` MUST be a contiguous substring of that pair's `hanzi`;
  each chunk's `english` should be a span of that pair's `english`. Never borrow
  across pairs.
- Chunks are in the order of the Chinese clause, left to right.
- One Chinese word per chunk (1–2 chars usually; a 3–4 char compound/idiom
  occasionally). Break content words apart — each noun/verb/adjective/adverb its
  own chunk; each pronoun/preposition/particle/measure word its own chunk.
- Cover every content word; attach function words to the word they bind to.

**`library.json` entry** (upserted by the finalize script; shown here so you
understand the whole): a book has
`{ version, id, language:"zh", title:{target,english,hanzi}, author:"AI generated",
synopsis, genres:[...], chapters:[{ id, version, title:{target,english,hanzi}, url }], cover }`.
Chapters are a single flat, continuous list (`ch-1, ch-2, …`); arcs are a
planning device and are NOT shown to the reader.

---

## 4. Folder structure to create

```
content/books/<book-id>/
  _series.json        # series bible + arc roadmap (author-facing; editable)
  _state.json         # rolling story state (continuity memory)
  _arcs/arc-<n>.json  # per-arc beat sheet (SPOILERS — never shown unprompted)
  _drafts/ch-<N>.draft.json   # your chapter draft BEFORE finalize (optional staging)
  ch-<N>.json         # finalized reader chapter (from the finalize script)
  cover.svg
content/library.json  # updated by the finalize script

tools/studio/
  AGENTS.md           # the agent config you will write (see §8)
  skills/
    plan-series.md
    plan-arc.md
    write-chapter.md
    encode-chapter.md
    update-state.md
tools/translate/
  finalize-chapter.js # the deterministic script you will write (see §7)
```

The `_`-prefixed files and `_arcs/`, `_drafts/` are authoring-only; the reader
only ever fetches `ch-<N>.json`, `cover.svg`, and `library.json`.

---

## 5. Persistent artifacts (schemas)

### `_series.json` — the series bible
```json
{
  "title": { "english": "...", "hanzi": "...", "target": "<pinyin, filled by finalize/util>" },
  "premise": "2-4 sentences: the engine of the series",
  "world": "the worldbuilding a writer needs",
  "tone_style": "concrete voice/style guide: POV, register, pacing, humour, rhythm",
  "synopsis": "SPOILER-FREE back-cover blurb",
  "genres": ["..."],
  "characters": [
    { "name_english": "...", "hanzi": "...", "pinyin": "<filled deterministically>", "role": "...", "description": "..." }
  ],
  "arcs": [
    { "index": 1, "title": "...", "one_liner": "high-level premise only, no outcome", "est_chapters": 8 }
  ]
}
```

### `_arcs/arc-<n>.json` — per-arc beat sheet (spoilers)
```json
{
  "arc_index": 1,
  "arc_title": "...",
  "summary": "what this arc accomplishes overall",
  "_base_global": 0,
  "chapters": [
    {
      "title_english": "working title",
      "beat": "what actually happens this chapter (spoiler-full brief for the writer)",
      "hook": "the cliffhanger/transition into the next chapter",
      "seeds_planted": ["short phrase"],
      "seeds_paid": ["short phrase"]
    }
  ]
}
```
`_base_global` = the global chapter number BEFORE this arc's first chapter (so
arc 1 → 0, and if arc 1 wrote 8 chapters, arc 2 → 8). Chapter N in this arc gets
global id `ch-<_base_global + N>`.

### `_state.json` — rolling story state (continuity memory)
```json
{
  "chapters_written": 0,
  "running_summary": "tight, spoiler-full recap of the whole story so far; compress old, keep recent detailed",
  "last_ending": "the last ~240 characters of the most recent chapter, verbatim (for seamless continuation)",
  "characters": [ { "name_english": "...", "status": "where they are / what they want / key changes" } ],
  "open_threads": ["unresolved threads still live"],
  "seeds": [ { "desc": "...", "planted_ch": 3, "paid": false } ]
}
```

---

## 6. The workflow (the whole flow)

### Stage A — Plan the series (once, `plan-series` skill)
Input: a human spec (genre, vibe, worldbuilding wishes, tropes, target chapter
length, optional reference images, rough arc count). Produce `_series.json`: a
bible plus an **arc roadmap of one-line arc premises** — high-level only, no
outcomes (e.g. *"a heist arc that introduces a new important character"*).

**Arc sizing rule (cost + wave-writing):** plan **small arcs of ~6–12 chapters
each**, and plan a handful to start (the series can extend later). Do NOT produce
28–58-chapter arcs.

Then STOP and let the human review/edit `_series.json` (the review gate). Names,
tone, and arc one-liners are theirs to tweak.

### Stage B — Plan one arc's beats (`plan-arc` skill, just-in-time)
When the human chooses an arc to write, expand its one-liner into a full
per-chapter beat sheet in `_arcs/arc-<n>.json`, using the bible + current
`_state.json`. Decide what actually happens, how it starts and ends, how a new
character earns their place, the consequences into the larger story, how it
deepens world and protagonist, and which seeds are planted/paid.

**Spoiler rule:** these beats are the writer's brief and are SPOILERS. Never
surface them to the human unless they explicitly ask ("show spoilers"). The
human steered with one line; do not spoil the outcome back to them.

### Stage C — Write a wave (`write-chapter` → `encode-chapter` → `update-state`, looped)
The human picks how many arcs/chapters to write now. For each chapter, in order:

1. **Write prose** (`write-chapter`): using the bible, `_state.json`
   (`running_summary` + `last_ending`), and this chapter's beat, write a
   ~1000–2000-word (≈1200–2200 汉字) chapter of natural Simplified-Chinese prose
   that continues seamlessly from `last_ending`, dramatizes the beat (never
   states it), and ends on the hook. Produce an English working title and a
   natural Chinese title. Chinese prose only — no romanization, no English in the
   body (except a proper noun with no Chinese form).
2. **Encode** (`encode-chapter`): segment the finished prose into short
   clause-sized reading units, preserving the characters exactly and in order
   (the concatenation of a chapter's unit `hanzi` must reproduce the prose's
   characters). Give each unit a faithful English gloss and a word-level
   `alignment` (chunks with `english`, `hanzi`, `category`, `is_idiom`). Write
   this as a draft `_drafts/ch-<N>.draft.json` in the shape of §7's input.
3. **Finalize** (run the local script): `node tools/translate/finalize-chapter.js
   --book-id <id> --chapter <globalN> --draft <path>` → fills pinyin + frequency
   bands deterministically, writes `content/books/<id>/ch-<N>.json`, and upserts
   `content/library.json`.
4. **Update state** (`update-state`): roll `_state.json` forward — refresh
   `running_summary`, set `last_ending` to the last ~240 chars of this chapter's
   prose, update character statuses, open threads, and the seed ledger; set
   `chapters_written` to this global number. Persist it.

`_state.json` is the checkpoint: interrupt any time and resume at
`chapters_written + 1`. Never regenerate an existing `ch-<N>.json` unless asked.

### Stage D — Cover
If `cover.svg` is missing, generate one (reuse `renderCover`) and set the book's
`cover` in `library.json`.

---

## 7. The deterministic finalize script (you must create this)

Create `tools/translate/finalize-chapter.js` (ES module; it lives here so
`@node-rs/jieba`/`pinyin-pro` resolve). It is the ONLY place pinyin and
frequency bands are produced — the model must never hand-write pinyin.

**Input** — a draft JSON (what `encode-chapter` writes):
```json
{
  "title": { "english": "...", "hanzi": "..." },
  "pairs": [
    {
      "english": "clause gloss",
      "hanzi": "整句中文",
      "alignment": [
        { "english": "span", "hanzi": "中文", "category": "noun", "is_idiom": false }
      ]
    }
  ]
}
```

**Behaviour:**
1. `import { romanize, romanizeWithMap, chunkPinyinFromPair } from "./lib/romanize.js"`.
   For each pair: `pair.target = romanize(pair.hanzi)`; build `map = romanizeWithMap(pair.hanzi)`;
   for each chunk: `chunk.target = chunkPinyinFromPair(pair.hanzi, chunk.hanzi, map)`.
2. `import { applyFrequencyBands } from "./lib/frequency.js"`; call
   `applyFrequencyBands(pairs)` (sets `frequency_band` on every chunk; `null` for
   proper nouns/idioms).
3. `title.target = romanize(title.hanzi)`.
4. Validate: every pair has non-empty `hanzi`, `target`, `english`; every chunk
   `hanzi` is a substring of its pair `hanzi`; no Han characters left in any
   `target`. Report problems; don't silently write a broken chapter.
5. Assemble the §3 chapter JSON (add `id`, `book_id`, `language:"zh"`,
   `version:1`, `meta`). Write it to `content/books/<id>/ch-<N>.json`.
6. `import { readLibrary, upsertBook, writeLibrary } from "./lib/library.js"` and
   upsert the book + this chapter into `content/library.json`
   (author `"AI generated"`, synopsis/genres from `_series.json`,
   `url: "books/<id>/ch-<N>.json"`).

A small companion utility to romanize the bible's names/title (fill `pinyin` /
`target`) is nice-to-have but optional; the reader only needs the chapter files
and library.

---

## 8. `AGENTS.md` you should write (proposed content)

Create `tools/studio/AGENTS.md` capturing:

- **Role**: "You are the Author Agent for a serialized Chinese webnovel read by
  English speakers learning Chinese. You plan, write natural Simplified-Chinese
  prose, and encode it for the reader. A local script handles pinyin and
  frequency bands."
- **Hard rules** (from §1): natural good fiction, no dumbing down, Chinese-first,
  never hand-write pinyin or frequency bands, spoiler-free steering.
- **The reader contract** (§3) and **finalize step** (§7): where output must go
  and how.
- **The workflow** (§6) with the review gate and the spoiler rule.
- **Continuity discipline**: always read `_state.json` before writing; always
  update it after; use characters' established Chinese names verbatim; keep facts
  consistent with the bible.
- **Arc sizing**: 6–12 chapters per arc.
- **How to invoke each skill** (the `skills/` files below).

## 9. Skill files you should write (`tools/studio/skills/`)

Each is a focused instruction file. Proposed set and contents:

- **`plan-series.md`** — Given a spec (+ optional reference images), produce/refine
  `_series.json`: bible + small-arc roadmap of spoiler-free one-liners. Romanize
  names via the util (or leave for finalize). Stop for human review.
- **`plan-arc.md`** — Given the bible + `_state.json` + an arc one-liner, write
  `_arcs/arc-<n>.json` (full per-chapter beats, hooks, seeds). Set `_base_global`
  from `_state.chapters_written` if unset. Beats are spoilers; do not reveal.
- **`write-chapter.md`** — Given bible + state + one beat, write natural
  Simplified-Chinese prose (~1000–2000 words), titled, continuing from
  `last_ending`, ending on the hook. Output prose + titles only.
- **`encode-chapter.md`** — Given a finished chapter's prose, segment into clause
  units + English gloss + word alignment (categories, is_idiom), preserving the
  Chinese verbatim; write `_drafts/ch-<N>.draft.json`; then run
  `finalize-chapter.js`.
- **`update-state.md`** — Given previous `_state.json` + the new chapter, write
  the updated state (running summary, last_ending = last ~240 chars, characters,
  threads, seed ledger, chapters_written).

---

## 10. Cost / efficiency lessons (why the design is shaped this way)

An earlier version called the API directly with a reasoning model and hit real
cost: planning a **single 28-chapter arc in one call cost ≈ $0.40–0.50** because
reasoning models bill their hidden reasoning as output tokens, and a huge beat
sheet is a huge output. The roadmap had 4 arcs totalling **170 chapters** — far
too big. Lessons baked into this brief:

1. **Small arcs (6–12 chapters).** Cheaper, faster to plan, and they fit
   writing in waves.
2. **Deterministic work stays off the model.** Pinyin + frequency bands are a
   local script — never spend inference on them.
3. **Do the linguistic encoding as the model itself** (Codex), not as extra API
   calls, so it's covered by the subscription.
4. **One chapter is the unit of progress; `_state.json` is the checkpoint.**
   Never redo finished chapters.

---

## 11. Definition of done (first milestone)

1. `AGENTS.md`, the five skill files, and the folder structure exist.
2. `tools/translate/finalize-chapter.js` works: given a hand-made draft it writes
   a valid `ch-N.json` (pinyin + bands filled, validation passing) and upserts
   `library.json`.
3. End-to-end proof: plan a small book (say 3 small arcs), write **one** chapter
   through write → encode → finalize → update-state, and confirm the resulting
   `ch-1.json` matches §3 and opens in the reader.

Build it, then hand back a one-screen summary of what you created and how to run
a wave.
