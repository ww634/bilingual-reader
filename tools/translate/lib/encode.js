// Encoding stage of the Book Studio (the mechanical half).
//
// The writer produced natural Chinese prose. Encoding turns that fixed Chinese
// into the reader's data layer WITHOUT changing a character:
//   1. segment the prose into short clause-sized reading units and gloss each
//      into English (one LLM pass; the Chinese is preserved verbatim);
//   2. romanize each unit's pinyin deterministically;
//   3. word-align english↔hanzi (reusing the existing aligner);
//   4. set every chunk's frequency_band deterministically.
// The Chinese — the part that matters — is never re-generated, so there is no
// translationese and no drift; the English is just an aid.

import { romanize } from "./romanize.js";
import { splitReadingSentences } from "./sentences.js";
import { alignAll } from "./align.js";
import { applyFrequencyBands } from "./frequency.js";
import { acquire, reconcile, estimateRequestTokens } from "./ratelimit.js";

const isNewFamily = (model) => /^gpt-5|^o1|^o3/i.test(model);

const MAX_SENTENCES_PER_CALL = 25;

const ENCODE_SYSTEM = `You are preparing authored Simplified-Chinese prose for a bilingual reader. You will be given an ordered list of Chinese sentences. For each sentence:
- Split it into short READING UNITS: natural clause-sized spans (a phrase or clause, typically 2-12 characters) — NOT single words, and NOT the whole long sentence as one blob. Split at natural clause boundaries and after punctuation.
- PRESERVE THE CHINESE CHARACTERS EXACTLY and in order. The concatenation of a sentence's units MUST reproduce that sentence's characters exactly (you may attach punctuation to the unit it follows). Do not paraphrase, add, drop, or reorder any Chinese.
- For each unit, give a faithful, natural English translation of THAT unit in the context of its sentence.

Return strict JSON: one entry per input sentence, in order, each with its list of { hanzi, english } units.`;

const ENCODE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sentences: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          units: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              properties: { hanzi: { type: "string" }, english: { type: "string" } },
              required: ["hanzi", "english"],
            },
          },
        },
        required: ["units"],
      },
    },
  },
  required: ["sentences"],
};

const hanOnly = (s) => String(s || "").replace(/[^㐀-鿿一-鿿]/g, "");

/** Deterministically split prose into sentences (keeps terminal punctuation). */
export function splitSentences(prose) {
  return splitReadingSentences(prose).map(s => s.trim()).filter(Boolean);
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** One encoder call over a batch of sentences → array (per sentence) of units. */
async function encodeSentenceBatch(client, sentences, { model }) {
  const userPrompt = [
    `Segment and gloss these ${sentences.length} Chinese sentence(s). Return one entry per sentence, in order.`,
    "",
    ...sentences.map((s, i) => `${i + 1}. ${s}`),
  ].join("\n");
  const request = {
    model,
    messages: [
      { role: "system", content: ENCODE_SYSTEM },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_schema", json_schema: { name: "encoded", strict: true, schema: ENCODE_SCHEMA } },
    [isNewFamily(model) ? "max_completion_tokens" : "max_tokens"]: 8000,
  };
  if (!isNewFamily(model)) request.temperature = 0.1;
  const rl = await acquire(estimateRequestTokens(request.messages, 4000));
  const response = await client.chat.completions.create(request);
  reconcile(rl, response.usage?.total_tokens);
  const parsed = JSON.parse(response.choices[0].message.content);
  return { sentences: parsed.sentences || [], usage: response.usage };
}

/**
 * Encode a finished Chinese chapter into reader pairs.
 * @returns { pairs: [{english, hanzi, target, alignment}], usage, stats }
 */
export async function encodeChapter(client, { chapterHanzi, englishTitle }, opts = {}) {
  const model = opts.model || "gpt-4.1";           // segmentation+gloss (mechanical)
  const alignModel = opts.alignModel || model;      // word alignment
  const sentences = splitSentences(chapterHanzi);
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const addUsage = (u) => { usage.prompt_tokens += u?.prompt_tokens || 0; usage.completion_tokens += u?.completion_tokens || 0; usage.total_tokens += u?.total_tokens || 0; };

  // ── 1. Segment + gloss ──
  const pairs = [];
  let coarseFallbacks = 0;
  const batches = chunk(sentences, MAX_SENTENCES_PER_CALL);
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    if (opts.onEncodeBatch) opts.onEncodeBatch(bi + 1, batches.length);
    const { sentences: results, usage: u } = await encodeSentenceBatch(client, batch, { model });
    addUsage(u);
    batch.forEach((sentence, i) => {
      const units = (results[i] && Array.isArray(results[i].units)) ? results[i].units : [];
      const clean = units.filter((u2) => (u2.hanzi || "").trim());
      const ok = clean.length > 0 && hanOnly(clean.map((u2) => u2.hanzi).join("")) === hanOnly(sentence);
      if (ok) {
        for (const u2 of clean) pairs.push({ hanzi: u2.hanzi.trim(), english: (u2.english || "").trim() });
      } else {
        // Coverage failed — keep the sentence intact as ONE pair (text integrity
        // over fine alignment); gloss = the model's unit glosses joined, or a
        // placeholder to be improved on a re-encode.
        coarseFallbacks++;
        const gloss = clean.map((u2) => (u2.english || "").trim()).filter(Boolean).join(" ");
        pairs.push({ hanzi: sentence, english: gloss || "(gloss unavailable)" });
      }
    });
  }

  // ── 2. Romanize ──
  for (const p of pairs) p.target = romanize(p.hanzi);

  // ── 3. Word alignment (reuse existing aligner) ──
  if (opts.alignment !== false) {
    const result = await alignAll(client, pairs, {
      model: alignModel,
      englishTitle: englishTitle || "",
      maxRetries: opts.alignRetries || 0,
      onProgress: opts.onAlignProgress,
    });
    addUsage({ prompt_tokens: result.totalIn, completion_tokens: result.totalOut, total_tokens: result.totalTokens });
    // Copy alignment back onto our pairs.
    result.aligned.forEach((ap, i) => { if (pairs[i]) pairs[i].alignment = ap.alignment || null; });
  }

  // ── 4. Deterministic frequency bands ──
  applyFrequencyBands(pairs);

  return {
    pairs,
    usage,
    stats: {
      sentences: sentences.length,
      pairs: pairs.length,
      coarseFallbacks,
      aligned: pairs.filter((p) => Array.isArray(p.alignment) && p.alignment.length).length,
    },
  };
}
