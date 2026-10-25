const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),cp=require('node:child_process');
test('French quiz vocabulary uses individual lookups and canonical ids',async()=>{
 const {chapterWords,buildChapterQuiz}=await import('../app/js/chapterquiz.js');
 const p={target:'Il pose la fourchette.',english:'He puts down the fork.',alignment:[{target:'Il pose la fourchette',english:'He puts down the fork',lookup:[{target:'Il',english:'he',category:'function_word',start:0,end:2},{target:'pose',english:'puts down',category:'verb',start:3,end:7},{target:'la',english:'the',category:'function_word',start:8,end:10},{target:'fourchette',english:'fork',category:'noun',start:11,end:21}]}]};
 const words=chapterWords({language:'fr',pairs:[p,p]});assert.ok(words.some(w=>w.id==='fourchette'&&w.count===2));assert.ok(!words.some(w=>w.id.includes('fourchette')&&w.id!=='fourchette'));assert.equal(words.find(w=>w.id==='pose').english,'puts down');
 const chapter={id:'ch-qa',language:'fr',pairs:Array.from({length:30},(_,i)=>({target:`mot${i}`,english:`meaning${i}`,alignment:[{target:`mot${i}`,english:`meaning${i}`,category:'noun',frequency_band:'common'}]}))};
 chapter.pairs.push(...Array(5).fill(chapter.pairs[10]));
 const first=buildChapterQuiz(chapter,3);assert.equal(first.cards[0].item.id,'mot10');
 const second=buildChapterQuiz(chapter,3,{history:[first.cards.map(c=>c.item.id)]});const third=buildChapterQuiz(chapter,3,{history:[first.cards.map(c=>c.item.id),second.cards.map(c=>c.item.id)]});const recent=new Set([...first.cards,...second.cards].map(c=>c.item.id));assert.ok(third.cards.filter(c=>recent.has(c.item.id)).length<=1);
});
test('choices reject duplicate meanings, duplicate words and sound-alike pinyin',async()=>{
 const {distinctOptions,sentenceAnswer}=await import('../app/js/learning-utils.js');
 const answer={id:'妈',hanzi:'妈',english:'mother',pinyin:'mā'};
 const options=distinctOptions(answer,[{id:'马',hanzi:'马',english:'horse',pinyin:'mǎ'},{id:'m',hanzi:'妈妈',english:'Mother',pinyin:'māma'},{id:'one',hanzi:'爸爸',english:'father',pinyin:'bàba'},{id:'two',hanzi:'爸爸',english:'dad',pinyin:'baba'}],'dictation');assert.equal(options.length,1);assert.equal(options[0].hanzi,'爸爸');
 assert.equal(sentenceAnswer('« Il a faim ! »','Il a faim.'),true);assert.equal(sentenceAnswer('Il a pas faim.','Il a faim.'),false);assert.equal(sentenceAnswer('Jai une fourchette','J’ai une fourchette.'),true);assert.equal(sentenceAnswer('chat','Le chat est ici.'),false);
});
test('sentence and paragraph repair preserves every novel word, gloss and lookup',()=>{
 const hash=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
 const baseline=JSON.parse(fs.readFileSync('tools/qa/repairs/french-paragraphs-baseline.json'));
 for(const old of baseline.chapters){const current=JSON.parse(fs.readFileSync(`content/books/${baseline.book_id}/${old.id}.json`));
  if(current.version!==old.repair_version)continue; // Later authorized repairs have their own release receipts.
  assert.equal(hash(current.pairs.map(p=>p.target).join(' ')),old.french_sha256);assert.equal(hash(current.pairs.map(p=>p.english).join(' ')),old.english_sha256);assert.equal(hash(JSON.stringify(current.pairs.flatMap(p=>p.alignment))),old.alignment_sha256);assert.ok(current.pairs[0].paragraph_start);assert.equal(current.meta.sentence_unit_repair.pair_index_map.length,old.pairs);
 }
});
test('English ownership rejects shared spans, substrings and partial contractions',async()=>{
 const {assertEnglishSpans}=await import('../tools/translate/lib/english-spans.js');
 for(const pair of [{english:'picked',alignment:[{english:'picked'},{english:'picked'}]},{english:'spring',alignment:[{english:'in'}]},{english:"you've",alignment:[{english:'you'}]}])assert.throws(()=>assertEnglishSpans(pair));
 assert.equal(assertEnglishSpans({english:'I have understood.',alignment:[{english:'I'},{english:'understood'},{english:'have'}]}).length,3);
});
test('French sentence boundaries keep closing quotes, names and English I separate',async()=>{
 const {sentenceSegments}=await import('../tools/translate/lib/french-sentences.js');
 assert.equal(sentenceSegments('« Oui. Au sec. »').map(s=>s.text).join(' '),'« Oui. Au sec. »');assert.equal(sentenceSegments('« P. Durand — 18 h 30 ».').length,1);assert.equal(sentenceSegments('“So did I. Back then.”','en').length,2);
});
test('AI requests time out or cancel without making an external request',async()=>{
 const {requestAI}=await import('../app/js/ai-request.js');const original=global.fetch;
 global.fetch=async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true}));
 try{await assert.rejects(requestAI('https://example.invalid',{}, {timeoutMs:5}),e=>e.code==='timeout');const ctl=new AbortController();const request=requestAI('https://example.invalid',{}, {signal:ctl.signal});ctl.abort();await assert.rejects(request,e=>e.code==='cancelled');}finally{global.fetch=original}
});
test('practice requests scale their word list and Chinese chunks retain digits',async()=>{
 const {createRequire}=await import('node:module');const pinyin=createRequire(require('node:path').resolve('tools/translate/package.json'))('pinyin-pro');
 const ctx=vm.createContext({console,window:{pinyinPro:pinyin},document:{},chunkLevel:()=>2,bandForLevel:()=> 'very_common'});
 const source=fs.readFileSync('app/js/stories.js','utf8').replace(/^import[\s\S]*?from "[^\"]+";\n/gm,'').replace(/export /g,'');vm.runInContext(source+'\nglobalThis.api={practiceWordLimit,zhPair};',ctx);
 assert.equal(ctx.api.practiceWordLimit(1,'long'),4);assert.equal(ctx.api.practiceWordLimit(6,'short'),4);const pair=ctx.api.zhPair({text:'他喝3杯水。',english:'He drinks three cups of water.',words:[{w:'3杯',english:'three cups',category:'measure_word'}]});assert.match(pair.alignment[0].target,/3/);
});
test('legacy level migrates to its selected language and French lookups affect knowledge',async()=>{
 const source=fs.readFileSync('app/js/db.js','utf8');const fn=source.match(/function normalizeSettings\(stored = \{\}\) \{[\s\S]*?\n\}/)[0];const normalize=vm.runInNewContext('('+fn+')',{DEFAULT_SETTINGS:{}});assert.equal(normalize({myLevel:5,learningLanguage:'fr'}).myLevel.fr,5);assert.equal(normalize({myLevel:5,learningLanguage:'fr'}).myLevel.zh,2);assert.equal(normalize({myLevel:4}).myLevel.zh,4);
 const {chapterKnowledge}=await import('../app/js/levels.js');const chapter={language:'fr',pairs:[{alignment:[{target:'Il mange',lookup:[{target:'Il',frequency_band:'very_common'},{target:'mange',frequency_band:'common'}]}]}]};const report=chapterKnowledge(chapter,1,new Map([['il','mastered']]));assert.equal(report.total,2);assert.equal(report.known,1);
});
