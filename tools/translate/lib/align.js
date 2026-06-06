// Word-level alignment between English clauses and their Chinese (Hanzi)
// translations.
//
// Runs AFTER translation. For each {english, hanzi} pair, the LLM aligns
// English spans to Hanzi spans (its native form — far more reliable than
// aligning to pinyin). We then romanize each chunk's Hanzi span to pinyin
// with the SAME romanizer used for the pair, so pair-pinyin and chunk-pinyin
// match exactly. Output is the data layer for the colour-coded reader,
// tap-to-learn, and the category toggles.
//
// We batch pairs so a single chapter doesn't depend on one huge response.

import { romanizeWithMap, chunkPinyinFromPair } from "./romanize.js";

const ALIGN_SYSTEM_PROMPT = `You are a bilingual annotator producing FINE-GRAINED word-level alignment between English clauses and their Simplified Chinese (Hanzi) translations. A learner taps individual Chinese words to look them up and sees colour-coded mappings to English, and uses category toggles to fade out grammatical scaffolding. So every word with a recognisable role MUST get its own chunk and category; the "uncategorised" bucket should be tiny.

For each (english, target) pair — where "target" is CHINESE CHARACTERS — return a list of CHUNKS. Each chunk maps one small Chinese unit to its English counterpart.

GRANULARITY — the most common failure mode:
A chunk's TARGET is usually ONE Chinese word (1–2 characters), occasionally a 3–4 character compound or idiom. Do NOT lump multiple content words into one chunk. Each noun, verb, adjective, adverb gets its OWN chunk; each pronoun, preposition, conjunction, auxiliary, measure word, or particle also gets its own chunk.

CATEGORIES (use the most specific one that applies):
- "noun"          — things (书 book, 父亲 father, 时候 time).
- "verb"          — actions / states (吃 eat, 经营 ran, 成为 became).
- "adjective"     — describes a noun (老 old, 蓝 blue).
- "adverb"        — describes a verb/adjective (很 very, 常常 often).
- "idiom"         — genuine 4-character chengyu or fixed set phrase. is_idiom true.
- "proper_noun"   — transliterated names of people/places/orgs (特雷洛尼 Trelawney).
- "function_word" — pronouns (我/你/他/我们), articles/determiners, prepositions (在/和/对/给), conjunctions (和/但是/或者/因为), auxiliaries/copulas (是/会/能/被). e.g. 我→"I", 在→"at", 是→"is".
- "measure_word"  — classifiers (个/本/条/只/张/块/杯…) with their English determiner. e.g. 一本→"a"/"one", 三只→"three".
- "particle"      — structural/aspect/modal particles with no clean English content word: 了/着/过/的/把/被/吗/呢/吧. English side = closest scaffolding word the particle implies (了→"did"/"have", 的→"'s"/"of", 把→"took") — NEVER empty.
- "grammar"       — legacy bucket. AVOID; use a specific category above.

GOOD example (fine-grained):
  english: "my father kept the Admiral Benbow Inn"
  target:  "我父亲经营本葆将官旅馆"
  chunks:
    { english: "my",                 target: "我",        category: "function_word" }
    { english: "father",             target: "父亲",      category: "noun" }
    { english: "kept",               target: "经营",      category: "verb" }
    { english: "the Admiral Benbow", target: "本葆将官",  category: "proper_noun" }
    { english: "Inn",                target: "旅馆",      category: "noun" }

BAD (too coarse — DO NOT): one chunk { english:"my father kept the Admiral Benbow Inn", target:"我父亲经营本葆将官旅馆" }. Always break content words apart.

Hard rules:
1. Each chunk has a non-empty "english" span and a non-empty "target" (Chinese characters) span.
2. PAIR BOUNDARIES ARE HARD. chunk.english MUST be a contiguous substring of THIS pair's english (case-insensitive). chunk.target MUST be a contiguous substring of THIS pair's Chinese. NEVER borrow words from neighbouring pairs. If a Chinese word seems to map to an English word that lives in a different pair, attach the closest in-pair English or leave it; never invent.
3. Chunks appear in the order of the TARGET (Chinese) clause, left to right.
4. Prefer ONE Chinese word per chunk. Never split a single word across chunks.
5. Cover every English content word; attach function words/articles to the Chinese word they bind to.
6. Every chunk gets a "frequency_band": "very_common" (HSK 1-2), "common" (HSK 3-4), "uncommon" (HSK 5-6), "rare" (beyond HSK 6 / literary). null for proper nouns and idioms.
7. "is_idiom": true ONLY for genuine chengyu / set phrases.

Output: a flat array of chunks per pair, in target (Chinese) order.`;

const ALIGN_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    alignments: {
      type: "array",
      description: "One entry per input pair, in input order.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          pair_index: {
            type: "integer",
            description: "Zero-based index of the pair this alignment belongs to (matches input order).",
          },
          chunks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                english: { type: "string", description: "English span. Cannot be empty." },
                target: { type: "string", description: "Chinese-character (Hanzi) span, a contiguous substring of the pair's Chinese. Cannot be empty." },
                category: {
                  type: "string",
                  enum: [
                    "noun",
                    "verb",
                    "adjective",
                    "adverb",
                    "idiom",
                    "proper_noun",
                    "function_word",
                    "measure_word",
                    "particle",
                    // "grammar" kept as a legacy fallback so old prompts /
                    // re-runs against existing data don't fail validation.
                    "grammar",
                  ],
                },
                frequency_band: {
                  type: ["string", "null"],
                  enum: ["very_common", "common", "uncommon", "rare", null],
                },
                is_idiom: { type: "boolean" },
              },
              required: ["english", "target", "category", "frequency_band", "is_idiom"],
            },
          },
        },
        required: ["pair_index", "chunks"],
      },
    },
  },
  required: ["alignments"],
};

const CATEGORY_ENUM = new Set([
  "noun",
  "verb",
  "adjective",
  "adverb",
  "idiom",
  "proper_noun",
  "function_word",
  "measure_word",
  "particle",
  "grammar", // legacy
]);
const FREQ_ENUM = new Set(["very_common", "common", "uncommon", "rare"]);

// Fine-grained alignment produces ~5-7 chunks per pair, each chunk ~80 JSON
// chars. At batch=15 we routinely exceeded gpt-4o's response token budget.
// 6 pairs ≈ 35-50 chunks ≈ 3-4k output tokens, well within limits.
const DEFAULT_BATCH_SIZE = 6;
const MAX_RESPONSE_TOKENS = 8000;
// How many extra single-pair passes we attempt for any pair whose batch
// alignment fails HARD validation. Default 0 — retries don't change the
// headline feature (pinyin colouring is ~100% on the first pass); they only
// nudge English-highlight coverage by a couple points while burning a lot of
// rate-limited tokens. For whole-book runs that's a bad trade. Opt back in
// per-run with --align-retries <n> when polishing a single chapter.
const DEFAULT_MAX_RETRIES_PER_PAIR = 0;

/**
 * Align a batch of pairs in one OpenAI call.
 * @param {OpenAI} client
 * @param {Array<{english: string, target: string}>} pairs
 * @param {{model?: string, englishTitle?: string}} opts
 * @returns {Promise<{alignments: Array<{pair_index: number, chunks: Array}>, usage: object}>}
 */
async function alignBatch(client, pairs, opts = {}) {
  const model = opts.model || "gpt-4o";
  const englishTitle = opts.englishTitle || "(untitled)";

  // When this batch is a retry of pairs that previously hallucinated, the
  // caller can inject extra emphasis into the user prompt. Empty for the
  // first pass; populated by alignAll on retries.
  const retryNote = opts.retryContext
    ? "\n\n⚠ STRICT MODE: the previous attempt produced chunks whose english or Chinese target was NOT a substring of the pair. Every chunk.english MUST be a verbatim substring (case-insensitive) of THIS pair's english; every chunk.target MUST be a verbatim substring of THIS pair's Chinese. If you cannot find a clean alignment, return fewer chunks rather than inventing.\n"
    : "";

  const userPrompt = [
    `Chapter title: ${englishTitle}`,
    retryNote,
    "",
    `Align the following ${pairs.length} translated pair${pairs.length === 1 ? "" : "s"}. The "target" is Chinese characters. Return one alignment entry per pair, in the same order, with pair_index 0..${pairs.length - 1}.`,
    "",
    "Pairs:",
    pairs.map((p, i) =>
      `${i}.\n  english: ${p.english}\n  target:  ${p.hanzi}`
    ).join("\n\n"),
  ].join("\n");

  // gpt-5 family + o-series models have stricter parameter rules:
  //   - require max_completion_tokens instead of max_tokens
  //   - only accept the default temperature (1); omit explicit temperature
  // Branch defensively so older models still work.
  const isNewFamily = /^gpt-5|^o1|^o3/i.test(model);
  const tokenParamName = isNewFamily ? "max_completion_tokens" : "max_tokens";

  const request = {
    model,
    messages: [
      { role: "system", content: ALIGN_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "alignment_pairs",
        strict: true,
        schema: ALIGN_RESPONSE_SCHEMA,
      },
    },
    [tokenParamName]: MAX_RESPONSE_TOKENS,
  };
  if (!isNewFamily) request.temperature = 0.1;

  const response = await client.chat.completions.create(request);

  // Guard against truncation: if the model hit max_tokens, the JSON will be
  // invalid and downstream parse will fail. Surface a clearer error.
  if (response.choices[0].finish_reason === "length") {
    throw new Error(
      `OpenAI response truncated by max_tokens (${MAX_RESPONSE_TOKENS}). ` +
      `Reduce batch size below ${pairs.length} pairs.`
    );
  }

  const parsed = JSON.parse(response.choices[0].message.content);
  // The LLM returned each chunk's target as Chinese characters. Promote that
  // to `hanzi`, and derive `target` (pinyin) by SLICING the pair's
  // context-romanized pinyin — so polyphones (了→le vs liǎo) stay correct and
  // chunk pinyin is always an exact substring of the pair pinyin.
  for (const a of parsed.alignments || []) {
    const pair = pairs[a.pair_index];
    const map = pair ? romanizeWithMap(pair.hanzi || "") : null;
    for (const c of a.chunks || []) {
      c.hanzi = (c.target || "").trim();
      c.target = map ? chunkPinyinFromPair(pair.hanzi || "", c.hanzi, map) : "";
    }
  }
  return { alignments: parsed.alignments, usage: response.usage };
}

// Content categories: words a learner actually looks up. For these, an
// english span that isn't in the pair signals real cross-pair drift worth a
// retry. For the grammatical categories (function_word/particle/measure_word/
// grammar), the aligner legitimately emits a dictionary-form GLOSS that often
// isn't a verbatim substring of the sentence (e.g. particle 把 → "took",
// 的 → "of"). Those degrade gracefully in the reader (the pinyin still colors
// via the target side; only the english highlight is skipped), so we don't
// retry on them — chasing them was burning hours of rate-limited retries for
// no rendering benefit.
const CONTENT_CATEGORIES = new Set(["noun", "verb", "adjective", "adverb", "idiom", "proper_noun"]);

// A target made only of punctuation/symbols can't be located in the pinyin
// and doesn't matter (it's not a tappable/colorable word).
function isPunctuationOnly(s) {
  return !/[a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ0-9]/i.test(s || "");
}

// Function words carry no overlap signal — "a"/"the"/"of" appear everywhere,
// so requiring them to overlap would pass everything. We judge overlap only
// on meaningful (content) tokens.
const OVERLAP_STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "and", "or", "but", "in", "on", "at", "by",
  "is", "was", "were", "are", "be", "been", "it", "i", "he", "she", "we",
  "they", "you", "his", "her", "my", "our", "their", "that", "this", "as",
  "for", "with", "from", "had", "has", "have", "did", "do",
]);

function tokensOf(s) {
  return (String(s).toLowerCase().match(/[a-z']+/g) || []);
}

/**
 * Does the chunk's english share a MEANINGFUL token with the pair's english?
 *
 * Used to tell lemmatization ("keep back" vs sentence "keeping...back" — they
 * share "back" and "keep"~"keeping" by 4-char prefix) apart from true
 * cross-pair drift ("finished" when that word lives in another pair — zero
 * shared tokens). Prefix matching absorbs English inflection (-ed/-ing/-s).
 *
 * Returns true (= benign / overlaps) when the chunk has only stopwords to
 * compare with — we can't judge those, and per the Chinese-omits-words point
 * they're glosses anyway.
 */
function hasTokenOverlap(chunkEng, pairEng) {
  const ctoks = tokensOf(chunkEng).filter((t) => t.length >= 3 && !OVERLAP_STOPWORDS.has(t));
  if (ctoks.length === 0) return true;
  const ptoks = tokensOf(pairEng);
  for (const c of ctoks) {
    for (const p of ptoks) {
      if (c === p) return true;
      const n = Math.min(4, c.length, p.length);
      if (n >= 3 && c.slice(0, n) === p.slice(0, n)) return true;
    }
  }
  return false;
}

/**
 * Validate a single alignment entry. Returns { hard, soft } problem lists.
 *
 *   hard — issues that justify a (rate-limited, costly) solo retry: the pinyin
 *          target can't be located (breaks coloring), a content word drifted
 *          in from another pair, empty chunks, invalid category.
 *   soft — benign issues we only surface as warnings: grammatical-word english
 *          glosses that aren't verbatim, punctuation targets, granularity.
 *
 * The split is the whole point of the relaxed-validation rework: target
 * accuracy is what drives the reader, and it's near-perfect, so retries should
 * be rare.
 */
function validateAlignment(alignment, originalPair) {
  const hard = [];
  const soft = [];
  if (!Array.isArray(alignment.chunks) || alignment.chunks.length === 0) {
    hard.push("no chunks returned");
    return { hard, soft };
  }
  const pairEnglishLower = (originalPair?.english || "").toLowerCase();
  const pairHanzi = originalPair?.hanzi || "";
  alignment.chunks.forEach((c, i) => {
    if (!c.english || !c.hanzi) hard.push(`chunk ${i}: empty english or hanzi`);
    if (!CATEGORY_ENUM.has(c.category)) hard.push(`chunk ${i}: invalid category "${c.category}"`);
    if (c.frequency_band !== null && !FREQ_ENUM.has(c.frequency_band)) {
      soft.push(`chunk ${i}: invalid frequency_band "${c.frequency_band}"`);
    }
    if (typeof c.is_idiom !== "boolean") soft.push(`chunk ${i}: is_idiom not boolean`);

    // Granularity — soft. A too-coarse Chinese chunk (≥6 chars) is still usable.
    const hanLen = [...(c.hanzi || "")].length;
    if (hanLen >= 6 && c.category !== "idiom" && c.category !== "proper_noun") {
      soft.push(`chunk ${i}: too coarse (${hanLen} chars for "${c.hanzi}")`);
    }

    // English-substring check. HARD only for content words (where a missing
    // span means a real vocab item drifted in from another pair). SOFT for
    // grammatical categories (expected gloss mismatch / lemmatization).
    if (c.english) {
      const en = c.english.toLowerCase().trim();
      if (en && !pairEnglishLower.includes(en)) {
        const msg = `chunk ${i}: english "${c.english}" not in pair english`;
        if (CONTENT_CATEGORIES.has(c.category) && !hasTokenOverlap(en, pairEnglishLower)) {
          hard.push(msg);
        } else {
          soft.push(msg);
        }
      }
    }

    // Hanzi-substring check. The chunk's Chinese MUST be a contiguous substring
    // of the pair's Chinese — otherwise the LLM invented/drifted it and we
    // can't romanize-align it. HARD (this is what drives colouring).
    if (c.hanzi) {
      const han = c.hanzi.trim();
      if (han && !pairHanzi.includes(han)) {
        hard.push(`chunk ${i}: hanzi "${c.hanzi}" not in pair hanzi`);
      }
    }
  });
  return { hard, soft };
}

/**
 * Align all pairs in a chapter, batching to keep individual API calls small
 * and recoverable.
 *
 * @param {OpenAI} client
 * @param {Array<{english: string, target: string}>} pairs
 * @param {{model?: string, batchSize?: number, englishTitle?: string, onProgress?: (i: number, total: number) => void}} opts
 * @returns {Promise<{aligned: Array<{english: string, target: string, alignment: Array}>, totalTokens: number, problems: string[]}>}
 */
export async function alignAll(client, pairs, opts = {}) {
  const batchSize = opts.batchSize || DEFAULT_BATCH_SIZE;
  // Seed `out` from the input pairs, PRESERVING any alignment they already
  // carry. This is what makes alignment resumable: a re-run passes in pairs
  // that were partially aligned before an interruption, and we only call the
  // API for batches that still need it.
  const out = pairs.map((p) => ({ ...p }));
  const hasAlignment = (p) => Array.isArray(p && p.alignment) && p.alignment.length > 0;
  let totalTokens = 0;
  // Split-tracked so callers can compute accurate cost (input and output
  // tokens are priced at different rates).
  let totalIn = 0;
  let totalOut = 0;
  const problems = [];

  // Track which pairs need retrying — populated during the initial batched
  // pass when validateAlignment flags HARD problems (target miss / content-
  // word drift). Soft problems (grammatical glosses) are counted but not
  // retried.
  const failedPairs = []; // [{ globalIdx }]
  let softProblemCount = 0;

  for (let start = 0; start < pairs.length; start += batchSize) {
    const slice = pairs.slice(start, start + batchSize);
    const batchIndex = Math.floor(start / batchSize) + 1;
    const totalBatches = Math.ceil(pairs.length / batchSize);
    if (opts.onProgress) opts.onProgress(batchIndex, totalBatches);

    // Resume: if every pair in this batch is already aligned, skip the API.
    if (slice.every(hasAlignment)) continue;

    let result;
    try {
      result = await alignBatch(client, slice, opts);
    } catch (err) {
      problems.push(`batch ${batchIndex}: ${err.message}`);
      // Fall back to no alignment for this batch's pairs
      for (let i = 0; i < slice.length; i++) {
        out[start + i] = { ...slice[i], alignment: null };
      }
      continue;
    }
    totalTokens += result.usage?.total_tokens || 0;
    totalIn  += result.usage?.prompt_tokens || 0;
    totalOut += result.usage?.completion_tokens || 0;

    // Map alignments back by pair_index
    const byIndex = new Map();
    for (const a of result.alignments) byIndex.set(a.pair_index, a);
    for (let i = 0; i < slice.length; i++) {
      const a = byIndex.get(i);
      if (!a) {
        problems.push(`batch ${batchIndex}, pair ${i}: missing alignment in response`);
        out[start + i] = { ...slice[i], alignment: null };
        continue;
      }
      const { hard, soft } = validateAlignment(a, slice[i]);
      // Only HARD problems trigger a (costly, rate-limited) solo retry.
      if (hard.length > 0) {
        problems.push(`batch ${batchIndex}, pair ${i}: ${hard.join("; ")}`);
        failedPairs.push({ globalIdx: start + i });
      }
      // SOFT problems are surfaced as low-key warnings but never retried —
      // they're benign (grammatical-word glosses, punctuation, granularity).
      softProblemCount += soft.length;
      out[start + i] = { ...slice[i], alignment: a.chunks };
    }

    // Checkpoint after each batch so an interruption resumes instead of
    // losing the whole chapter's alignment work.
    if (opts.onBatchSaved) await opts.onBatchSaved(out);
  }

  // Retry pass: any pair whose initial alignment failed validation gets
  // re-aligned alone (batch of 1, so the model can't borrow content from
  // neighbouring pairs). The retryContext flag injects a stricter system
  // message. We accept the retry result only if it validates clean —
  // otherwise we keep the original (imperfect) alignment so the user still
  // has something to render.
  let retryCalls = 0;
  let retryFixes = 0;
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : DEFAULT_MAX_RETRIES_PER_PAIR;
  if (failedPairs.length > 0 && maxRetries > 0 && opts.onRetry) {
    opts.onRetry(failedPairs.length);
  }
  for (const { globalIdx } of (maxRetries > 0 ? failedPairs : [])) {
    const originalPair = pairs[globalIdx];
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let retryResult;
      try {
        retryResult = await alignBatch(client, [originalPair], {
          ...opts,
          retryContext: true,
        });
        retryCalls++;
        totalTokens += retryResult.usage?.total_tokens || 0;
        totalIn  += retryResult.usage?.prompt_tokens || 0;
        totalOut += retryResult.usage?.completion_tokens || 0;
      } catch (err) {
        problems.push(`retry ${attempt} for pair ${globalIdx}: ${err.message}`);
        break;
      }
      const a = retryResult.alignments.find((x) => x.pair_index === 0);
      if (!a) continue;
      const { hard } = validateAlignment(a, originalPair);
      if (hard.length === 0) {
        out[globalIdx] = { ...originalPair, alignment: a.chunks };
        retryFixes++;
        // Remove the corresponding "batch X, pair Y: ..." problem from the
        // list so the final summary reflects what's actually broken.
        const tag = `pair ${globalIdx % batchSize}: `;
        const idx = problems.findIndex((p) => p.includes(tag));
        if (idx !== -1) problems.splice(idx, 1);
        break;
      }
    }
  }

  return {
    aligned: out,
    totalTokens,
    inputTokens: totalIn,
    outputTokens: totalOut,
    problems,
    softProblemCount,
    retryStats: { calls: retryCalls, fixes: retryFixes, candidates: failedPairs.length },
  };
}

/**
 * Cost estimate for alignment of N pairs at average ~50 chars per pair.
 */
export function estimateAlignmentCost(pairs, model = "gpt-4o") {
  const inputChars = pairs.reduce((a, p) => a + p.english.length + p.target.length, 0) + 600 * Math.ceil(pairs.length / DEFAULT_BATCH_SIZE);
  // Each chunk output is roughly 80 chars JSON. Assume ~5 chunks per pair.
  const outputChars = pairs.length * 5 * 80;
  const inputTokens = inputChars / 1.3;
  const outputTokens = outputChars / 1.3;
  const RATES = {
    "gpt-4o": { in: 5, out: 20 },
    "gpt-4o-mini": { in: 0.15, out: 0.60 },
    "gpt-4.1": { in: 2, out: 8 },
    "gpt-4.1-mini": { in: 0.40, out: 1.60 },
    "gpt-4.1-nano": { in: 0.10, out: 0.40 },
    "gpt-5": { in: 5, out: 20 },
    "gpt-5-mini": { in: 0.50, out: 2.00 },
    "gpt-5-nano": { in: 0.05, out: 0.40 },
    "gpt-5.4-mini": { in: 0.50, out: 2.00 },
    "gpt-5.4-nano": { in: 0.05, out: 0.40 },
  };
  const r = RATES[model] || RATES["gpt-4o"];
  const cost = (inputTokens * r.in + outputTokens * r.out) / 1_000_000;
  return { inputTokens: Math.round(inputTokens), outputTokens: Math.round(outputTokens), cost };
}
