const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const id = 'le-petit-manuel-du-cidrier-amateur';
const root = `content/books/${id}`;
const chapters = Array.from({length: 20}, (_, i) => JSON.parse(fs.readFileSync(`${root}/ch-${i+1}.json`)));

test('twenty French chapters have matching catalogue entries, source text and paragraphs', () => {
  const book = JSON.parse(fs.readFileSync('content/library.json')).books.find(b => b.id === id);
  assert.equal(book.language, 'fr');
  for (const c of chapters) {
    const entry = book.chapters.find(e => e.id === c.id);
    assert.equal(entry.version, c.version);
    assert.deepEqual(entry.title, c.title);
    assert.equal(c.book_id, id);
    assert.equal(c.language, 'fr');
    assert.ok(c.pairs.length >= 60);
    assert.ok(c.pairs.filter(p => p.paragraph_start).length >= 12);
    const lines = fs.readFileSync(`${root}/_src/${c.id}.txt`, 'utf8').split('\n').filter(l => l.includes('|||'));
    assert.equal(lines.length, c.pairs.length);
    lines.forEach((line, i) => {
      const [markup, en] = line.split('|||').map(s => s.trim());
      const fr = markup.replace(/\{([^|]+)\|[^}]+\}/g, '$1');
      assert.equal(c.pairs[i].target, fr);
      assert.equal(c.pairs[i].english, en);
    });
  }
});

test('every French word has ordered alignment and an exact, unambiguous lookup', () => {
  let units = 0;
  for (const c of chapters) for (const p of c.pairs) {
    let pos = 0;
    for (const chunk of p.alignment) {
      const at = p.target.indexOf(chunk.target, pos);
      assert.ok(at >= pos);
      assert.doesNotMatch(p.target.slice(pos, at), /[\p{L}\p{N}]/u);
      pos = at + chunk.target.length;
      assert.ok(p.english.toLowerCase().includes(chunk.english.toLowerCase()));
      assert.ok(chunk.lookup?.length);
      let cursor = 0;
      for (const word of chunk.lookup) {
        assert.ok(word.start >= cursor && word.end > word.start);
        assert.equal(chunk.target.slice(word.start, word.end), word.target);
        assert.doesNotMatch(chunk.target.slice(cursor, word.start), /[\p{L}\p{N}]/u);
        assert.ok(word.english && !word.english.includes('/'));
        if (/\s/.test(word.target)) assert.notEqual(word.english, 'negation marker');
        if (/\s/.test(word.target)) assert.notEqual(word.english, 'reflexive pronoun');
        cursor = word.end;
        units++;
      }
      assert.doesNotMatch(chunk.target.slice(cursor), /[\p{L}\p{N}]/u);
    }
    assert.doesNotMatch(p.target.slice(pos), /[\p{L}\p{N}]/u);
  }
  assert.ok(units > 3500);
});

test('technical senses, possessives and grouped negatives use the cider context', () => {
  const all = chapters.flatMap(c => c.pairs.flatMap(p => p.alignment));
  function gloss(chunk, term) {
    const c = all.find(c => c.target === chunk);
    assert.ok(c, chunk);
    return c.lookup.find(w => w.target === term);
  }
  assert.equal(gloss('tranquille', 'tranquille').english, 'still');
  assert.equal(gloss('La taille', 'taille').english, 'pruning');
  assert.equal(gloss('la taille de votre goûter', 'taille').english, 'size');
  assert.equal(gloss('la taille de votre goûter', 'goûter').category, 'noun');
  assert.equal(gloss('le porte-greffe', 'porte-greffe').english, 'rootstock');
  assert.equal(gloss('son origine', 'son').english, 'its');
  assert.equal(gloss('attaché à sa lumière', 'sa').english, 'his');
  assert.equal(gloss("n'a pas besoin", "n'a pas besoin").english, 'does not need');
  assert.equal(gloss('qui se dégradent', 'se dégradent').english, 'is deteriorating');
  assert.equal(gloss('Que mesure cet instrument', 'mesure').category, 'verb');
});

test('reader rendering preserves every French sentence and emits individual tap targets', () => {
  const context = vm.createContext({console, window: {addEventListener(){}}, document: {}});
  const src = fs.readFileSync('app/js/reader.js', 'utf8').replace(/^import .*?;\n/gm, '').replace(/export /g, '');
  vm.runInContext(src + '\nglobalThis.render = buildPinyinHtml;', context);
  for (const c of chapters) for (const p of c.pairs) {
    const {html} = context.render([p]);
    assert.match(html, /data-lookup=/);
    const text = html.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
    assert.equal(text, p.target);
  }
});

test('workshop and measurement chapters keep technical senses and blend labels', () => {
  const chunks = chapters.slice(5).flatMap(c => c.pairs.flatMap(p => p.alignment));
  const find = (target, term) => {
    const chunk = chunks.find(c => c.target === target);
    assert.ok(chunk, target);
    const word = chunk.lookup.find(w => w.target === term);
    assert.ok(word, term);
    return word;
  };
  assert.equal(find('Le densimètre', 'densimètre').english, 'hydrometer');
  assert.equal(find('Le moût', 'moût').english, 'must');
  assert.equal(find('de densité relative', 'densité relative').english, 'specific gravity');
  assert.equal(find("n'est plus", "n'est plus").english, 'is no longer');
  assert.equal(find('ne se calcule pas', 'ne se calcule pas').english, 'cannot be calculated');
  assert.equal(find('Une odeur de fruit frais', 'frais').english, 'fresh');
  assert.equal(find('La précision', 'précision').english, 'precision');
  const blendLabels = chunks.flatMap(c => c.lookup).filter(w => w.target === 'A');
  assert.ok(blendLabels.length > 2);
  assert.ok(blendLabels.every(w => w.english === 'A' && w.category === 'proper_noun'));
});

test('fermentation and maturation chapters retain their contextual technical vocabulary', () => {
  const units = chapters.slice(10).flatMap(c => c.pairs.flatMap(p => p.alignment.flatMap(a => a.lookup)));
  const has = (target, english) => assert.ok(units.some(w => w.target.toLowerCase() === target && w.english === english), `${target}: ${english}`);
  has('lies', 'lees');
  has('trouble', 'haze');
  has('trouble', 'cloudy');
  has('porte', 'door');
  has('cuivre', 'copper');
  has('acide lactique', 'lactic acid');
  has('reprise de fermentation', 'refermentation');
  has('1,030', '1.030');
  has('se contredisent', 'contradict one another');
});

test('new chapters distinguish familiar prose from technical vocabulary', () => {
  for (const c of chapters.slice(10)) {
    const bands = new Set(c.pairs.flatMap(p => p.alignment.map(a => a.frequency_band)));
    assert.ok(bands.has('very_common') && bands.has('common'));
    assert.ok(bands.has('uncommon'));
  }
});

test('finishing chapters keep blending labels and tasting homonyms independently meaningful', () => {
  const chunks = chapters.slice(15).flatMap(c => c.pairs.flatMap(p => p.alignment));
  const units = chunks.flatMap(c => c.lookup);
  const expected = [
    ['finale', 'finish', 'noun'],
    ['nature', 'plain', 'adjective'],
    ['palais', 'palate', 'noun'],
    ['feuille', 'sheet', 'noun'],
    ['part', 'starts', 'verb'],
    ['A', 'A', 'proper_noun']
  ];
  for (const [target, english, category] of expected) {
    assert.ok(units.some(w => w.target === target && w.english === english && w.category === category), `${target}: ${english} (${category})`);
  }
  assert.ok(units.filter(w => w.target === 'A').every(w => w.english === 'A' && w.category === 'proper_noun'));
  assert.ok(!units.some(w => w.target === 'A pourrait'));
});

test('all manuscript paragraphs match the bilingual app chapters', () => {
  for (const c of chapters) {
    const groups = [];
    for (const p of c.pairs) {
      if (p.paragraph_start) groups.push([]);
      groups.at(-1).push(p);
    }
    for (const [language, key] of [['fr', 'target'], ['en', 'english']]) {
      const manuscript = fs.readFileSync(`writing/manuscript/${id}/${c.id}.${language}.md`, 'utf8').trim().split(/\n\n/).slice(1);
      assert.deepEqual(manuscript, groups.map(g => g.map(p => p[key]).join(' ')));
    }
  }
});

test('all published frequency and category metadata is understood by the app', () => {
  const bands = new Set(['very_common', 'common', 'uncommon', 'rare']);
  const categories = new Set(['noun','verb','adjective','adverb','function_word','proper_noun','idiom']);
  for (const c of chapters) for (const p of c.pairs) for (const a of p.alignment) {
    assert.ok(categories.has(a.category), `${c.id}: ${a.category}`);
    assert.ok(a.category === 'proper_noun' ? a.frequency_band === null : bands.has(a.frequency_band));
    for (const w of a.lookup) {
      assert.ok(categories.has(w.category));
      assert.ok(w.category === 'proper_noun' ? w.frequency_band === null : bands.has(w.frequency_band));
    }
  }
});

test('every English word has a reader alignment anchor and French-only paragraphs stay intact', () => {
  const context = vm.createContext({console, window: {addEventListener(){}}, document: {}});
  const src = fs.readFileSync('app/js/reader.js', 'utf8').replace(/^import .*?;\n/gm, '').replace(/export /g, '');
  vm.runInContext(src + '\nglobalThis.api = {buildEnglishCoverage, paragraphStarts};', context);
  for (const c of chapters) {
    assert.deepEqual(Array.from(context.api.paragraphStarts(c.pairs)), c.pairs.map(p => !!p.paragraph_start));
    for (const p of c.pairs) {
      const coverage = context.api.buildEnglishCoverage(p);
      for (let i=0;i<p.english.length;i++) if (/[\p{L}\p{N}]/u.test(p.english[i])) {
        assert.notEqual(coverage[i], null, `${c.id}: ${p.english}`);
      }
    }
  }
});

test('published word lookups are reproducible from the reviewed authoring resources', async () => {
  const path = require('node:path');
  const {frenchLookups} = await import(path.resolve('tools/translate/lib/french-vocabulary.js'));
  const vocabulary = Object.fromEntries(['words','phrases','verbs','overrides'].map(k => [k, JSON.parse(fs.readFileSync(`${root}/_src/vocabulary/${k}.json`))]));
  for (const c of chapters) for (const p of c.pairs) for (const a of p.alignment) {
    assert.deepEqual(a.lookup, frenchLookups(a, vocabulary), `${c.id}: ${a.target}`);
  }
});

test('context-sensitive modifiers and indirect pronouns keep the reviewed meaning', () => {
  const chunks = chapters.flatMap(c => c.pairs.flatMap(p => p.alignment));
  for (const [target, term, english] of [
    ['de leur donner', 'leur', 'them'],
    ['à plusieurs moments', 'à plusieurs', 'at several'],
    ['Modifier tout à la fois', 'à la fois', 'at once'],
    ['dans les récipients de réserve', 'réserve', 'reserve'],
    ['vaut mieux', 'vaut mieux', 'is better']
  ]) assert.ok(chunks.some(c => c.target === target && c.lookup.some(w => w.target === term && w.english === english)), `${term}: ${english}`);
});
