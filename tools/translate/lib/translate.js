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

  // gpt-5 family + o-series only accept default temperature (1).
  const isNewFamily = /^gpt-5|^o1|^o3/i.test(model);
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
  };
  if (!isNewFamily) request.temperature = 0.2;
  const response = await client.chat.completions.create(request);

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
export function validatePairs(inputClauses, pairs) {
  const problems = [];
  if (pairs.length > inputClauses.length) {
    problems.push(`Pair count grew: input ${inputClauses.length}, output ${pairs.length} (translator should never increase pair count)`);
  }
  // Coverage check: the union of pair.english should reconstruct the input
  // (modulo whitespace). Strict-equal is too brittle because the translator
  // may normalise punctuation spacing; we collapse whitespace on both sides.
  // Normalise for comparison: strip pipe characters (a .docx artefact used
   // as a soft visual break), collapse whitespace, lowercase.
  const norm = (s) => s.replace(/\|/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const expected = norm(inputClauses.join(" "));
  const actual = norm(pairs.map((p) => p.english).join(" "));
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
    "gpt-4.1": { in: 2, out: 8 },
    "gpt-4.1-mini": { in: 0.40, out: 1.60 },
    "gpt-4.1-nano": { in: 0.10, out: 0.40 },
    // gpt-5 family — placeholder rates; update with real values when verified.
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
