import test from 'node:test';
import assert from 'node:assert/strict';
import {sentenceCount,inspectChapter,validateReceipt,sha} from './publication.mjs';
const chapter=()=>({id:'ch-1',book_id:'test',language:'fr',version:1,title:{target:'Le retour',english:'The Return'},pairs:[{target:'Elle revient.',english:'She returns.',alignment:[{target:'Elle',english:'She',category:'function_word',frequency_band:'very_common',is_idiom:false,lookup:[{target:'Elle',english:'she',category:'function_word',frequency_band:'very_common',is_idiom:false,start:0,end:4}]},{target:'revient',english:'returns',category:'verb',frequency_band:'common',is_idiom:false,lookup:[{target:'revient',english:'returns',category:'verb',frequency_band:'common',is_idiom:false,start:0,end:7}]}]}]});
const entry=c=>({id:c.id,version:c.version,title:c.title,url:`books/${c.book_id}/${c.id}.json`});
test('Chinese and French sentence ends, titles, decimals and quotations',()=>{
 assert.equal(sentenceCount('风停了。雨还在下。','zh'),2);
 assert.equal(sentenceCount('M. Holt et Mme Holt reviennent.','fr'),1);
 assert.equal(sentenceCount('Mme Holt revient. Elle repart.','fr'),2);
 assert.equal(sentenceCount('Il mesure 1,5 litre.','fr'),1);
 assert.equal(sentenceCount('Elle dit : « Oui ! »','fr'),1);
});
test('French alignment passes without Chinese rules; paragraph, own-gloss and lookup defects fail',async()=>{
 const c=chapter();assert.deepEqual(await inspectChapter(c,entry(c),{id:'test',language:'fr'}),[]);
 for(const change of [c=>c.pairs[0].target+=' Elle repart.',c=>c.pairs[0].alignment[0].english='elsewhere',c=>c.pairs[0].alignment[1].lookup[0].start=1,c=>c.pairs[0].alignment.pop()]){
  const bad=chapter();change(bad);await assert.rejects(inspectChapter(bad,entry(bad),{id:'test',language:'fr'}));
 }
});
test('receipts fail closed on missing reviews, content/catalog/renderer changes, warnings and evidence',()=>{
 const png=Buffer.alloc(128);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
 const expected={book_id:'test',chapter_id:'ch-1',chapter_sha256:'content',catalog_sha256:'catalog',renderer_sha256:'renderer'};
 const r={schema:1,...expected,reviewer:'Authoring agent',reviewed_at:'2026-10-23T12:00:00Z',review:{editorial:'Read and revised scene transitions.',continuity_or_facts:'Checked recent canon and timeline.',english_alignment:'Read each gloss against its own sentence.'},warning_resolutions:{long:'Kept this grammatical sentence after checking its guide layout.'},samples:['beginning','middle','end'].map((section,i)=>({section,pair:[1,3,6][i],width:i===2?1100:390,mode:i===1?'characters':'pinyin',path:'tools/studio/qa/evidence/test/preview.png',sha256:sha(png),notes:'Viewed actual text and meaningful English guides.'}))};
 const run=x=>validateReceipt(x,expected,[{code:'long'}],6,'zh',()=>png);
 assert.doesNotThrow(()=>run(r));
 for(const change of [x=>x.chapter_sha256='old',x=>x.catalog_sha256='old',x=>x.renderer_sha256='old',x=>x.review.editorial=null,x=>x.warning_resolutions={},x=>x.samples.pop(),x=>x.samples[0].sha256='old',x=>x.samples[1].mode='pinyin',x=>x.samples.forEach(s=>s.width=1100)]){const bad=structuredClone(r);change(bad);assert.throws(()=>run(bad));}
 assert.throws(()=>validateReceipt(r,expected,[],6,'zh',()=>null),/evidence/);
});

test('release comparison uses last-live tree, so later docs commits cannot bypass a failed chapter',async t=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {execFileSync}=await import('node:child_process');const {checkRelease}=await import('./publication.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'publication-gate-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const git=(...a)=>execFileSync('git',a,{cwd:root,stdio:['ignore','pipe','pipe']}).toString().trim();
 const write=async(p,v)=>{await fs.mkdir(path.dirname(path.join(root,p)),{recursive:true});await fs.writeFile(path.join(root,p),typeof v==='string'?v:JSON.stringify(v));};
 git('init','-q');git('config','user.email','qa@example.invalid');git('config','user.name','QA fixture');
 await write('app/index.html','<html>Reader fixture</html>');await write('content/library.json',{version:2,books:[{id:'test',language:'fr',chapters:[]}]});
 git('add','.');git('commit','-qm','live fixture');const base=git('rev-parse','HEAD');
 const c=chapter(),e=entry(c);await write('content/books/test/ch-1.json',c);await write('content/library.json',{version:2,books:[{id:'test',language:'fr',chapters:[e]}]});
 git('add','.');git('commit','-qm','unreviewed chapter');await write('README.md','Later documentation edit');git('add','.');git('commit','-qm','docs only');
 await assert.rejects(checkRelease({root,base}),/Missing tools\/studio\/qa/);
 const png=Buffer.alloc(128);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);const imagePath='tools/studio/qa/evidence/test/fixture.png';await fs.mkdir(path.dirname(path.join(root,imagePath)),{recursive:true});await fs.writeFile(path.join(root,imagePath),png);
 const receipt={schema:1,book_id:'test',chapter_id:'ch-1',chapter_sha256:sha(await fs.readFile(path.join(root,'content/books/test/ch-1.json'))),catalog_sha256:sha(JSON.stringify(e)),renderer_sha256:sha(Buffer.concat([Buffer.from('app/index.html\0'),Buffer.from('<html>Reader fixture</html>')])),reviewer:'Fixture reviewer',reviewed_at:'2026-10-23T12:00:00Z',review:{editorial:'Fixture editorial review with specific transitions.',continuity_or_facts:'Fixture continuity checked against previous text.',english_alignment:'Fixture English guide and word gloss review.'},warning_resolutions:{},samples:['beginning','middle','end'].map((section,i)=>({section,pair:1,width:i===2?1100:390,mode:'target',path:imagePath,sha256:sha(png),notes:'Fixture visual evidence for gate testing only.'}))};
 await write('tools/studio/qa/test/ch-1.json',receipt);git('add','.');git('commit','-qm','review fixture');
 assert.equal((await checkRelease({root,base})).chapters,1);
 await write('app/index.html','<html>Changed renderer</html>');git('add','.');git('commit','-qm','renderer changed');
 await assert.rejects(checkRelease({root,base}),/Stale review: renderer/);
});
