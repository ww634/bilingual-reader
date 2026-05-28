// LLM-based content analyzer.
//
// Takes cleaned plain text and returns a structured description:
//   - what kind of content this is (book front-matter / single chapter / multi-chapter book)
//   - book-level metadata (title, author, suggested id, synopsis)
//   - section list with start markers (so we can slice the text precisely)
//   - skip flags for front matter that shouldn't be translated
//
// Uses a cheap model (gpt-4o-mini by default) since this is a structured
// extraction task, not literary translation.

import OpenAI from "openai";

const SYSTEM_PROMPT = `You are a literary content analyst. Given the cleaned text of a book or chapter file, you return a structured JSON description of what it contains so a downstream translation pipeline knows what to translate, what to skip, and how to label each chapter.

Your job:
1. Identify the work: book title, author, language. If only a single chapter is present (not a whole book), still record what you can infer about the parent book.
2. Identify SECTIONS in the text in reading order. Each section is one of:
   - "title_page"        — title/author block on a title or half-title page
   - "copyright"         — copyright notices, publisher info, ISBN
   - "dedication"        — "Dedicated to..." or a dedicatory poem
   - "preface" / "foreword" / "introduction" — author or editor preface
   - "table_of_contents"
   - "chapter"           — actual story chapter (translate)
   - "epilogue" / "afterword"
   - "other"             — anything that doesn't fit
3. For each section, give a precise "start_marker" — the first 5-12 verbatim words from the section's opening, copied EXACTLY from the input text. The pipeline will use this to slice the text. The marker MUST appear verbatim in the input (whitespace-collapsed). Do not paraphrase, do not translate, do not include leading punctuation that isn't there.
4. Set "skip": true for sections that aren't worth translating for a language learner (title pages, copyright, dedications, ToC). Set "skip": false for chapters and prefaces.
5. For each chapter, give: chapter_number (1-based across the whole book if you can tell, otherwise sequential), english_title, and a 1-2 sentence synopsis in English. Suggest a kebab-case "id_suggestion" like "ch-1" or "ch-3" — DO NOT prefix with the book id, that gets added later.
6. Suggest a "book_id_suggestion" — kebab-case slug of the book title (e.g. "treasure-island", "the-hobbit", "winding-paths"). No author prefix.
7. Provide a "book_synopsis" — 1-3 sentences in English summarising the whole book if you can identify it. If you can't, return null.
8. Provide "genres" — 3-6 short, lowercase, friendly tags describing the book (e.g. "adventure", "classic", "coming of age", "fantasy", "historical", "romance", "literary fiction", "sci-fi", "thriller", "young adult", "memoir"). Words separated by spaces. Avoid hyphens. If you can't infer the genre, return an empty array.

Quality rules:
- start_marker MUST be present verbatim in the input. Copy it character-for-character from a contiguous span at the section's opening.
- Be conservative with chapter detection. If a "chapter" doesn't have either a number, a title, or a clear structural break, treat the boundaries as uncertain (skip: false but flag with detection_confidence: "low").
- The same input may contain partial front matter only, a single chapter only, or a whole book.
- If you cannot determine the book's title or author confidently, leave them as empty string, not invented.`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    book: {
      type: "object",
      additionalProperties: false,
      properties: {
        english_title: { type: "string", description: "Book title in English / original language. Empty string if unknown." },
        author: { type: "string", description: "Author display name. Empty string if unknown." },
        book_id_suggestion: { type: "string", description: "Kebab-case slug for the book id." },
        book_synopsis: { type: ["string", "null"], description: "1-3 sentence summary, English. null if you can't infer it." },
        genres: {
          type: "array",
          items: { type: "string" },
          description: "3-6 short lowercase genre tags (e.g. ['adventure', 'classic']). Empty array if unknown.",
        },
        looks_like: {
          type: "string",
          enum: ["front_matter_only", "single_chapter", "partial_book", "complete_book"],
          description: "What this file appears to contain.",
        },
      },
      required: ["english_title", "author", "book_id_suggestion", "book_synopsis", "genres", "looks_like"],
    },
    sections: {
      type: "array",
      description: "Sections in reading order.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: {
            type: "string",
            enum: [
              "title_page", "copyright", "dedication", "preface", "foreword",
              "introduction", "table_of_contents", "chapter", "epilogue",
              "afterword", "other",
            ],
          },
          start_marker: {
            type: "string",
            description: "First 5-12 verbatim words from the section's opening, copied exactly from the input.",
          },
          skip: { type: "boolean", description: "Skip during translation (true for front matter, etc)." },
          chapter_number: { type: ["integer", "null"], description: "1-based chapter number if applicable, else null." },
          english_title: { type: "string", description: "Human-friendly title for this section, English." },
          synopsis: { type: ["string", "null"], description: "1-2 sentence synopsis, English. Required for chapters; null otherwise." },
          id_suggestion: { type: ["string", "null"], description: "Kebab-case id for this section, scoped within the book (e.g. ch-1). Null for skipped sections." },
          detection_confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: [
          "kind", "start_marker", "skip", "chapter_number",
          "english_title", "synopsis", "id_suggestion", "detection_confidence",
        ],
      },
    },
  },
  required: ["book", "sections"],
};

/**
 * Analyze cleaned text. Returns the parsed analysis object plus usage.
 *
 * @param {OpenAI} client
 * @param {string} cleanedText
 * @param {object} opts { model, maxAnalyzeChars }
 * @returns {Promise<{analysis: object, usage: object}>}
 */
export async function analyzeContent(client, cleanedText, opts = {}) {
  const model = opts.model || "gpt-4o-mini";
  // Whole-book aware default. gpt-5.4-nano and gpt-4o-mini both support 128k+
  // context; ~400k chars fits with room to spare for system prompt + output.
  // A typical novel is 200-400k chars so this fits a whole book in one call.
  // For larger inputs (>500k), we still truncate with a head+tail sample.
  const maxChars = opts.maxAnalyzeChars || 400000;
  let textForAnalysis;
  let truncated = false;
  if (cleanedText.length <= maxChars) {
    textForAnalysis = cleanedText;
  } else {
    truncated = true;
    const headSize = Math.floor(maxChars * 0.7);
    const tailSize = maxChars - headSize - 200;
    textForAnalysis =
      cleanedText.slice(0, headSize) +
      `\n\n[... ${cleanedText.length - headSize - tailSize} chars elided for brevity ...]\n\n` +
      cleanedText.slice(-tailSize);
    console.warn(
      `[analyze] Input is ${cleanedText.length.toLocaleString()} chars; ` +
      `truncating to ${maxChars.toLocaleString()} for analysis. ` +
      `Middle chapters may be missed. Consider splitting the source file.`
    );
  }

  const isNewFamily = /^gpt-5|^o1|^o3/i.test(model);
  const request = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          "Analyze the following text and return the structured JSON. Remember: start_marker must be copied VERBATIM from the input.\n\n```\n" +
          textForAnalysis +
          "\n```",
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "content_analysis",
        strict: true,
        schema: RESPONSE_SCHEMA,
      },
    },
  };
  if (!isNewFamily) request.temperature = 0.1;
  const response = await client.chat.completions.create(request);

  const analysis = JSON.parse(response.choices[0].message.content);
  return { analysis, usage: response.usage };
}

/**
 * Given the full cleaned text and an analysis, slice the text into per-section
 * substrings using each section's start_marker.
 *
 * Returns an array parallel to analysis.sections with an extra `text` field.
 * If a marker can't be found, that section's `text` is empty and `markerFound`
 * is false — the caller should warn.
 */
export function sliceByMarkers(cleanedText, analysis) {
  const sections = analysis.sections.map((s) => ({ ...s, text: "", markerFound: false }));
  // Normalize whitespace for matching but keep the original text for slicing.
  const normalized = cleanedText.replace(/\s+/g, " ");

  // Find each marker's start index in the normalized text. Walk forward so
  // that earlier sections claim their match before later ones do.
  let searchFrom = 0;
  for (const section of sections) {
    const marker = section.start_marker.replace(/\s+/g, " ").trim();
    if (!marker) continue;
    const idx = normalized.indexOf(marker, searchFrom);
    if (idx === -1) {
      // Try a looser match: first 5 words.
      const shortMarker = marker.split(" ").slice(0, 5).join(" ");
      const fallbackIdx = normalized.indexOf(shortMarker, searchFrom);
      if (fallbackIdx === -1) continue;
      section._normalizedStart = fallbackIdx;
      section.markerFound = true;
      searchFrom = fallbackIdx + 1;
    } else {
      section._normalizedStart = idx;
      section.markerFound = true;
      searchFrom = idx + 1;
    }
  }

  // Now translate normalized indices back to indices in the original text.
  // This is approximate but close enough — we map by walking both strings.
  // Easier: re-scan the original text for each marker independently, skipping
  // forward as we go.
  let origCursor = 0;
  for (const section of sections) {
    if (!section.markerFound) continue;
    const marker = section.start_marker.trim();
    // Build a fuzzy regex that allows any whitespace where the marker has space.
    const words = marker.split(/\s+/).slice(0, 8).map((w) =>
      w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    );
    const re = new RegExp(words.join("\\s+"), "i");
    const sub = cleanedText.slice(origCursor);
    const m = sub.match(re);
    if (!m) continue;
    section._origStart = origCursor + m.index;
    origCursor = section._origStart + 1;
  }

  // Assign each section's text as the slice from its origStart to the next
  // section's origStart (or end of doc).
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (s._origStart === undefined) continue;
    const next = sections.slice(i + 1).find((n) => n._origStart !== undefined);
    const end = next ? next._origStart : cleanedText.length;
    s.text = cleanedText.slice(s._origStart, end).trim();
  }

  return sections;
}
