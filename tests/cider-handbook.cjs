const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const id = 'le-petit-manuel-du-cidrier-amateur';
const root = `content/books/${id}`;
const chapters = Array.from({length: 10}, (_, i) => JSON.parse(fs.readFileSync(`${root}/ch-${i+1}.json`)));

test('ten French chapters have matching catalogue entries, source text and paragraphs', () => {
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
