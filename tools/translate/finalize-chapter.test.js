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

test('context distinguishes returning, counting, and the common alternate readings', () => {
 const syllables = (text, char) => {
  const { pinyin, srcChars, spans } = romanizeWithMap(text);
  return srcChars.flatMap((c, i) => c === char ? [pinyin.slice(...spans[i])] : []);
 };
 assert.deepEqual(syllables('简老师把表还给他', '还'), ['huán']);
 assert.deepEqual(syllables('她还给他添了饭', '还'), ['hái']);
 assert.deepEqual(syllables('伸手替他数了一遍', '数'), ['shǔ']);
 assert.deepEqual(syllables('这个数不对', '数'), ['shù']);
});

test('return obligation and a rolled map retain contextual readings', () => {
 const readings = (text, char) => { const m=romanizeWithMap(text);return m.srcChars.flatMap((c,i)=>c===char?[m.pinyin.slice(...m.spans[i])]:[]); };
 assert.deepEqual(readings('完没完都得一道还', '得'), ['děi']);
 assert.deepEqual(readings('完没完都得一道还', '还'), ['huán']);
 assert.deepEqual(readings('将一卷图往前推', '卷'), ['juǎn']);
 assert.deepEqual(readings('纸上还有记号', '还'), ['hái']);
 assert.deepEqual(readings('读完一卷书', '卷'), ['juàn']);
 assert.deepEqual(readings('得空着船撑回来', '得'), ['děi']);
 assert.deepEqual(readings('得空着船撑回来', '空'), ['kōng']);
 assert.deepEqual(readings('我又得听他说', '得'), ['děi']);
 assert.deepEqual(readings('你只付了单程的钱', '只'), ['zhǐ']);
 assert.deepEqual(readings('把纸卷装稳', '卷'), ['juǎn']);
 assert.deepEqual(readings('他得空来坐坐', '得'), ['dé']);
 assert.deepEqual(readings('她说得很干脆', '得'), ['de']);
 assert.deepEqual(readings('嫌她问得烦', '得'), ['de']);
 assert.deepEqual(readings('抱得那么紧', '得'), ['de']);
 assert.deepEqual(readings('得有你真能做的事', '得'), ['děi']);
 assert.deepEqual(readings('妇人拿着长夹', '夹'), ['jiā']);
 assert.deepEqual(readings('取得成绩', '得'), ['dé']);
});


test('workshop and route contexts distinguish modal, particle and tool readings', () => {
 const readings = (text, char) => {const m = romanizeWithMap(text); return m.srcChars.flatMap((c,i) => c === char ? [m.pinyin.slice(...m.spans[i])] : []);};
 for (const text of ['说得慢些', '说得很随意', '问得直接', '装得不对', '洗得比从前黑', '辣得他吸气', '笑得往后仰', '跑得肚子疼', '裂得很长', '浸得发黑', '磨得发亮', '暗得像旧血']) assert.deepEqual(readings(text, '得'), ['de'], text);
 for (const text of ['得翻', '她得分神听', '又得有人来问']) assert.deepEqual(readings(text, '得'), ['děi'], text);
 for (const text of ['剪子', '凳子', '板子', '步子']) assert.deepEqual(readings(text, '子'), ['zi'], text);
 for (const text of ['铁夹', '夹口', '路仍夹在两墙之间']) assert.deepEqual(readings(text, '夹'), ['jiā'], text);
 assert.deepEqual(readings('旋紧螺杆', '旋'), ['xuàn']);
 assert.deepEqual(readings('红漆剥落', '剥'), ['bō']);
 assert.deepEqual(readings('她把图还给他', '还'), ['huán']);
 assert.deepEqual(readings('把纸铺好', '铺'), ['pū']);
 assert.deepEqual(readings('石板还铺着', '铺'), ['pū']);
 assert.deepEqual(readings('他得空来坐坐', '得'), ['dé']);
 assert.deepEqual(readings('取得成绩', '得'), ['dé']);
});
