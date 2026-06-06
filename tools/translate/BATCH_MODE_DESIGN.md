# Batch mode design (`--batch`)

Status: **design, pre-implementation.** Implement after the Le Guin Ch 5/6 sync run lands.

## Goal

Two execution modes sharing one pipeline:

- **Sync (default, today):** interactive request→wait→next. Best for one-off / single chapters where you want the result in seconds. Now paced by the TPM throttle so it's reliable on low tiers.
- **Batch (`--batch`, new):** submit all requests to OpenAI's [Batch API](https://platform.openai.com/docs/guides/batch), poll, collect. Best for whole books.

Batch wins for scale on three axes:
- **~50% cheaper** (half price on input + output tokens).
- **Rate limits effectively gone** — batch has its own large enqueued-token quota, separate from the 30k sync TPM. No 429 pacing needed.
- **Interruption-proof** — the job runs server-side; the local machine sleeping/closing doesn't matter. We persist batch IDs and resume by polling.

Cost trade: latency. Batches return within a 24h SLA (often minutes for our sizes). Fine for unattended book runs.

## What stays identical (reuse, don't rewrite)

These modules are mode-agnostic and are reused verbatim:
- `docx.js` (read/clean), `clauses.js` (split), `stripLeadingHeading`, `deriveChapterId`
- `analyze.js` (structure pre-pass) — still a single sync call (cheap, ~$0.03)
- `romanize.js` (Han→pinyin, deterministic, local — no API)
- `translate.js` validation: `validatePairs`, the english-echo matching, gap-fill *logic*
- `align.js` `validateAlignment` (hard/soft split), `chunkPinyinFromPair`
- `cover.js`, `library.js`, schema (`{english, hanzi, target, alignment}` + `meta`)

The only thing that changes is the **transport**: instead of N sequential `chat.completions.create` calls with in-line retry loops, we build N request lines, submit one file, and read N result lines.

## OpenAI Batch API mechanics (reference)

1. Build a **JSONL** file; one line per request:
   ```json
   {"custom_id":"tr:ch-5:b3","method":"POST","url":"/v1/chat/completions",
    "body":{"model":"gpt-4.1","messages":[...],"response_format":{...},"max_tokens":...}}
   ```
2. `client.files.create({ file, purpose: "batch" })` → file id.
3. `client.batches.create({ input_file_id, endpoint: "/v1/chat/completions", completion_window: "24h" })` → batch id (status `validating`→`in_progress`→`completed`).
4. Poll `client.batches.retrieve(id)` until `completed` (or `failed`/`expired`/`cancelled`).
5. Download `output_file_id` → JSONL of results, each keyed by our `custom_id`. Also an `error_file_id` for failed lines.

`custom_id` is our join key — it carries chapter id + request kind + batch index so we can route every response back to the right place. Same `json_schema` structured-output support as sync.

## Pipeline as rounds

A book run becomes a small number of **submit→poll→collect** rounds. Each round is one batch file covering *all chapters at once* (that's where the throughput win is).

```
Round 0  (sync)   Analyze structure + translate book title.            ~$0.03
Round 1  (batch)  Translate: 1 line per (chapter, clause-batch).
                  Collect → echo-match to clauses → gap list.
Round 1b (batch)  Re-translate only unmatched clauses (usually tiny).  [loop ≤2x]
                  Romanize all hanzi locally (no API).
Round 2  (batch)  Align: 1 line per (chapter, pair-batch of 6).
                  Collect → validate → romanize chunk pinyin.
Round 2b (batch)  Optional: re-align hard-fail pairs (only if --align-retries>0).
Round 3  (local)  Assemble chapters, write JSON, cover, library upsert.
```

Typical book = **2 main batches** (translate, align) + maybe one small gap-fill batch. Each ≤ a few minutes to hours.

## State & resumption

Persist a sidecar **run manifest** so a re-invocation resumes instead of resubmitting:

`content/books/<bookId>/.batch-state.json`:
```json
{
  "input": "corrected_text_3_structured.md",
  "model": "gpt-4.1",
  "phase": "align",                 // translate | translate_gap | romanize | align | assemble | done
  "translate": { "batchId": "batch_abc", "status": "completed", "outputFileId": "file_x" },
  "align":     { "batchId": "batch_def", "status": "in_progress" },
  "chapters":  { "ch-5": {...clauseBatchMeta...}, "ch-6": {...} }
}
```

Resume rules:
- If a phase has a `batchId` not yet `completed` → just poll it (don't resubmit — that's the whole point; the server is already working).
- If `completed` → load its output, advance to the next phase.
- The existing per-chapter `alignment_complete` flag still gates whether a chapter is fully done.

This means: start a book batch, walk away, come back hours later, re-run the same command → it polls/advances rather than re-paying.

## CLI surface

```
node tools/translate --in book.md --batch            # submit + poll to completion, then write
node tools/translate --in book.md --batch --submit   # submit only, exit (poll later)
node tools/translate --in book.md --batch --poll     # resume: poll/collect/advance an existing run
```
- `--batch` implies no TPM throttle (batch has its own limits).
- Without `--batch`, everything behaves exactly as today (sync + throttle).
- `--dry-run` still shows the plan + the (halved) cost estimate.

## Polling strategy

- Poll interval: 20s → back off to ~60s. A batch run is long-lived; the harness/cron can also re-invoke `--poll`.
- Print status transitions + a progress line (`request_counts.completed / total`).
- On `failed`/`expired`: download `error_file_id`, report which `custom_id`s failed, and (for transient errors) offer to resubmit just those as a small follow-up batch — exactly the gap-fill mechanism.

## Implementation steps (when we build it)

1. `lib/batch.js` — thin wrapper: `buildJsonl(requests)`, `submit(client, jsonl)`, `poll(client, batchId)`, `collect(client, batchId)` → `Map<custom_id, {body|error}>`. (~120 lines)
2. Refactor request construction in `translate.js` / `align.js` so the **message/schema builders are exported** and reusable by both the sync path and the batch builder. (The prompt text is already centralized; just expose `buildTranslateRequest(clauses, opts)` / `buildAlignRequest(pairs, opts)`.)
3. `lib/run-batch.js` — the round orchestrator + manifest read/write/resume.
4. Wire `--batch` / `--submit` / `--poll` in `index.js`; branch to sync vs batch orchestrator after the analyze step.
5. Cost report: reuse `tokenCost` with the 0.5× batch multiplier.
6. Test on a single short chapter first (cheap), then a 2-chapter book, then a full novel.

## Risks / notes

- **Echo-matching + gap-fill still apply** — batch doesn't change that translations can drop/renumber; we just collect the whole round then match by english content, and the "gaps" become round 1b instead of an inline retry. Clean fit.
- **Title translation** stays sync (1 cheap call) so the cover/library can be written immediately and to keep the orchestrator simple.
- **Partial book** (resumable per chapter) composes: a chapter already `alignment_complete` is excluded from the batch files.
- **24h expiry**: if a batch expires, resubmit the not-yet-returned `custom_id`s.
- Keep sync as the tested default; batch is additive and opt-in, so it can't regress one-off runs.
