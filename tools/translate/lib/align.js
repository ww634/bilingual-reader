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

const ALIGN_SYSTEM_PROMPT = `You are a bilingual annotator producing word-level alignment between English clauses and their Mandarin Chinese pinyin translations.

For each (english, target) pair, you return a list of CHUNKS. A chunk is a small contiguous span of both languages that map to each other.

Hard rules:
1. Each chunk has both an "english" span and a "target" pinyin span — neither empty.
2. Chunks appear in the order of the TARGET (pinyin) clause, left to right.
3. The English spans, concatenated in chunk order, should reconstruct the original English clause (allowing for natural word reordering between the two languages — sometimes chunks may pull from non-adjacent English words; that's expected).
4. Pinyin chunks must respect standard pinyin word boundaries: syllables of a single Chinese word run together (e.g. "zhàndòu", "péngyǒu"), multiple words separate. Do NOT split a single pinyin word across two chunks.
5. Every chunk gets a "category": one of "noun", "verb", "adjective", "adverb", "grammar" (particles, conjunctions, prepositions, articles, pronouns, auxiliaries), "idiom" (4-character chengyu or other multi-word fixed expression), "proper_noun" (transliterated names of people/places).
6. Every chunk gets a "frequency_band": one of "very_common" (HSK 1-2 level), "common" (HSK 3-4), "uncommon" (HSK 5-6), "rare" (beyond HSK 6 / literary), or null for proper nouns and idioms.
7. "is_idiom": true ONLY for genuine fixed expressions (chengyu, set phrases). For ordinary multi-word translations (e.g. "in the corner" -> "zài jiǎoluò lǐ"), set is_idiom=false even if the chunk spans multiple words.

Edge cases:
- An English filler word like "the" with no Chinese counterpart: attach it to the adjacent content word's chunk rather than creating a target-empty chunk.
- A Chinese particle like 了 / 的 / 吗 (pinyin "le" / "de" / "ma") that has no English counterpart: attach it to the adjacent verb or noun chunk on the English side rather than leaving english empty. Tag as "grammar".
- If a single pinyin word translates to multiple English words ("zhàndòu" -> "the battle"), put all those English words in the chunk's english field.

The output schema is a flat array of chunks per pair, in target order.`;

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
                  enum: ["noun", "verb", "adjective", "adverb", "grammar", "idiom", "proper_noun"],
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

const CATEGORY_ENUM = new Set(["noun", "verb", "adjective", "adverb", "grammar", "idiom", "proper_noun"]);
const FREQ_ENUM = new Set(["very_common", "common", "uncommon", "rare"]);

const DEFAULT_BATCH_SIZE = 15;

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

  const response = await client.chat.completions.create({
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
    temperature: 0.1,
  });

  const parsed = JSON.parse(response.choices[0].message.content);
  return { alignments: parsed.alignments, usage: response.usage };
}

/**
 * Validate a single alignment entry. Returns array of problem strings (empty if OK).
 */
function validateAlignment(alignment, originalPair) {
  const problems = [];
  if (!Array.isArray(alignment.chunks) || alignment.chunks.length === 0) {
    problems.push("no chunks returned");
    return problems;
  }
  alignment.chunks.forEach((c, i) => {
    if (!c.english || !c.target) problems.push(`chunk ${i}: empty english or target`);
    if (!CATEGORY_ENUM.has(c.category)) problems.push(`chunk ${i}: invalid category "${c.category}"`);
    if (c.frequency_band !== null && !FREQ_ENUM.has(c.frequency_band)) {
      problems.push(`chunk ${i}: invalid frequency_band "${c.frequency_band}"`);
    }
    if (typeof c.is_idiom !== "boolean") problems.push(`chunk ${i}: is_idiom not boolean`);
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
  };
  const r = RATES[model] || RATES["gpt-4o"];
  const cost = (inputTokens * r.in + outputTokens * r.out) / 1_000_000;
  return { inputTokens: Math.round(inputTokens), outputTokens: Math.round(outputTokens), cost };
}
