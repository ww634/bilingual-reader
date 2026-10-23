// Sentence boundaries for authored reader pairs. Preserve every source byte;
// closing quotes and following whitespace belong to the preceding sentence.
export function splitReadingSentences(prose) {
  const text = String(prose ?? '');
  const units = [];
  let start = 0;
  for (const match of text.matchAll(/[。！？]+[”’」』）)】]*\s*/gu)) {
    const end = match.index + match[0].length;
    if (/[\p{L}\p{N}]/u.test(text.slice(start, end))) {
      units.push(text.slice(start, end));
      start = end;
    }
  }
  const tail = text.slice(start);
  if (tail) {
    if (units.length && !/[\p{L}\p{N}]/u.test(tail)) units[units.length - 1] += tail;
    else units.push(tail);
  }
  return units;
}

export function assertSentenceUnit(text, label = 'pair') {
  if (splitReadingSentences(text).length > 1) {
    throw new Error(`${label}: contains multiple sentences; split at sentence ends and gloss/align each unit separately (never encode a whole paragraph as one pair)`);
  }
}
