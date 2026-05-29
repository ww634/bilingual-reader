// Word-level alignment between English clauses and their pinyin translations.
//
// Runs AFTER translation. For each {english, target} pair, the LLM returns
// a list of "chunks" — small contiguous spans of both languages that map to
// each other — plus category and frequency_band tags. The output of this
// module is the data layer for color-coded reader, tap-to-learn, and the
// intensity toggle features.
//
// We batch pairs (~15 at a time) so a single chapter doesn't depend on one
// huge response, but a failed batch is easy to retry.

const ALIGN_SYSTEM_PROMPT = `You are a bilingual annotator producing FINE-GRAINED word-level alignment between English clauses and their Mandarin Chinese pinyin translations. A learner will tap individual pinyin words to look them up and see color-coded mappings to English. The learner uses category toggles to fade out grammatical scaffolding (function words, particles, measure words) and concentrate on content words — so every word that has a recognisable role MUST get a chunk and a category. The "uncategorised" bucket should be tiny.

For each (english, target) pair, you return a list of CHUNKS. Each chunk maps one small unit of pinyin to its English counterpart.

GRANULARITY — read carefully, this is the most common failure mode:
A chunk's TARGET should usually be 1 pinyin word, occasionally 2, never more than 3 except for genuine multi-word idioms or proper-noun phrases.
Do NOT lump multiple content words into one chunk. Each noun, verb, adjective, adverb gets its OWN chunk. Each pronoun, preposition, conjunction, auxiliary, measure word, or particle also gets its own chunk.

CATEGORIES (use the most specific one that applies):
- "noun"          — concrete or abstract things. Plain English nouns (book, father, time).
- "verb"          — actions and state changes. Plain English verbs (eat, kept, became).
- "adjective"     — describes a noun (old, blue, brown-faced).
- "adverb"        — describes a verb / adjective (quickly, very, often).
- "idiom"         — genuine 4-character chengyu or fixed set phrase. is_idiom must be true.
- "proper_noun"   — transliterated names of people, places, organisations.
- "function_word" — pronouns (I, you, he, she, we, my, his), articles (a, an, the), prepositions (in, of, with, by, to), conjunctions (and, but, or, while, because, when), auxiliaries / copulas (is, was, were, will, can, have/has as helper). Both sides count: 我/wǒ → "I" is function_word; 在/zài → "at" is function_word; 是/shì → "is" is function_word.
- "measure_word"  — Chinese classifiers (个/gè, 本/běn, 条/tiáo, 只/zhī, 张/zhāng, 块/kuài, 杯/bēi, etc) paired with their English determiner ("a", "one", "the", a number). Examples: "一本"/yì běn → "a" or "one" (measure_word); "三只" → "three" (measure_word).
- "particle"      — Mandarin structural / aspect / modal particles with no clean English content word: 了/le, 着/zhe, 过/guò, 的/de (possessive or attributive), 把/bǎ, 被/bèi, 吗/ma, 呢/ne, 吧/ba, 嘛/ma. The English side should be the closest scaffolding word the particle implies (e.g. 了 → "did" or "have", 的 → "'s" or "of", 把 → "took") — NEVER empty.
- "grammar"       — legacy bucket. AVOID. Only use if you genuinely cannot decide between function_word / particle / measure_word.

GOOD example (fine-grained, fully categorised):
  english: "my father kept the Admiral Benbow Inn"
  target:  "wǒ fùqīn kāi Zhǎngguān Bēnbǎo lǚguǎn"
  chunks:
    { english: "my",                  target: "wǒ",                 category: "function_word" }
    { english: "father",              target: "fùqīn",              category: "noun" }
    { english: "kept",                target: "kāi",                category: "verb" }
    { english: "the Admiral Benbow",  target: "Zhǎngguān Bēnbǎo",   category: "proper_noun" }
    { english: "Inn",                 target: "lǚguǎn",             category: "noun" }

GOOD example with measure word + particle:
  english: "I have a book"
  target:  "wǒ yǒu yì běn shū"
  chunks:
    { english: "I",     target: "wǒ",     category: "function_word" }
    { english: "have",  target: "yǒu",    category: "verb" }
    { english: "a",     target: "yì běn", category: "measure_word" }
    { english: "book",  target: "shū",    category: "noun" }

  english: "he ate it"
  target:  "tā chī le"
  chunks:
    { english: "he",   target: "tā",   category: "function_word" }
    { english: "ate",  target: "chī",  category: "verb" }
    { english: "did",  target: "le",   category: "particle" }   // 了 marks completed action

BAD example (too coarse — DO NOT do this):
  { english: "my father kept the Admiral Benbow Inn",
    target:  "wǒ fùqīn kāi Zhǎngguān Bēnbǎo lǚguǎn",
    category: "noun" }
^ a single 7-word chunk is useless for tap-to-learn. Always break content words apart.

Hard rules:
1. Each chunk has both an "english" span and a "target" pinyin span — neither empty.
2. **Pair boundaries are hard.** Each chunk's "english" MUST be a contiguous substring of THAT pair's English clause (case-insensitive). Each chunk's "target" MUST be a contiguous substring of THAT pair's pinyin. Do NOT borrow words from neighbouring pairs in the same batch. If a Chinese word in this pair seems to correspond to an English word that lives in a different pair, leave it as an unmatched fragment or pick the closest in-pair English; do not invent the missing word.
3. Chunks appear in the order of the TARGET (pinyin) clause, left to right.
4. Pinyin chunks respect standard pinyin word boundaries: syllables of one Chinese word run together (e.g. "zhàndòu", "péngyǒu"), separate words are space-separated. Do NOT split a single pinyin word across two chunks.
5. PREFER 1 pinyin word per chunk. 2 is acceptable when they form an inseparable unit (e.g. "shíhòu" = "time/when", or "yì běn" = measure-word + numeral). 3+ pinyin words in one chunk requires a strong reason (genuine fixed expression, transliterated proper noun phrase).
6. EVERY word in the English clause should belong to some chunk's english span — function words and articles included. Do not silently drop "the", "a", "of", "and", etc. Find the Chinese word they bind to (often a measure word, particle, or content word) and attach them there.
7. If the English contains genuine translator glue with NO Chinese counterpart (rare — only when an extra word was added purely to make English grammatical), it is OK to leave a one- or two-word run uncovered, but this should be rare. Categorising into function_word / particle / measure_word is almost always possible.
8. Every chunk gets a "frequency_band": one of "very_common" (HSK 1-2), "common" (HSK 3-4), "uncommon" (HSK 5-6), "rare" (beyond HSK 6 / literary). Use null for proper nouns and idioms.
9. "is_idiom": true ONLY for genuine 4-character chengyu or other set phrases. False for ordinary multi-word translations.

Edge cases:
- Pronoun + possessive marker: "my" → wǒ de should be ONE function_word chunk, target "wǒ de", english "my". (Or two chunks: wǒ/I + de/'s. Either is acceptable; prefer the two-chunk form so each piece is learnable.)
- Multi-syllable proper nouns ("Zhǎngguān Bēnbǎo lǚguǎn" = "Admiral Benbow Inn") may be one chunk for the name portion, but the generic noun ("lǚguǎn" = "Inn") should be its OWN chunk so the user can learn "inn" separately.
- English determiner attached to a measure word: prefer to put the determiner on the measure_word chunk, not the noun. So "a book" → ["a"/"yì běn" measure_word, "book"/"shū" noun] rather than ["a book"/"yì běn shū"].
- Auxiliary + verb: "has eaten" → split if possible ("has" → function_word matching context like 已经/yǐjīng or aspect particle; "eaten" → verb). If Chinese collapses them into one verb ("chīle"), keep them together as a verb chunk with english "has eaten".

Output: a flat array of chunks per pair, in target order.`;

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
                target: { type: "string", description: "Pinyin span (orthographic word boundaries). Cannot be empty." },
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

  const userPrompt = [
    `Chapter title: ${englishTitle}`,
    "",
    `Align the following ${pairs.length} translated pairs. Return one alignment entry per pair, in the same order, with pair_index 0..${pairs.length - 1}.`,
    "",
    "Pairs:",
    pairs.map((p, i) =>
      `${i}.\n  english: ${p.english}\n  target:  ${p.target}`
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
  return { alignments: parsed.alignments, usage: response.usage };
}

/**
 * Validate a single alignment entry. Returns array of problem strings (empty if OK).
 *
 * Includes a granularity check: warn if alignment is too coarse (single-chunk
 * pairs with 4+ pinyin words usually indicate the LLM lumped content words).
 */
function validateAlignment(alignment, originalPair) {
  const problems = [];
  if (!Array.isArray(alignment.chunks) || alignment.chunks.length === 0) {
    problems.push("no chunks returned");
    return problems;
  }
  const pairEnglishLower = (originalPair?.english || "").toLowerCase();
  const pairTargetLower = (originalPair?.target || "").toLowerCase();
  alignment.chunks.forEach((c, i) => {
    if (!c.english || !c.target) problems.push(`chunk ${i}: empty english or target`);
    if (!CATEGORY_ENUM.has(c.category)) problems.push(`chunk ${i}: invalid category "${c.category}"`);
    if (c.frequency_band !== null && !FREQ_ENUM.has(c.frequency_band)) {
      problems.push(`chunk ${i}: invalid frequency_band "${c.frequency_band}"`);
    }
    if (typeof c.is_idiom !== "boolean") problems.push(`chunk ${i}: is_idiom not boolean`);
    // Granularity warning — only for non-idiom, non-proper-noun chunks.
    const targetWords = (c.target || "").trim().split(/\s+/).filter(Boolean).length;
    if (targetWords >= 4 && c.category !== "idiom" && c.category !== "proper_noun") {
      problems.push(`chunk ${i}: too coarse (${targetWords} pinyin words for "${c.target}")`);
    }
    // Hallucination check — the chunk's english span must actually appear in
    // the pair's english. This catches the LLM borrowing words from
    // neighbouring pairs in the same batch, which leaves real words
    // uncovered. Same check for target.
    if (c.english) {
      const en = c.english.toLowerCase().trim();
      if (en && !pairEnglishLower.includes(en)) {
        problems.push(`chunk ${i}: english "${c.english}" not in pair english`);
      }
    }
    if (c.target) {
      const tg = c.target.toLowerCase().trim();
      if (tg && !pairTargetLower.includes(tg)) {
        problems.push(`chunk ${i}: target "${c.target}" not in pair target`);
      }
    }
  });
  return problems;
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
  const out = new Array(pairs.length).fill(null);
  let totalTokens = 0;
  const problems = [];

  for (let start = 0; start < pairs.length; start += batchSize) {
    const slice = pairs.slice(start, start + batchSize);
    const batchIndex = Math.floor(start / batchSize) + 1;
    const totalBatches = Math.ceil(pairs.length / batchSize);
    if (opts.onProgress) opts.onProgress(batchIndex, totalBatches);

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
      const vProblems = validateAlignment(a, slice[i]);
      if (vProblems.length > 0) {
        problems.push(`batch ${batchIndex}, pair ${i}: ${vProblems.join("; ")}`);
      }
      out[start + i] = { ...slice[i], alignment: a.chunks };
    }
  }

  return { aligned: out, totalTokens, problems };
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
