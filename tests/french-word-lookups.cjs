const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const dir = 'content/books/la-derniere-voix-claire';
const vocabulary = Object.fromEntries(['words','phrases','verbs','overrides'].map(k => [k, JSON.parse(fs.readFileSync(`${dir}/_src/vocabulary/${k}.json`))]));
const chapter = n => JSON.parse(fs.readFileSync(`${dir}/ch-${n}.json`));
const forkPair = () => chapter(30).pairs.find(p => p.target === 'Daniel a posé sa fourchette.');

function reader() {
  const calls=[];
  const context=vm.createContext({console,window:{addEventListener(){}},document:{},openPopover:(...args)=>calls.push(args)});
  const source=fs.readFileSync('app/js/reader.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export /g,'');
  vm.runInContext(source+'\nglobalThis.api={buildPinyinHtml,handleChunkTap,_state};',context);
  return {context,calls,...context.api};
}

test('compound verb, contextual possessive and noun have independent meanings', () => {
  const p=forkPair();
  assert.deepEqual(p.alignment.flatMap(c=>c.lookup.map(w=>[w.target,w.english])),[
    ['Daniel','Daniel'],['a posé','put down'],['sa','his'],['fourchette','fork']
  ]);
});

test('possessive follows this sentence, not a generic his/her definition', async () => {
  const {frenchLookups}=await import(path.resolve('tools/translate/lib/french-vocabulary.js'));
  for (const [english,poss] of [['put down his fork','his'],['put down her fork','her']]) {
    const result=frenchLookups({target:'a posé sa fourchette',english,frequency_band:'common'},vocabulary);
    assert.equal(result.find(w=>w.target==='sa').english,poss);
    assert.equal(result.find(w=>w.target==='fourchette').english,'fork');
  }
});

test('a smaller noun lookup keeps its contextual sense', async () => {
  const {frenchLookups}=await import(path.resolve('tools/translate/lib/french-vocabulary.js'));
  for (const [target,english,noun,meaning] of [
    ['la pièce','the room','pièce','room'],
    ['les pièces','the documents','pièces','documents'],
    ['les pièces','the parts','pièces','parts'],
    ['une chemise','a shirt','chemise','shirt'],
    ['une chemise','a folder','chemise','folder'],
  ]) {
    assert.equal(frenchLookups({target,english},vocabulary).find(w=>w.target===noun).english,meaning);
  }
});

test('French target renders separate selectable spans and preserves exact text', () => {
  const r=reader(),p=forkPair();
  const {html}=r.buildPinyinHtml([p],37);
  assert.equal(html.replace(/<[^>]*>/g,''),p.target);
  assert.match(html,/data-lookup="0"[^>]*>a posé<\/span>/);
  assert.match(html,/data-lookup="1"[^>]*>sa<\/span>/);
  assert.match(html,/data-lookup="2"[^>]*>fourchette<\/span>/);
  assert.equal((html.match(/data-pair="37"/g)||[]).length,4);
});

test('tapping any of those spans opens only that entry; English phrase clicks still work', () => {
  const r=reader(),p=forkPair();r._state.chapter={pairs:[p]};
  for (const [index,target,english] of [[0,'a posé','put down'],[1,'sa','his'],[2,'fourchette','fork'],[null,'a posé sa fourchette','put down his fork']]) {
    const el={dataset:{uid:'p0c1',...(index===null?{}:{lookup:String(index)})},
      hasAttribute:k=>k==='data-lookup'&&index!==null,
      classList:{contains:c=>c==='chunk'},closest:()=>({})};
    r.handleChunkTap({target:{closest:()=>el}});
    assert.equal(r.calls.at(-1)[0].target,target);assert.equal(r.calls.at(-1)[0].english,english);
  }
});

test('legacy books without word annotations retain their original spans', () => {
  const r=reader();const p={target:'你好',english:'Hello',alignment:[{target:'你好',english:'Hello',category:'verb',hanzi:'你好'}]};
  const {html}=r.buildPinyinHtml([p]);assert.doesNotMatch(html,/data-lookup/);assert.match(html,/>你好<\/span>/);
});

test('all 41 chapters have complete, ordered, non-overlapping vocabulary coverage', () => {
  let units=0;
  for(let n=1;n<=41;n++) for(const pair of chapter(n).pairs) for(const c of pair.alignment) {
    assert.ok(c.lookup?.length,`${n}: ${c.target}`);
    let cursor=0;
    for(const w of c.lookup) {
      assert.ok(w.start>=cursor && w.end>w.start);
      assert.equal(c.target.slice(w.start,w.end),w.target);
      assert.ok(!/[\p{L}\p{N}]/u.test(c.target.slice(cursor,w.start)),`${n}: missing prefix`);
      assert.ok(w.english && !w.english.includes('/'),`${n}: ambiguous gloss ${w.english}`);
      cursor=w.end;units++;
    }
    assert.ok(!/[\p{L}\p{N}]/u.test(c.target.slice(cursor)),`${n}: missing suffix`);
  }
  assert.ok(units>30000);
});

test('phrase senses survive token heuristics and explicit categories control metadata', async () => {
  const {frenchLookups} = await import(path.resolve('tools/translate/lib/french-vocabulary.js'));
  const base = {
    words: { a:{english:'has',category:'verb'}, pourrait:{english:'might',category:'verb'}, commencer:{english:'start',category:'verb'} },
    phrases: {
      "n'est pas":{english:'is not',category:'verb'},
      'se dégrader':{english:'deteriorate',category:'verb'},
      'de nouveau':{english:'again',category:'adverb'}
    }, verbs: {}, overrides: {}
  };
  for (const [target,english,expected] of [["n'est pas","isn't",'is not'], ['se dégrader','decay','deteriorate'], ['de nouveau commencer','start once more','again']]) {
    assert.equal(frenchLookups({target,english,frequency_band:'common'},base)[0].english, expected);
  }
  const chunk={target:'A pourrait',english:'A might',frequency_band:'common'};
  const custom={...base,overrides:{[JSON.stringify([chunk.target,chunk.english])]:{'0':{english:'A',category:'proper_noun'}}}};
  const units=frenchLookups(chunk,custom);
  assert.deepEqual(units.map(w => w.target),['A','pourrait']);
  assert.equal(units[0].category,'proper_noun');
  assert.equal(units[0].frequency_band,null);
});
