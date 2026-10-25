// Each gloss claims its own exact, non-overlapping English occurrence.
export function assertEnglishSpans(pair, label = 'pair') {
  const text = pair.english.toLowerCase(), claimed = new Set(), spans = [];
  const word = char => /[\p{L}\p{N}]/u.test(char || '');
  const internal = at => /['’]/.test(text[at] || '') && word(text[at - 1]) && word(text[at + 1]);
  for (const [i, chunk] of pair.alignment.entries()) {
    const needle = String(chunk.english || '').toLowerCase(); let found = -1;
    for (let at = text.indexOf(needle); needle && at >= 0; at = text.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (word(needle[0]) && (word(text[at - 1]) || internal(at - 1))) continue;
      if (word(needle.at(-1)) && (word(text[end]) || internal(end))) continue;
      if (Array.from({ length: needle.length }, (_, k) => at + k).some(k => claimed.has(k))) continue;
      found = at; break;
    }
    if (found < 0) throw new Error(`${label}, chunk ${i + 1}: English needs a distinct exact word-boundary span in its own clause; shared or partial-word glosses are not allowed`);
    const end = found + needle.length;
    for (let at = found; at < end; at++) claimed.add(at);
    spans.push({ start: found, end });
  }
  return spans;
}
