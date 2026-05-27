// Translate an array of English clauses into pinyin (Mandarin) using OpenAI.
//
// Uses Chat Completions with structured outputs (json_schema) so the model
// is guaranteed to return a valid JSON object matching our schema. We also
// post-validate (count match, tone-mark presence, no Han characters).

import OpenAI from "openai";

const SYSTEM_PROMPT = `You are an expert literary translator producing a bilingual paired-line learning document.

You translate English clauses into Mandarin Chinese, rendered as PINYIN WITH TONE MARKS (never Chinese characters). The learner reads pinyin only.

Hard rules — non-negotiable:
1. PINYIN ONLY. Never include Chinese (Han) characters. Never include numbered pinyin (ma1, ma2). Only diacritic tone marks: ā á ǎ à, ē é ě è, ī í ǐ ì, ō ó ǒ ò, ū ú ǔ ù, ǖ ǘ ǚ ǜ.
2. EVERY syllable carries a tone mark unless it's a neutral-tone particle (then it carries no mark).
3. Word spacing follows standard pinyin orthography: syllables of a single word run together (e.g. "zhàndòu", "péngyǒu"), separate words are space-separated.
4. Each English clause translates to ONE pinyin clause — natural Chinese phrasing within that clause's scope, NOT word-for-word.
5. Proper nouns: transliterate to pinyin by default (e.g. "Sid" -> "Xī dé"). If a name has no obvious Chinese rendering, keep it in Latin script.
6. Preserve the punctuation feel: trailing comma/period/em-dash on the English clause should be reflected with appropriate Chinese pacing in the pinyin (you may omit terminal punctuation in the pinyin; the app re-wraps).
7. You will be given the FULL chapter context so your phrasing is internally consistent (consistent name transliterations, consistent register).

Output: a JSON object matching the provided schema, with exactly N pairs in the same order as the input clauses.`;

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

export function buildClient(apiKey) {
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Set it in your env: export OPENAI_API_KEY=sk-...");
  }
  return new OpenAI({ apiKey });
}

/**
 * Translate clauses in one OpenAI call.
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
 * }
 * @returns {Promise<{pairs: {english: string, target: string}[], usage: object}>}
 */
export async function translateClauses(client, clauses, opts = {}) {
  const model = opts.model || "gpt-4o";
  const englishTitle = opts.englishTitle || "(untitled)";
  const fullText = opts.fullText || clauses.join(" ");
  const canonicalNames = Array.isArray(opts.canonicalNames) ? opts.canonicalNames : [];

  const canonicalBlock = canonicalNames.length === 0 ? "" : [
    "",
    "Canonical translations — these names/terms MUST be used VERBATIM whenever they appear in any clause. Do not invent variants.",
    ...canonicalNames.map((n) => `  - "${n.english}" → "${n.target}"`),
  ].join("\n");

  const userPrompt = [
    `Chapter title: ${englishTitle}`,
    canonicalBlock,
    "",
    "Full chapter prose (for context — do NOT translate this directly):",
    "```",
    fullText,
    "```",
    "",
    `Translate the following ${clauses.length} English clauses into pinyin. Output exactly ${clauses.length} pairs in the same order.`,
    "",
    "Clauses:",
    clauses.map((c, i) => `${i + 1}. ${c}`).join("\n"),
  ].join("\n");

  const response = await client.chat.completions.create({
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
    temperature: 0.2,
  });

  const content = response.choices[0].message.content;
  const parsed = JSON.parse(content);
  return { pairs: parsed.pairs, usage: response.usage };
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

  const response = await client.chat.completions.create({
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
    temperature: 0.2,
  });
  return JSON.parse(response.choices[0].message.content);
}

/**
 * Validate a batch of pairs. Returns { ok, problems }.
 */
export function validatePairs(inputClauses, pairs) {
  const problems = [];
  if (pairs.length !== inputClauses.length) {
    problems.push(`Pair count mismatch: input ${inputClauses.length}, output ${pairs.length}`);
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

/**
 * Rough cost estimate for gpt-4o.
 * As of late 2025: $5/1M input, $20/1M output. We use a conservative
 * 1.3 chars/token estimate.
 */
export function estimateCost({ inputChars, expectedOutputChars }, model = "gpt-4o") {
  const inputTokens = inputChars / 1.3;
  const outputTokens = expectedOutputChars / 1.3;
  const RATES = {
    "gpt-4o": { in: 5, out: 20 },
    "gpt-4o-mini": { in: 0.15, out: 0.60 },
    "gpt-4-turbo": { in: 10, out: 30 },
  };
  const r = RATES[model] || RATES["gpt-4o"];
  const cost = (inputTokens * r.in + outputTokens * r.out) / 1_000_000;
  return { inputTokens: Math.round(inputTokens), outputTokens: Math.round(outputTokens), cost };
}
