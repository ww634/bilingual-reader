import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finalizeDraft, finalizeChapter } from './finalize-chapter.js';
import { romanizeWithMap } from './lib/romanize.js';

const draft = () => ({title:{english:'A Test',hanzi:'试音'},pairs:[{english:'I have understood.',hanzi:'我了解了。',alignment:[{english:'I',hanzi:'我',category:'function_word',is_idiom:false},{english:'understood',hanzi:'了解',category:'verb',is_idiom:false},{english:'have',hanzi:'了',category:'particle',is_idiom:false}]}]});

test('repeated character uses its actual contextual occurrence; input stays untouched', () => {
 const d=draft(), before=structuredClone(d), r=finalizeDraft(d), map=romanizeWithMap(d.pairs[0].hanzi);
 const [a,b]=map.spans[3];
 assert.equal(r.pairs[0].alignment[2].target,map.pinyin.slice(a,b));
 assert.deepEqual(d,before);
 assert.ok(r.pairs.every(p=>! /\p{Script=Han}/u.test(p.target)));
 assert.ok(r.pairs[0].alignment.every(c=>Object.hasOwn(c,'frequency_band')));
});

test('invalid drafts are rejected before persistence', () => {
 const cases=[
 d=>d.title.target='forbidden',
 d=>d.pairs[0].alignment[0].frequency_band='forbidden',
 d=>d.pairs[0].english='',
 d=>d.pairs[0].alignment[0].hanzi='外',
 d=>d.pairs[0].alignment.reverse(),
 d=>d.pairs[0].alignment.splice(0,1),
 d=>d.pairs[0].alignment[0].english='absent',
 d=>d.pairs[0].alignment[0].category='grammar',
 d=>d.pairs[0].alignment[0].is_idiom='false',
 d=>d.pairs[0].alignment=[],
 ];
 for(const mutate of cases){const d=draft();mutate(d);assert.throws(()=>finalizeDraft(d));}
});

test('idioms and proper nouns have null frequency bands',()=>{
 const d={title:{english:'Test',hanzi:'试音'},pairs:[{english:'Zhao finds her proper place.',hanzi:'许照各得其所。',alignment:[{english:'Zhao',hanzi:'许照',category:'proper_noun',is_idiom:false},{english:'finds her proper place',hanzi:'各得其所',category:'idiom',is_idiom:true}]}]};
 assert.deepEqual(finalizeDraft(d).pairs[0].alignment.map(c=>c.frequency_band),[null,null]);
});

test('publication preserves catalog, enforces checkpoint, refuses overwrite, and serializes writers',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'author-finalize-test-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'content/books/test-book'); await fs.mkdir(path.join(dir,'_drafts'),{recursive:true});
 const put=(p,o)=>fs.writeFile(p,JSON.stringify(o));
 const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
 const original={version:2,books:[{id:'untouched',version:8,title:{english:'Old'},chapters:[]}]};
 const libraryPath=path.join(root,'content/library.json'); await put(libraryPath,original);
 await put(path.join(dir,'_series.json'),{title:{english:'Test Book',hanzi:'试音'},synopsis:'A blurb.',genres:['mystery']});
 const statePath=path.join(dir,'_state.json'); await put(statePath,{chapters_written:0});
 const draftPath=path.join(dir,'_drafts/ch-1.draft.json'); await put(draftPath,draft());
 const args={root,bookId:'test-book',chapter:1,draftPath};
 await assert.rejects(finalizeChapter({...args,chapter:2}),/checkpoint|chapters_written/);
 await fs.writeFile(path.join(dir,'_drafts/ch-1.prose.txt'),'Different prose');
 await assert.rejects(finalizeChapter(args),/reproduce/);
 assert.deepEqual(await read(libraryPath),original);
 await fs.writeFile(path.join(dir,'_drafts/ch-1.prose.txt'),'我了解了。');
 const out=await finalizeChapter(args), bytes=await fs.readFile(out.output,'utf8');
 assert.deepEqual(Object.keys(JSON.parse(bytes)).sort(),['id','book_id','language','version','title','pairs','meta'].sort());
 let lib=await read(libraryPath); assert.deepEqual(lib.books[0],original.books[0]);
 assert.equal(lib.books[1].chapters[0].url,'books/test-book/ch-1.json');
 assert.equal(lib.books[1].author,'AI generated');
 assert.equal((await read(statePath)).chapters_written,0);
 assert.match(await fs.readFile(path.join(dir,'cover.svg'),'utf8'),/<svg/);
 await assert.rejects(finalizeChapter(args),/already exists/);
 assert.equal(await fs.readFile(out.output,'utf8'),bytes);
 await assert.rejects(finalizeChapter({...args,chapter:2}),/chapters_written/);
 await put(statePath,{chapters_written:1});
 await fs.writeFile(path.join(dir,'cover.svg'),'<svg>custom</svg>');
 await finalizeChapter({...args,chapter:2});
 lib=await read(libraryPath); assert.deepEqual(lib.books[1].chapters.map(c=>c.id),['ch-1','ch-2']);
 assert.equal(lib.books[1].chapters[0].version,1);
 assert.equal(await fs.readFile(path.join(dir,'cover.svg'),'utf8'),'<svg>custom</svg>');
 const lock=path.join(root,'content/.author-finalize.lock'); await fs.writeFile(lock,'active');
 await assert.rejects(finalizeChapter({...args,chapter:3}),{code:'EEXIST'});
 assert.equal(await fs.readFile(lock,'utf8'),'active');
});
