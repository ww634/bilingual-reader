const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function backupHarness(){
 const books=new Map([['practice-fr',{id:'practice-fr',language:'fr',title:{english:'Practice'},chapters:[{id:'ch-1',url:'local'}],coverBlob:new Blob(['cover'])}]]);
 const chapters=new Map([['practice-fr/ch-1',{id:'ch-1',book_id:'practice-fr',pairs:[{target:'Bonjour.',english:'Hello.'}]}]]),vault=new Map(),settings={openaiKey:'private-test-key',feedbackToken:'private-test-token',fontSize:'large'};
 const ctx=vm.createContext({console,File,Blob,URL,Date,setTimeout,APP_VERSION:'53',navigator:{canShare:()=>true,share:async()=>{}},window:{dispatchEvent(){}},CustomEvent:class{},
  getAllVaultItems:async()=>[...vault.values()],getVaultItem:async id=>vault.get(id),putVaultItem:async item=>vault.set(item.id,item),getAllProgress:async()=>[],getActivity:async()=>({days:{}}),dayKey:()=> '2026-10-25',getAllBooks:async()=>structuredClone([...books.values()]),getBook:async id=>books.get(id),putBook:async b=>books.set(b.id,b),getChapter:async(b,c)=>structuredClone(chapters.get(`${b}/${c}`)),putChapter:async(b,c,v)=>chapters.set(`${b}/${c}`,v),getSettings:async()=>({...settings}),updateSettings:async p=>Object.assign(settings,p),putProgressRecord:async()=>{},putActivity:async()=>{}});
 const source=fs.readFileSync('app/js/backup.js','utf8').replace(/import[\s\S]*?from "[^\"]+";/g,'').replace(/export /g,'');
 vm.runInContext(source+'\nglobalThis.api={buildBackup,prepareBackup,exportBackup,importBackup};',ctx);return {ctx,...ctx.api,books,chapters,vault,settings};
}
test('backup includes practice stories and safe preferences, never either secret',async()=>{
 const s=backupHarness(),data=await s.buildBackup();assert.equal(data.format,2);assert.equal(data.stories.length,1);assert.equal(data.stories[0].chapters.length,1);assert.equal(data.settings.fontSize,'large');assert.doesNotMatch(JSON.stringify(data),/private-test|openaiKey|feedbackToken|coverBlob/);
});
test('sharing uses prepared data immediately and cancellation/failure never records a backup',async()=>{
 const s=backupHarness(),prepared=await s.prepareBackup();let called=false;s.ctx.navigator.share=()=>{called=true;return Promise.reject(Object.assign(Error('cancelled'),{name:'AbortError'}));};
 const promise=s.exportBackup(prepared);assert.equal(called,true);assert.equal((await promise).how,'cancelled');assert.equal(s.settings.lastBackupAt,undefined);
 s.ctx.navigator.share=async()=>{throw Error('refused')};assert.equal((await s.exportBackup(prepared)).how,'failed');assert.equal(s.settings.lastBackupAt,undefined);
 s.ctx.navigator.share=async()=>{};assert.equal((await s.exportBackup(prepared)).how,'shared');assert.ok(s.settings.lastBackupAt);
});
test('restore merges practice chapters by id and preserves the device credentials',async()=>{
 const s=backupHarness(),data=await s.buildBackup();data.settings={fontSize:'small',openaiKey:'injected',feedbackToken:'injected'};
 data.stories[0].chapters[0].pairs=[{target:'Changed.'}];data.stories[0].chapters.push({id:'ch-2',book_id:'practice-fr',pairs:[{target:'Salut.'}]});data.stories[0].book.chapters.push({id:'ch-2'});
 const r=await s.importBackup({text:async()=>JSON.stringify(data)});assert.equal(r.stories,1);assert.equal(s.chapters.get('practice-fr/ch-1').pairs[0].target,'Bonjour.');assert.equal(s.chapters.has('practice-fr/ch-2'),true);assert.equal(s.settings.fontSize,'small');assert.equal(s.settings.openaiKey,'private-test-key');assert.equal(s.settings.feedbackToken,'private-test-token');
});

test('persistent audio cache evicts cold clips before played clips and enforces bytes',async()=>{
 const stores=new Map();const url=k=>typeof k==='string'?new URL(k,'https://reader.test/app/').href:k.url;
 const cache=name=>{if(!stores.has(name))stores.set(name,new Map());const map=stores.get(name);return {match:async k=>map.get(url(k))?.clone(),put:async(k,v)=>map.set(url(k),v.clone()),delete:async k=>map.delete(url(k)),keys:async()=>[...map.keys()].map(k=>({url:k}))};};
 const ctx=vm.createContext({console,URL,Response,Date,Map,ArrayBuffer,navigator:{},window:{},getSettings:async()=>({}),caches:{open:async n=>cache(n),keys:async()=>[...stores.keys()],delete:async n=>stores.delete(n)}});
 const source=fs.readFileSync('app/js/speech.js','utf8').replace(/import .*?;\n/g,'').replaceAll('import.meta.url','"https://reader.test/app/js/speech.js"').replace(/export /g,'');
 vm.runInContext(source+'\nglobalThis.api={putCachedBytes,noteAudioUse,audioCacheInfo,clearAudioCache,epoch:()=>_audioEpoch};',ctx);
 await ctx.api.putCachedBytes('tts-cache/clip0',new ArrayBuffer(10),0);await ctx.api.noteAudioUse('tts-cache/clip0',null,true);
 for(let i=1;i<=64;i++)await ctx.api.putCachedBytes(`tts-cache/clip${i}`,new ArrayBuffer(10),0);
 const info=await ctx.api.audioCacheInfo();assert.equal(info.entries,64);assert.ok(await cache('tts-audio-v1').match('tts-cache/clip0'));assert.equal(await cache('tts-audio-v1').match('tts-cache/clip1'),undefined);
 await ctx.api.clearAudioCache();const epoch=ctx.api.epoch();await ctx.api.putCachedBytes('tts-cache/large1',new ArrayBuffer(7*1024*1024),epoch);await ctx.api.putCachedBytes('tts-cache/large2',new ArrayBuffer(7*1024*1024),epoch);
 assert.equal((await ctx.api.audioCacheInfo()).entries,1);assert.ok((await ctx.api.audioCacheInfo()).bytes<=12*1024*1024);
});
test('submit and background flush cannot send the same feedback concurrently',async()=>{
 let posts=0,release;const pending=new Promise(resolve=>release=resolve);const item={id:'qa-feedback',status:'pending',createdAt:'2026-10-25',kind:'other',message:'QA fixture',selection:{language:'fr'}};let saved={...item};
 const ctx=vm.createContext({console,Date,Set,APP_VERSION:'53',navigator:{onLine:true},document:{},window:{dispatchEvent(){}},CustomEvent:class{},languageName:()=> 'French',getSettings:async()=>({feedbackRepo:'qa/fixture',feedbackToken:'not-a-real-token'}),getAllFeedback:async()=>[{...saved}],putFeedback:async i=>saved={...i},claimFeedback:async()=>{if(saved.status!=='pending')return false;saved.status='sending';return true},fetch:async()=>{posts++;await pending;return {ok:true,status:201,json:async()=>({number:1,html_url:'https://example.invalid/qa'})}}});
 const source=fs.readFileSync('app/js/feedback.js','utf8').replace(/import .*?;\n/g,'').replace(/export /g,'');vm.runInContext(source+'\nglobalThis.api={send,flushFeedback};',ctx);
 const a=ctx.api.send(item),b=ctx.api.flushFeedback();await b;release();await a;assert.equal(posts,1);assert.equal(saved.status,'sent');
});
