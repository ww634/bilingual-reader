// Translate an array of English clauses into pinyin (Mandarin) using OpenAI.
//
// Uses Chat Completions with structured outputs (json_schema) so the model
// is guaranteed to return a valid JSON object matching our schema. We also
// post-validate (count match, tone-mark presence, no Han characters).

import OpenAI from "openai";
import { pinyin } from "pinyin-pro";

// gpt-4.1 occasionally slips a Han character into otherwise-clean pinyin on
// dense literary text (e.g. "mùcái搭建" for "mùcái dājiàn"). Retrying the
// whole batch is slow and doesn't reliably converge, so we deterministically
// convert any stray Han run to tone-marked pinyin. Surrounding spaces are
// added so the converted reading doesn't fuse onto an adjacent pinyin word.
function hanToPinyin(text) {
  if (!text) return text;
  return text.replace(/[㐀-鿿]+/g, (han) => {
    const py = pinyin(han, { toneType: "symbol", type: "string" }).trim();
    return ` ${py} `;
  }).replace(/\s+/g, " ").trim();
}

const SYSTEM_PROMPT = `You are an expert literary translator producing a bilingual paired-line learning document.

You translate English clauses into Mandarin Chinese, rendered as PINYIN WITH TONE MARKS (never Chinese characters). The learner reads pinyin only.

Hard rules — non-negotiable:
1. PINYIN ONLY. Never include Chinese (Han) characters. Never include numbered pinyin (ma1, ma2). Only diacritic tone marks: ā á ǎ à, ē é ě è, ī í ǐ ì, ō ó ǒ ò, ū ú ǔ ù, ǖ ǘ ǚ ǜ.
2. EVERY syllable carries a tone mark unless it's a neutral-tone particle (then it carries no mark).
3. Word spacing follows standard pinyin orthography: syllables of a single word run together (e.g. "zhàndòu", "péngyǒu"), separate words are space-separated.
4. Each output pair has ONE English clause + its pinyin translation. Natural Chinese phrasing within the pair's scope, NOT word-for-word.
5. **MERGING short fragments — narrow, surgical.** The user gives you N English clauses as input HINTS. **Default behaviour: translate each clause as its OWN pair, one-to-one.** ONLY merge two ADJACENT clauses (never three) when ALL THREE conditions hold:
     (a) the first clause is grammatically incomplete on its own (e.g., ends in a determiner with no noun: "the rest of these"; or a verb with no object: "asked me to");
     (b) your Chinese translation of the first clause alone would have to borrow a content word from the next clause to be syntactically complete;
     (c) the merged pair would still be no longer than ~12 English words.
   When you merge, output ONE pair whose english is the concatenation of those two clauses (preserve internal whitespace/punctuation verbatim). Example to MERGE: "and the rest of these" + "gentlemen having asked me…" → one pair, because Chinese needs 先生们 with 这些. Example to NOT MERGE: "asked me to write down the whole" + "particulars about Treasure Island" → keep as TWO pairs (the first is grammatically complete on its own in Chinese with bǎ-construction). When in doubt, do NOT merge. Aggressive merging defeats the bilingual paired-line display the user is reading.
   Output pair count must be at least ceil(N × 0.8). If you find yourself wanting to merge more than ~20% of input clauses, you are over-merging — back off.
6. **No drift.** A pair's pinyin must ONLY translate the content of that pair's English. Do not invent words. Do not pull content from outside the pair's english span.
7. Proper nouns: transliterate to pinyin by default (e.g. "Sid" -> "Xī dé"). If a name has no obvious Chinese rendering, keep it in Latin script.
8. Preserve the punctuation feel: trailing comma/period/em-dash on the English clause should be reflected with appropriate Chinese pacing in the pinyin (you may omit terminal punctuation in the pinyin; the app re-wraps).
9. **English coverage.** The concatenation of all pair.english values (joined by single spaces) must, when whitespace is collapsed, equal the concatenation of the input clauses (likewise whitespace-collapsed). No clause may be dropped, reordered, or paraphrased.
10. You will be given the FULL chapter context so your phrasing is internally consistent (consistent name transliterations, consistent register).

Output: a JSON object matching the provided schema, with pairs in the same input order. Output count ≤ input count.`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pairs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          english: { type: "string", description: "The original English clause, verbatim." },
          target: { type: "string", description: "Mandarin translation, pinyin with tone marks, no Han characters." },
        },
        required: ["english", "target"],
      },
    },
  },
  required: ["pairs"],
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
const MAX_CLAUSES_PER_CALL = 100;

export function buildClient(apiKey) {
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Set it in your env: export OPENAI_API_KEY=sk-...");
  }
  return new OpenAI({ apiKey });
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

// Normaliser for the coverage check. We compare LETTER/DIGIT content only —
// every run of non-alphanumerics (spaces, quotes, dashes, pipes, smart
// punctuation) collapses to a single space. This is deliberately punctuation-
// insensitive: the translator legitimately normalises quote spacing and smart
// quotes (e.g. source `know.""No` → `know." No`), and we must NOT treat that
// as dropped content. Real word drops still change the letters and are caught.
function _normCoverage(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** True when the pairs' english, concatenated, reconstructs the input clauses. */
function _englishCoverageOk(clauses, pairs) {
  return _normCoverage(clauses.join(" ")) === _normCoverage(pairs.map((p) => p.english).join(" "));
}

/**
 * Per-batch health check for the issues a retry can plausibly fix:
 *   - dropped/paraphrased english (coverage gap)
 *   - a stray Han character in the pinyin (the model occasionally emits one
 *     instead of its pinyin, e.g. "yī句" for "yī jù")
 * Returns a short reason string when unhealthy, or null when clean.
 */
function _batchFault(clauses, pairs) {
  if (!_englishCoverageOk(clauses, pairs)) return "dropped/altered english";
  for (const p of pairs) {
    if (HAN_CHAR_RE.test(p.target)) return "Han characters in pinyin";
  }
  return null;
}

/**
 * Translate one batch, retrying when the model produces a fixable fault —
 * dropping input text, or slipping a Han character into the pinyin. LLMs do
 * this occasionally on long/dense batches; a retry with an explicit
 * corrective note almost always fixes it. Usage from every attempt is summed
 * so the cost report stays honest. After MAX_BATCH_TRIES we return the best
 * effort and let the caller's validatePairs surface it (and abort under strict).
 */
async function _translateBatchSafe(client, clauses, opts = {}) {
  const MAX_BATCH_TRIES = 3;
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let result;
  for (let attempt = 1; attempt <= MAX_BATCH_TRIES; attempt++) {
    result = await _translateClausesOnce(client, clauses, { ...opts, coverageRetry: attempt > 1 });
    usage.prompt_tokens     += result.usage?.prompt_tokens     || 0;
    usage.completion_tokens += result.usage?.completion_tokens || 0;
    usage.total_tokens      += result.usage?.total_tokens      || 0;
    const fault = _batchFault(clauses, result.pairs);
    if (!fault) break;
    if (attempt < MAX_BATCH_TRIES && opts.onCoverageRetry) {
      opts.onCoverageRetry(attempt, MAX_BATCH_TRIES, fault);
    }
  }
  return { pairs: result.pairs, usage };
}

/**
 * Translate one batch of clauses in a single OpenAI call. Internal — call
 * translateClauses() instead so long chapters are batched correctly.
 *
 * @param {OpenAI} client
 * @param {string[]} clauses
 * @param {object} opts {
 *   model,
 *   fullText,
 *   englishTitle,
 *   canonicalNames: [{ english: "Treasure Island", target: "Bǎozàng Dǎo" }, ...]
 *     — fixed translations that MUST be used verbatim wherever they appear.
 *     Critical for keeping the book title and recurring proper nouns
 *     consistent across the chapter.
 *   batchPosition: { index, total, startClause } — set by the batching
 *     wrapper to give the LLM context about where it is in the chapter.
 * }
 * @returns {Promise<{pairs: {english: string, target: string}[], usage: object}>}
 */
async function _translateClausesOnce(client, clauses, opts = {}) {
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

  // Injected only on a retry — the previous attempt had a fixable fault.
  // Demand complete verbatim english coverage AND strictly pinyin-only target
  // (the two things a retry can fix: dropped text, stray Han characters).
  const coverageNote = opts.coverageRetry
    ? "\n⚠ RETRY: your previous attempt had an error. You MUST: (1) reproduce EVERY clause's English verbatim across the pairs, in order, nothing dropped or reworded — the concatenation of all pair.english must equal the input clauses exactly (ignoring whitespace); AND (2) write the target as PINYIN ONLY with tone marks — absolutely no Han/Chinese characters anywhere (e.g. write \"yī jù\", never \"yī句\").\n"
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
    coverageNote,
    `Translate the following ${clauses.length} English clauses into pinyin pairs.`,
    "These clauses come from a regex split; treat them as HINTS for where to break pairs.",
    "If two adjacent clauses are grammatically incomplete on their own and merging them",
    "produces cleaner Chinese, MERGE them into a single pair (see system rule 5).",
    "Otherwise translate each clause as its own pair. Maintain input order. Pair count may be",
    "less than or equal to the input clause count — never greater.",
    "",
    "Clauses:",
    clauses.map((c, i) => `${i + 1}. ${c}`).join("\n"),
  ].join("\n");

  // gpt-5 family + o-series only accept default temperature (1) and require
  // max_completion_tokens instead of the legacy max_tokens.
  const isNewFamily = /^gpt-5|^o1|^o3/i.test(model);
  const tokenParamName = isNewFamily ? "max_completion_tokens" : "max_tokens";

  // Output-budget control + truncation recovery.
  //   - We set a ceiling so the model can't silently run away on cost, and
  //     so that hitting the ceiling is a CLEAN error rather than a half-
  //     truncated JSON parse failure.
  //   - If the model hits the cap (finish_reason === "length"), give the
  //     caller one chance to bump the limit via opts.onTruncation. That
  //     callback returns a new (larger) limit, or null/false to abort.
  let tokenBudget = opts.maxResponseTokens || MAX_RESPONSE_TOKENS_DEFAULT;
  for (let attempt = 1; ; attempt++) {
    const request = {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "translation_pairs",
          strict: true,
          schema: RESPONSE_SCHEMA,
        },
      },
      [tokenParamName]: tokenBudget,
    };
    if (!isNewFamily) request.temperature = 0.2;
    const response = await client.chat.completions.create(request);

    // Truncation guard. When response_format is json_schema, a truncated
    // response is unparseable — half-JSON. Surface a clear error and let
    // the caller decide whether to retry with a larger budget.
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

    const content = response.choices[0].message.content;
    const parsed = JSON.parse(content);
    // Deterministically scrub any stray Han characters out of the pinyin.
    const pairs = (parsed.pairs || []).map((p) => ({
      english: p.english,
      target: hanToPinyin(p.target),
    }));
    return { pairs, usage: response.usage };
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
    ? "\n\nFor this task you are translating a BOOK TITLE. Translate ONLY the title itself — do NOT add chapter prefixes like 'Dì <number> zhāng:' or any structural framing. Use the standard or most natural Mandarin rendering of the book's name."
    : "\n\nFor this task you are translating a CHAPTER TITLE. Use standard chapter-title phrasing (e.g. 'Dì <number> zhāng: <title>'). Same pinyin rules.";

  const isNewFamily = /^gpt-5|^o1|^o3/i.test(model);
  const request = {
    model,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT + titleGuidance,
      },
      {
        role: "user",
        content: `Translate this ${isBookTitle ? "book" : "chapter"} title to pinyin with tone marks:\n\n"${englishTitle}"\n\nReturn JSON: { "english": "...", "target": "..." } — english is the original verbatim.`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "title_pair",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            english: { type: "string" },
            target: { type: "string" },
          },
          required: ["english", "target"],
        },
      },
    },
  };
  if (!isNewFamily) request.temperature = 0.2;
  const response = await client.chat.completions.create(request);
  return JSON.parse(response.choices[0].message.content);
}

/**
 * Validate a batch of pairs. Returns { ok, problems }.
 *
 * The translator may now MERGE adjacent input clauses (pair count ≤ input
 * clause count), so we no longer require strict count match. Instead we
 * check that the concatenation of all pair.english (whitespace-collapsed)
 * matches the concatenation of all input clauses (whitespace-collapsed).
 * That catches clause-dropping or paraphrasing.
 */
// Minimum fraction of input clauses that should survive into output pairs.
// Below this we treat the translator as having over-merged. Empirically the
// prompt asks for ≥80% retention; 0.7 gives a little headroom for genuine
// surgical merges without letting the LLM collapse a whole chapter into ~40%
// of its input.
const MIN_RETENTION_RATIO = 0.7;

export function validatePairs(inputClauses, pairs) {
  const problems = [];
  if (pairs.length > inputClauses.length) {
    problems.push(`Pair count grew: input ${inputClauses.length}, output ${pairs.length} (translator should never increase pair count)`);
  }
  // Hard floor on merging. The prompt asks for ≤20% merging; in practice the
  // LLM ignores that on long sections, and a chapter with 40% retention means
  // hundreds of input clauses were silently merged or dropped.
  const minPairs = Math.ceil(inputClauses.length * MIN_RETENTION_RATIO);
  if (pairs.length < minPairs) {
    const pct = ((pairs.length / inputClauses.length) * 100).toFixed(0);
    problems.push(
      `Translator over-merged: ${pairs.length} pairs from ${inputClauses.length} input clauses (${pct}% retained, need ≥${(MIN_RETENTION_RATIO * 100).toFixed(0)}%). ` +
      `The chapter is probably too long for one translator call — split it into smaller sections.`
    );
  }
  // Coverage check: the union of pair.english should reconstruct the input's
  // LETTER content. We compare via _normCoverage (alphanumerics only) so the
  // translator's legitimate punctuation/quote/spacing normalisation isn't
  // mistaken for dropped words. Real word drops still change the letters.
  const expected = _normCoverage(inputClauses.join(" "));
  const actual = _normCoverage(pairs.map((p) => p.english).join(" "));
  if (expected !== actual) {
    // Find the first divergence so the error message is actionable.
    let i = 0;
    while (i < expected.length && i < actual.length && expected[i] === actual[i]) i++;
    const ctx = (s, at) => s.slice(Math.max(0, at - 20), Math.min(s.length, at + 30));
    problems.push(
      `English coverage mismatch at char ${i}:\n` +
      `  expected …${ctx(expected, i)}…\n` +
      `  got      …${ctx(actual, i)}…`
    );
  }
  pairs.forEach((p, i) => {
    if (HAN_CHAR_RE.test(p.target)) {
      problems.push(`Pair ${i + 1}: contains Han characters: "${p.target}"`);
    }
    if (!TONE_MARK_RE.test(p.target)) {
      problems.push(`Pair ${i + 1}: no tone marks detected: "${p.target}"`);
    }
    if (/\d(?![\d])/.test(p.target) && /[a-zA-Z]\d/.test(p.target)) {
      problems.push(`Pair ${i + 1}: looks like numbered pinyin (ma1/ma2): "${p.target}"`);
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
