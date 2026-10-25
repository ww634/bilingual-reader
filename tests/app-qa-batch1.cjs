const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('typed answers require complete senses or exact pinyin',async()=>{
 const {englishAnswer,normalizePinyin,clozeRange}=await import('../app/js/learning-utils.js');
 for(const [given,meaning,ok] of [['o','colour',false],['colour','colour',true],['color','colour',true],['not to run','to run',false],['run','to run',true],['fork','a fork',true],['colur','colour',true],['put','put down',false],['put down','put down',true],['a','colour',false],['shade','colour; shade',true]]) assert.equal(englishAnswer(given,meaning),ok,`${given} / ${meaning}`);
 for(const given of ['a','se','yan'])assert.notEqual(normalizePinyin(given),normalizePinyin('yánsè'));
 for(const given of ['yanse','yan se','yán sè'])assert.equal(normalizePinyin(given),normalizePinyin('yánsè'));
 assert.equal(normalizePinyin('lv'),normalizePinyin('lǜ'));
 assert.deepEqual(clozeRange('Le pain est dans le panier.','pain'),{start:3,end:7});
 assert.equal(clozeRange('Il dit il viendra.','il'),null);
 assert.equal(clozeRange('spring','in'),null);
});
test('English exact colours never match fragments or parts of contractions',()=>{
 const ctx=vm.createContext({console,window:{addEventListener(){}},document:{}});
 const source=fs.readFileSync('app/js/reader.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export /g,'');
 vm.runInContext(source+'\nglobalThis.api={buildEnglishCoverage,findChunkPositions,emitEnglishSlice,bestEnglishCut};',ctx);
 const pair={target:'he in you',english:"When spring comes, you've seen him.",alignment:[{target:'he',english:'he'},{target:'in',english:'in'},{target:'you',english:'you'}]};
 assert.ok(ctx.api.buildEnglishCoverage(pair).every(x=>x===null));
 const fr={target:'parfois convient',english:'sometimes fits',alignment:[{target:'parfois convient',english:'sometimes fits',category:'verb',lookup:[{target:'parfois',english:'sometimes',category:'adverb'},{target:'convient',english:'fits',category:'verb'}]}]};
 const html=ctx.api.emitEnglishSlice(fr,ctx.api.buildEnglishCoverage(fr),0,fr.english.length);
 assert.match(html,/data-cat="adverb"[^>]*data-hanzi="parfois"[^>]*>sometimes/);
 assert.match(html,/data-cat="verb"[^>]*>fits/);
});
