// French tap-to-learn units are separate from sentence-translation alignment.
// Alignment can legitimately map a whole clause; that must not prevent a
// learner looking up its individual nouns, possessives and compound verbs.
const TOKEN = /[\p{L}\p{N}_]+['’]|[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu;
const AUX = new Set("a ai as avons avez ont avait avais avions aviez avaient aurai auras aura aurons aurez auront aurait aurais auriez auraient est es suis sommes êtes sont était étais étions étiez étaient serai sera seras serons serez seront serait serais seriez seraient ait aient aie ayant été".split(' '));
const normal = s => s.toLowerCase().replaceAll('’', "'");
const boundary = s => new RegExp(`(?<![\\p{L}\\p{N}])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');
const present = (text, s) => boundary(s).test(text);

function contextual(gloss, english, options = {}) {
  const choices = gloss.split('/');
  const hits = choices.filter(s => present(english, s));
  if (options.possessive && options.following) {
    const nounChoices = options.following.english.split('/');
    for (const noun of nounChoices) {
      const at = english.toLowerCase().indexOf(noun.toLowerCase());
      if (at < 0) continue;
      const before = english.slice(Math.max(0, at - 45), at);
      const matches = [...before.matchAll(/\b(his|her|its|their)\b/gi)];
      if (matches.length) return matches.at(-1)[0].toLowerCase();
    }
  }
  return (hits.sort((a,b) => b.length-a.length)[0] || choices[0]).trim();
}

export function frenchLookups(chunk, vocabulary) {
  const { words, phrases = {}, verbs = {}, overrides = {} } = vocabulary;
  const matches = [...chunk.target.matchAll(TOKEN)];
  const units = [];
  const key = JSON.stringify([chunk.target, chunk.english]);
  const custom = overrides[key] || {};
  for (let i = 0; i < matches.length;) {
    const m = matches[i];
    const w = normal(m[0]);
    let count = 1, entry;
    // A short allowlist, not the longest available sentence fragment.
    for (let k = Math.min(6, matches.length - i); k > 1; k--) {
      const raw = chunk.target.slice(m.index, matches[i+k-1].index + matches[i+k-1][0].length);
      const e = phrases[normal(raw)];
      if (e) { count=k; entry=e; break; }
    }
    if (!entry && m[0] !== 'A' && AUX.has(w) && i+1 < matches.length) {
      const next = normal(matches[i+1][0]);
      const compound = `${w} ${next}`;
      const known = verbs[compound];
      const participle = words[next];
      if (known) {
        count=2;
        entry=known;
        // A verb such as reprendre has several valid senses. If this exact
        // tense has no counterpart in the current translation, select the
        // participle's contextual sense rather than borrowing another scene's.
        if (!known.english.split('/').some(g => present(chunk.english,g)) && participle) {
          const sense=participle.english.split('/').find(g => present(chunk.english,g));
          if (sense) {
            const prefix=/^(avait|avais|avions|aviez|avaient)$/.test(w) ? 'had ' : '';
            entry={english:prefix+sense,category:'verb'};
          }
        }
      }
      else if (participle && /[éiu]e?s?$|ert[e]?[s]?$|is[e]?[s]?$|it[e]?[s]?$/.test(next) && participle.category==='verb') {
        count=2;
        const base = contextual(participle.english, chunk.english);
        const prefix = /^(avait|avais|avions|aviez|avaient)$/.test(w) ? 'had ' : /^(était|étais)$/.test(w) ? 'was ' : /^(étions|étiez|étaient)$/.test(w) ? 'were ' : /^(aurait|aurais|auriez|auraient)$/.test(w) ? 'would have ' : /^(serait|serais|seriez|seraient)$/.test(w) ? 'would be ' : '';
        entry = { english: prefix + base, category: 'verb' };
      }
    }
    if (!entry) entry=words[w];
    if (!entry) throw new Error(`Missing French vocabulary: ${m[0]} in ${chunk.target}`);
    if (count===1 && /^[A-ZÀ-Ý]/u.test(m[0]) && Object.values(phrases).some(p => p.category==='proper_noun' && p.english.split(' ').includes(m[0]))) {
      entry={english:m[0], category:'proper_noun'};
    }
    const end = matches[i+count-1].index + matches[i+count-1][0].length;
    const target = chunk.target.slice(m.index, end);
    const following = matches[i+count] && words[normal(matches[i+count][0])];
    let english = contextual(entry.english, chunk.english, { possessive: ['sa','son','ses','leur','leurs'].includes(w), following });
    // Prefer authored lexical senses, not the old broad phrase gloss, even
    // when an original alignment happened to contain only one French word.
    // Elision retains the role of the word in this construction.
    if (count===1 && (w === "s'" || w==='se') && !present(chunk.english, english)) english = normal(matches[i+1]?.[0] || '') === 'il' ? 'if' : 'reflexive pronoun';
    if (count===1 && (w === "l'" || w==='le' || w==='la') && AUX.has(normal(matches[i+1]?.[0] || ''))) english = /\b(it|him|her)\b/i.exec(chunk.english)?.[0].toLowerCase() || 'it';
    if (count===1 && (w === 'de' || w === "d'") && following?.category === 'verb') english='to';
    if (count===1 && (w === "n'" || w === 'ne')) english='negation marker';
    if (count===1 && w === 'en' && matches[i+1] && /ant$/.test(normal(matches[i+1][0]))) {
      english=present(chunk.english,'by') ? 'by' : present(chunk.english,'on') ? 'on' : 'while';
    }
    const exact = custom[String(m.index)];
    if (exact) english=exact.english;
    const category = exact?.category || entry.category;
    units.push({target, english, category,
      frequency_band: category==='proper_noun' ? null : category==='function_word' ? 'very_common' : (chunk.frequency_band || 'common'),
      is_idiom: category==='idiom', start:m.index, end});
    i+=count;
  }
  return units;
}
