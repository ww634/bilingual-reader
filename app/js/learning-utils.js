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

export const vocabularyKey = (word, lang = 'zh') => lang === 'fr' ? String(word || '').trim().toLocaleLowerCase('fr') : String(word || '').trim();
export const vocabularyUnits = chunk => chunk.lookup?.length ? chunk.lookup : [chunk];
export function distinctOptions(item, candidates, direction) {
  const norm = value => String(value || '').trim().toLowerCase();
  const english = new Set([norm(item.english)]), words = new Set([norm(item.hanzi || item.id)]), out = [];
  for (const candidate of candidates) {
    const e = norm(candidate.english), w = norm(candidate.hanzi || candidate.id);
    if (!e || !w || english.has(e) || words.has(w)) continue;
    if (direction === 'dictation' && item.pinyin && candidate.pinyin && normalizePinyin(item.pinyin) === normalizePinyin(candidate.pinyin)) continue;
    english.add(e); words.add(w); out.push(candidate);
  }
  return out;
}
export function sentenceAnswer(input, expected) {
  const words = text => String(text || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\p{P}/gu, '').trim().split(/\s+/).filter(Boolean);
  const given = words(input), answer = words(expected);
  return given.length === answer.length && given.length > 0 && answer.every((word, i) => oneEdit(word, given[i]));
}
