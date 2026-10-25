// Deterministic sentence boundaries with source offsets intact. Abbreviation
// protection substitutes one code unit, so slices always refer to original text.
export function sentenceSegments(text, language = 'fr') {
  const protectedText = text.replace(/\b(M|Mme|Mlle|Dr|Pr|St|Ste)\./gu, '$1\u2060').replace(/\b([A-Z])\.(?=\s+[A-Z])/gu, (match, initial) => language === 'en' && initial === 'I' ? match : initial + '\u2060');
  const result = [];
  let prefix = 0;
  for (const part of new Intl.Segmenter(language, { granularity: 'sentence' }).segment(protectedText)) {
    const raw = text.slice(part.index, part.index + part.segment.length);
    if (!/[\p{L}\p{N}]/u.test(raw)) {
      if (result.length) { const previous = result.at(-1); previous.end = part.index + raw.trimEnd().length; previous.text = text.slice(previous.start, previous.end); }
      continue;
    }
    const lead = raw.length - raw.trimStart().length;
    const start = result.length ? part.index + lead : prefix;
    const end = part.index + raw.trimEnd().length;
    result.push({ start, end, text: text.slice(start, end).trim() });
  }
  return result;
}
export function frenchSentenceUnits(pairs) {
  const result = [], pairMap = [];
  for (const [pi, pair] of pairs.entries()) {
    pairMap.push(result.length);
    const french = sentenceSegments(pair.target), english = sentenceSegments(pair.english, 'en');
    if (french.length <= 1) { result.push(pair); continue; }
    if (french.length !== english.length || french.map(p=>p.text).join(' ') !== pair.target || english.map(p=>p.text).join(' ') !== pair.english) throw Error(`pair ${pi+1}: sentence counts/spacing differ; manual alignment review required`);
    let cursor = 0;
    const positioned = pair.alignment.map(chunk => { const start = pair.target.indexOf(chunk.target, cursor); if (start < 0) throw Error(`pair ${pi+1}: source chunk not found`); cursor = start + chunk.target.length; return { chunk, start, end: cursor }; });
    for (const [si, fr] of french.entries()) {
      const alignment = [];
      for (const word of positioned) {
        if (word.start >= fr.end || word.end <= fr.start) continue;
        if (word.start < fr.start || word.end > fr.end || !english[si].text.toLowerCase().includes(word.chunk.english.toLowerCase())) throw Error(`pair ${pi+1}, sentence ${si+1}: chunk crosses bilingual sentence boundary; manual review required`);
        alignment.push(word.chunk);
      }
      const next = { ...pair, target: fr.text, english: english[si].text, alignment };
      if (si > 0) delete next.paragraph_start;
      result.push(next);
    }
  }
  return { pairs: result, pairMap };
}
