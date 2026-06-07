// Translate an array of English clauses into pinyin (Mandarin) using OpenAI.
//
// Uses Chat Completions with structured outputs (json_schema) so the model
// is guaranteed to return a valid JSON object matching our schema. We also
// post-validate (count match, tone-mark presence, no Han characters).

import OpenAI from "openai";
import { romanize, hasHan } from "./romanize.js";
import { acquire, reconcile, estimateRequestTokens } from "./ratelimit.js";

// The translator now emits SIMPLIFIED CHINESE CHARACTERS (Hanzi), one
// translation per input clause. We pair each with our own input clause (so
// English can never be dropped) and romanize the Hanzi to pinyin
// deterministically (so there are no stray Han chars, tone marks are correct,
// and word spacing is orthographic). See lib/romanize.js.
const SYSTEM_PROMPT = `You are an expert literary translator for a bilingual Chinese-learning tool.

Translate each English clause into natural Mandarin Chinese written in SIMPLIFIED CHINESE CHARACTERS (Hanzi). The app romanizes your characters to pinyin itself — you do NOT output pinyin.

Hard rules — non-negotiable:
1. OUTPUT SIMPLIFIED HANZI ONLY for the translation text. Do NOT output pinyin, bopomofo, or tone-numbered romanization. (Proper names with no sensible Chinese form may stay in Latin script — see rule 5.)
2. EXACTLY ONE translation per input clause. Return each as an object { "english": "<the clause copied verbatim>", "hanzi": "<its translation>" }. Copy the english back EXACTLY as given so it can be matched to the source. Include every clause exactly once; never merge, split, drop, or add clauses.
3. Translate each clause faithfully WITHIN ITS OWN SCOPE. If a clause is a grammatical fragment ("and the rest of these"), translate just that fragment — do NOT borrow words from neighbouring clauses to complete it. Natural phrasing within the clause, not word-for-word.
4. Render dialogue/quotes naturally; you may omit or include Chinese punctuation as reads best — the app normalizes punctuation.
5. Proper nouns: transliterate names to Hanzi where there is a natural rendering (e.g. "Sid" → 西德). If a name has no sensible Chinese rendering, keep it verbatim in Latin script inside the Chinese text.
6. Use the FULL chapter context (provided) so name transliterations and register stay consistent across clauses.

Output: a JSON object { "translations": [ { "english": "<clause verbatim>", "hanzi": "<translation>" }, … ] } with one entry per input clause, in order.`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    translations: {
      type: "array",
      description: "One {english, hanzi} per input clause, in order. english = the clause copied verbatim (for matching); hanzi = its Simplified-Chinese translation.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          english: { type: "string", description: "The source clause, copied back verbatim." },
          hanzi: { type: "string", description: "Simplified Chinese characters translating that clause." },
        },
        required: ["english", "hanzi"],
      },
    },
  },
  required: ["translations"],
};

const HAN_CHAR_RE = /[一-鿿㐀-䶿]/;
const TONE_MARK_RE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙǕǗǙǛ]/;

// Translator output budget. Most novel chapters need 3-9k output tokens
// (~100-300 pairs × ~30 tokens/pair). 16k gives ~500 pairs of headroom.
// Ceiling is gpt-4.1's max output (32k); past that we can't go up further
// and the caller must split the chapter.
const MAX_RESPONSE_TOKENS_DEFAULT = 16000;
const MAX_RESPONSE_TOKENS_CEILING = 32000;

// Max clauses per single translator API call. Larger numbers degrade quality
// quickly: at 200+ the LLM tends to over-merge, drift in register, or just
// truncate the tail of its response. Empirically a real chapter of ~750
// clauses fails badly as one call; in 100-clause batches it stays stable.
export const MAX_CLAUSES_PER_CALL = 60;

export function buildClient(apiKey) {
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Set it in your env: export OPENAI_API_KEY=sk-...");
  }
  // maxRetries 8 (default 2): on low TPM tiers (e.g. 30k tokens/min) large
  // translation/alignment batches routinely brush the rate limit. The SDK
  // honours the Retry-After header and backs off exponentially, so a high
  // retry count lets a run ride through transient 429s instead of dropping a
  // chapter. Long timeout so a backed-off request isn't abandoned mid-wait.
  return new OpenAI({ apiKey, maxRetries: 8, timeout: 120000 });
}

/**
 * Public entry point: translate ALL clauses for a chapter, splitting into
 * MAX_CLAUSES_PER_CALL-sized API calls as needed. Long chapters in a single
 * call cause quality collapse (over-merging, silent truncation, register
 * drift) so batching is mandatory above ~100 clauses.
 *
 * Per-batch usage is summed; pairs are concatenated in input order.
 */
export async function translateClauses(client, clauses, opts = {}) {
  if (clauses.length <= MAX_CLAUSES_PER_CALL) {
    return _translateBatchSafe(client, clauses, opts);
  }
  // Split into roughly-equal batches so the last one isn't a tiny stub.
  const numBatches = Math.ceil(clauses.length / MAX_CLAUSES_PER_CALL);
  const perBatch = Math.ceil(clauses.length / numBatches);
  const allPairs = [];
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (let bi = 0; bi < numBatches; bi++) {
    const start = bi * perBatch;
    const slice = clauses.slice(start, start + perBatch);
    if (opts.onBatch) opts.onBatch(bi + 1, numBatches, slice.length);
    const result = await _translateBatchSafe(client, slice, {
      ...opts,
      // Tell the model where in the chapter this batch sits, so it can keep
      // register/voice consistent across batches without seeing the previous
      // batch's output.
      batchPosition: { index: bi + 1, total: numBatches, startClause: start + 1 },
    });
    allPairs.push(...result.pairs);
    totalUsage.prompt_tokens     += result.usage?.prompt_tokens     || 0;
    totalUsage.completion_tokens += result.usage?.completion_tokens || 0;
    totalUsage.total_tokens      += result.usage?.total_tokens      || 0;
  }
  return { pairs: allPairs, usage: totalUsage };
}

/**
 * Per-batch health check for the issues a retry can plausibly fix:
 *   - dropped/paraphrased english (coverage gap)
 *   - a stray Han character in the pinyin (the model occasionally emits one
 *     instead of its pinyin, e.g. "yī句" for "yī jù")
 * Returns a short reason string when unhealthy, or null when clean.
 */
// Normalise english for echo-matching: letters/digits only, lowercased.
export function _normEcho(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Route returned {english, hanzi} items to their source clauses by english
 * CONTENT (not position/index — immune to the model dropping/renumbering).
 * Mutates hanForClause[i] = hanzi for each matched clause index in `pending`.
 * exact normalized → containment → token-overlap (≥0.5) fallback. SHARED by
 * the sync gap-filler and the batch orchestrator.
 */
export function assignTranslationItems(items, pending, normClauses, hanForClause) {
  for (const it of items || []) {
    const han = (it.hanzi || "").trim();
    if (!han) continue;
    const echo = _normEcho(it.english);
    if (!echo) continue;
    let best = -1;
    for (const i of pending) { if (hanForClause[i]) continue; if (normClauses[i] === echo) { best = i; break; } }
    if (best === -1) {
      for (const i of pending) {
        if (hanForClause[i]) continue;
        if (normClauses[i].includes(echo) || echo.includes(normClauses[i])) { best = i; break; }
      }
    }
    if (best === -1) {
      const et = new Set(echo.split(" ").filter((w) => w.length >= 3));
      let bestScore = 0;
      for (const i of pending) {
        if (hanForClause[i]) continue;
        const ct = normClauses[i].split(" ").filter((w) => w.length >= 3);
        if (!ct.length) continue;
        let hit = 0; for (const w of ct) if (et.has(w)) hit++;
        const score = hit / ct.length;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (bestScore < 0.5) best = -1;
    }
    if (best !== -1) hanForClause[best] = han;
  }
  return hanForClause;
}

/**
 * Translate one batch, matching each returned translation to its source clause
 * by ENGLISH CONTENT (the model echoes the clause), NOT by array position or a
 * model-supplied index. Index/position-based mapping silently misaligns when
 * the model drops or renumbers an item mid-batch — which corrupts the whole
 * bilingual pairing. Content matching is immune to that: a returned item only
 * ever lands on the clause it actually translated.
 *
 * Any clause that ends up unmatched is re-translated (gap-fill) by passing
 * just those clauses again. We always STORE our own clause text as the
 * english, so the echo only routes the hanzi — it can't introduce drift.
 */
async function _translateBatchSafe(client, clauses, opts = {}) {
  const MAX_BATCH_TRIES = 3;
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const hanForClause = new Array(clauses.length).fill(null);
  const normClauses = clauses.map(_normEcho);

  let pending = clauses.map((_, i) => i);
  for (let attempt = 1; attempt <= MAX_BATCH_TRIES && pending.length > 0; attempt++) {
    const subset = pending.map((i) => clauses[i]);
    const r = await _translateClausesOnce(client, subset, { ...opts, coverageRetry: attempt > 1 });
    usage.prompt_tokens     += r.usage?.prompt_tokens     || 0;
    usage.completion_tokens += r.usage?.completion_tokens || 0;
    usage.total_tokens      += r.usage?.total_tokens      || 0;

    assignTranslationItems(r.items, pending, normClauses, hanForClause);

    const stillMissing = pending.filter((i) => !hanForClause[i]);
    if (stillMissing.length && attempt < MAX_BATCH_TRIES && opts.onCoverageRetry) {
      opts.onCoverageRetry(attempt, MAX_BATCH_TRIES, `${stillMissing.length} clause(s) unmatched`);
    }
    pending = stillMissing;
  }

  const pairs = clauses.map((c, i) => {
    const hanzi = hanForClause[i] || "";
    return { english: c, hanzi, target: romanize(hanzi) };
  });
  return { pairs, usage };
}

/**
 * Build the chat-completions request body for translating a batch of clauses
 * into Hanzi. SHARED by the sync translator (_translateClausesOnce) and the
 * batch builder so both use the identical prompt + schema. Pure (no I/O), so
 * batch mode can serialise it into a JSONL line.
 */
export function buildTranslateBody(clauses, opts = {}) {
  const model = opts.model || "gpt-4o";
  const englishTitle = opts.englishTitle || "(untitled)";
  const fullText = opts.fullText || clauses.join(" ");
  const canonicalNames = Array.isArray(opts.canonicalNames) ? opts.canonicalNames : [];

  const canonicalBlock = canonicalNames.length === 0 ? "" : [
    "",
    "Canonical translations — these names/terms MUST be used VERBATIM whenever they appear in any clause. Do not invent variants.",
    ...canonicalNames.map((n) => `  - "${n.english}" → "${n.target}"`),
  ].join("\n");

  const batchNote = opts.batchPosition
    ? `\nNote: this is BATCH ${opts.batchPosition.index} of ${opts.batchPosition.total} for this chapter (clauses ${opts.batchPosition.startClause}..${opts.batchPosition.startClause + clauses.length - 1} of the chapter total). Keep voice, register, and name transliterations consistent with the full chapter prose above.\n`
    : "";

  const countNote = opts.coverageRetry
    ? `\n⚠ RETRY: return one { "english", "hanzi" } entry for EVERY clause below — copy each clause's english back verbatim (so it can be matched) and translate it to hanzi. Cover all ${clauses.length} clauses.\n`
    : "";

  const userPrompt = [
    `Chapter title: ${englishTitle}`,
    canonicalBlock,
    "",
    "Full chapter prose (for context — do NOT translate this directly):",
    "```",
    fullText,
    "```",
    batchNote,
    countNote,
    `Translate the following ${clauses.length} English clauses into Simplified Chinese (Hanzi).`,
    `Return one { "english", "hanzi" } object per clause — "english" is the clause copied back verbatim, "hanzi" its translation. Cover every clause exactly once.`,
    "Translate each clause within its own scope; do NOT merge, drop, or borrow words across clauses.",
    "",
    "Clauses:",
    clauses.map((c, i) => `${i + 1}. ${c}`).join("\n"),
  ].join("\n");

  const isNewFamily = /^gpt-5|^o1|^o3/i.test(model);
  const tokenParamName = isNewFamily ? "max_completion_tokens" : "max_tokens";
  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "translations", strict: true, schema: RESPONSE_SCHEMA },
    },
    [tokenParamName]: opts.maxResponseTokens || MAX_RESPONSE_TOKENS_DEFAULT,
  };
  if (!isNewFamily) body.temperature = 0.2;
  return body;
}

/** Parse a translations response into raw [{english, hanzi}] items. */
export function parseTranslationItems(content) {
  try {
    const p = JSON.parse(content);
    return Array.isArray(p.translations) ? p.translations : [];
  } catch {
    return [];
  }
}

/**
 * Translate one batch of clauses in a single OpenAI call. Internal — call
 * translateClauses() instead so long chapters are batched correctly.
 * Returns { items: [{english, hanzi}], usage }.
 */
async function _translateClausesOnce(client, clauses, opts = {}) {
  // Output-budget control + truncation recovery. We set a ceiling so a
  // truncated (unparseable) structured-output response is a CLEAN error, and
  // on overflow give the caller one chance to bump the budget.
  let tokenBudget = opts.maxResponseTokens || MAX_RESPONSE_TOKENS_DEFAULT;
  for (let attempt = 1; ; attempt++) {
    const request = buildTranslateBody(clauses, { ...opts, maxResponseTokens: tokenBudget });
    const _rl = await acquire(estimateRequestTokens(request.messages, 2500));
    const response = await client.chat.completions.create(request);
    reconcile(_rl, response.usage?.total_tokens);

    if (response.choices[0].finish_reason === "length") {
      const newBudget = opts.onTruncation
        ? await opts.onTruncation({ attempt, currentBudget: tokenBudget, ceiling: MAX_RESPONSE_TOKENS_CEILING })
        : null;
      if (newBudget && newBudget > tokenBudget) {
        tokenBudget = Math.min(newBudget, MAX_RESPONSE_TOKENS_CEILING);
        continue; // retry with bigger budget
      }
      throw new Error(
        `Translator output truncated at ${tokenBudget} tokens. ` +
        (tokenBudget >= MAX_RESPONSE_TOKENS_CEILING
          ? "Already at the model's ceiling — split this chapter into smaller sections."
          : "Re-run with a larger --max-response-tokens, or split the chapter.")
      );
    }

    // Raw [{english, hanzi}] items; the gap-filling caller maps them to clauses.
    return { items: parseTranslationItems(response.choices[0].message.content), usage: response.usage };
  }
}

/**
 * Translate a title (book OR chapter) separately. Pass `isBookTitle: true`
 * for book titles so the model doesn't add a "Dì N zhāng:" chapter prefix.
 */
export async function translateTitle(client, englishTitle, opts = {}) {
  const model = opts.model || "gpt-4o";
  const isBookTitle = !!opts.isBookTitle;

  const titleGuidance = isBookTitle
    ? "\n\nTASK: translate a BOOK TITLE into Simplified Hanzi. Translate ONLY the title — no chapter prefixes, no framing. Use the standard/most natural Mandarin rendering of the book's name."
    : "\n\nTASK: translate a CHAPTER TITLE into Simplified Hanzi. You may use standard chapter-title phrasing (e.g. a 第N章： prefix) if appropriate.";

  const isNewFamily = /^gpt-5|^o1|^o3/i.test(model);
  const request = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT + titleGuidance },
      {
        role: "user",
        content: `Translate this ${isBookTitle ? "book" : "chapter"} title to Simplified Chinese (Hanzi):\n\n"${englishTitle}"\n\nReturn JSON: { "hanzi": "汉字标题" }.`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "title_hanzi",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { hanzi: { type: "string" } },
          required: ["hanzi"],
        },
      },
    },
  };
  if (!isNewFamily) request.temperature = 0.2;
  const _rl = await acquire(estimateRequestTokens(request.messages, 300));
  const response = await client.chat.completions.create(request);
  reconcile(_rl, response.usage?.total_tokens);
  const parsed = JSON.parse(response.choices[0].message.content);
  const hanzi = (parsed.hanzi || "").trim();
  // english is the original verbatim; target is the deterministic romanization.
  return { english: englishTitle, hanzi, target: romanize(hanzi), usage: response.usage };
}

/**
 * Validate a batch of pairs. Returns { ok, problems }.
 *
 * With the Hanzi-1:1 design the checks are simple: exactly one pair per input
 * clause, every pair has Hanzi + a non-empty romanized pinyin, and the
 * romanizer left no stray Han characters in the pinyin. English is our own
 * input clause, so coverage can't fail.
 */
export function validatePairs(inputClauses, pairs) {
  const problems = [];
  if (pairs.length !== inputClauses.length) {
    problems.push(
      `Count mismatch: ${pairs.length} translations for ${inputClauses.length} clauses (expected exactly 1:1). ` +
      `The model merged, dropped, or added a clause.`
    );
  }
  pairs.forEach((p, i) => {
    if (!p.hanzi || !p.hanzi.trim()) {
      problems.push(`Pair ${i + 1}: empty Hanzi translation`);
    }
    if (!p.target || !p.target.trim()) {
      problems.push(`Pair ${i + 1}: empty pinyin (romanization produced nothing for "${p.hanzi}")`);
    }
    if (HAN_CHAR_RE.test(p.target || "")) {
      problems.push(`Pair ${i + 1}: Han characters left in pinyin: "${p.target}"`);
    }
  });
  return { ok: problems.length === 0, problems };
}

// Per-million-token rates ($USD). Used by both estimateCost (uses character
// proxies) and tokenCost (uses real usage). Keep these in sync as pricing
// updates from OpenAI.
export const MODEL_RATES = {
  "gpt-4o":        { in: 5,    out: 20   },
  "gpt-4o-mini":   { in: 0.15, out: 0.60 },
  "gpt-4-turbo":   { in: 10,   out: 30   },
  "gpt-4.1":       { in: 2,    out: 8    },
  "gpt-4.1-mini":  { in: 0.40, out: 1.60 },
  "gpt-4.1-nano":  { in: 0.10, out: 0.40 },
  // gpt-5 family — placeholder rates; update with real values when verified.
  "gpt-5":         { in: 5,    out: 20   },
  "gpt-5-mini":    { in: 0.50, out: 2.00 },
  "gpt-5-nano":    { in: 0.05, out: 0.40 },
  "gpt-5.4-mini":  { in: 0.50, out: 2.00 },
  "gpt-5.4-nano":  { in: 0.05, out: 0.40 },
};

/**
 * Rough cost estimate from character counts. Used BEFORE making API calls
 * to show the user an upfront estimate.
 */
export function estimateCost({ inputChars, expectedOutputChars }, model = "gpt-4o") {
  const inputTokens = inputChars / 1.3;
  const outputTokens = expectedOutputChars / 1.3;
  const r = MODEL_RATES[model] || MODEL_RATES["gpt-4o"];
  const cost = (inputTokens * r.in + outputTokens * r.out) / 1_000_000;
  return { inputTokens: Math.round(inputTokens), outputTokens: Math.round(outputTokens), cost };
}

/**
 * Exact cost from real token usage (from response.usage). Used AFTER all
 * API calls finish so the user sees what the run actually cost — useful
 * for catching estimates that were way off (e.g. lots of retries).
 */
export function tokenCost(inputTokens, outputTokens, model = "gpt-4o") {
  const r = MODEL_RATES[model] || MODEL_RATES["gpt-4o"];
  return (inputTokens * r.in + outputTokens * r.out) / 1_000_000;
}
