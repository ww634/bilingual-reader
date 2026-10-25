// Shared, conservative answer matching and sentence offsets.
export function normalizePinyin(value) {
  return String(value || "").toLowerCase().replace(/u:|ü|ǖ|ǘ|ǚ|ǜ/g, "v")
    .normalize("NFD").replace(/\p{M}/gu, "").replace(/[\s1-5'’]/g, "");
}

export const normalizedWords = value => String(value || "").toLowerCase()
  .normalize("NFD").replace(/\p{M}/gu, "").replace(/\p{P}/gu, " ").trim().split(/\s+/).filter(Boolean);

function oneEdit(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}

export function englishAnswer(input, senses) {
  const words = value => normalizedWords(value).join(" ").replace(/^(to|a|an|the) /, "").split(" ");
  const given = words(input);
  if (!given[0]) return false;
  return String(senses || "").split(/[;,]/).some(sense => {
    const expected = words(sense);
    return expected.length === given.length && expected.every((word, i) => oneEdit(word, given[i]));
  });
}

// Ambiguous repeated occurrences never become fill-in questions. Stored offsets
// disambiguate a saved context, but do not turn repeated words into a guessing game.
export function clozeRange(sentence, word, offset = null) {
  if (!sentence || !word) return null;
  const latin = !/\p{Script=Han}/u.test(word);
  const isLetter = c => /[\p{L}\p{N}]/u.test(c || "");
  const hay = sentence.toLowerCase(), needle = word.toLowerCase(), hits = [];
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (latin && (isLetter(sentence[at - 1]) || isLetter(sentence[at + word.length]))) continue;
    hits.push(at);
  }
  if (hits.length !== 1) return null;
  const at = hits[0];
  if (offset != null && Number.isInteger(offset) && offset !== at) return null;
  return { start: at, end: at + word.length };
}
