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


test('canal records and classroom readings keep lexical context', () => {
 const r = (text, char) => { const m=romanizeWithMap(text); return m.srcChars.flatMap((c,i)=>c===char?[m.pinyin.slice(...m.spans[i])]:[]); };
 for (const text of ['种得太迟','笑得手一歪','搁得像垃圾','走得比来时慢','骂得很响','挂得太低','咬得比谁都快','酸得眼角一缩','画得几乎一样','画得太小','绷得发酸','动得多些']) assert.deepEqual(r(text,'得'),['de'],text);
 for (const text of ['得请渠务所来','得等渠务所','得看去哪儿','得看撑船的人','得算他的活','得先知道','得画大一点']) assert.deepEqual(r(text,'得'),['děi'],text);
 assert.deepEqual(r('芥菜种得太迟','种'),['zhòng']);
 assert.deepEqual(r('这包菜种','种'),['zhǒng']);
 assert.deepEqual(r('她把纸还给他','还'),['huán']);
 assert.deepEqual(r('没还的书','还'),['huán']);
 assert.deepEqual(r('书还在这里','还'),['hái']);
 assert.deepEqual(r('冲孩子吵','冲'),['chòng']);
 assert.deepEqual(r('冲洗菜叶','冲'),['chōng']);
 for (const text of ['倒像她不讲理','倒不是黑','倒没人再睡','倒把塔维看愣']) assert.deepEqual(r(text,'倒'),['dào'],text);
 assert.deepEqual(r('跌倒','倒'),['dǎo']);
 assert.deepEqual(r('轻咳一声','咳'),['ké']);
 assert.deepEqual(r('夹固','夹'),['jiā']);
 assert.deepEqual(r('夹进纸缝','夹'),['jiā']);
 assert.deepEqual(r('守着力','着'),['zhe']);
 for (const text of ['册子','匣子','果子']) assert.deepEqual(r(text,'子'),['zi'],text);
 for (const text of ['只换板子','只咬一口','只看一眼','只看了几眼','只叫他看看']) assert.deepEqual(r(text,'只'),['zhǐ'],text);
 assert.deepEqual(r('轻载下','载'),['zài']);
 assert.deepEqual(r('记载','载'),['zǎi']);
});


test('letters and shared-room contexts preserve grammatical readings', () => {
 const r=(text,char)=>{const m=romanizeWithMap(text);return m.srcChars.flatMap((c,i)=>c===char?[m.pinyin.slice(...m.spans[i])]:[]);};
 for(const text of ['吹得乱响','拆得出来','答得干脆','听得出来','笑得刚按住','响得不肯讲道理','说得很平','小得出奇','写得太宽','压得很平','写得很重','说得不大妥当','干得很慢']) assert.deepEqual(r(text,'得'),['de'],text);
 for(const text of ['还得自己开口','这得问她','还得站着等']) assert.deepEqual(r(text,'得'),['děi'],text);
 assert.deepEqual(r('怔了一下','怔'),['zhèng']);
 assert.deepEqual(r('出了事','了'),['le']);
 assert.deepEqual(r('上次数错了','数'),['shǔ']);
 assert.deepEqual(r('次数很多','数'),['shù']);
 assert.deepEqual(r('他没收到信','没'),['méi']);
 assert.deepEqual(r('没收财物','没'),['mò']);
 assert.deepEqual(r('碟子和豆子镊子肚子脑子','子'),['zi','zi','zi','zi','zi']);
 for(const text of ['只差最后一点','只写另行通知','只问一次','只问洛衡','只写还没有']) assert.deepEqual(r(text,'只'),['zhǐ'],text);
 for(const text of ['倒让他不知','倒记得很清楚','倒一点不嫌累']) assert.deepEqual(r(text,'倒'),['dào'],text);
});


test('courtyard songs distinguish melody, counting and returning a bowl', () => {
 const r=(text,char)=>{const m=romanizeWithMap(text);return m.srcChars.flatMap((c,i)=>c===char?[m.pinyin.slice(...m.spans[i])]:[]);};
 for(const text of ['熏得闭了一只眼','饿得去吃纸']) assert.deepEqual(r(text,'得'),['de'],text);
 assert.deepEqual(r('得坐下来谈','得'),['děi']);
 for(const text of ['只托伊文带话','只会后半段','只从回来的人嘴里']) assert.deepEqual(r(text,'只'),['zhǐ'],text);
 assert.deepEqual(r('那条岔出去的调','调'),['diào']);
 assert.deepEqual(r('调节水流','调'),['tiáo']);
 assert.deepEqual(r('数了两颗','数'),['shǔ']);
 assert.deepEqual(r('倒没有谁','倒'),['dào']);
 assert.deepEqual(r('把碗还给他','还'),['huán']);
 assert.deepEqual(r('碗还在桌上','还'),['hái']);
});


test('map lending and modal contexts retain their contextual readings',()=>{
 const r=(text,char)=>{const m=romanizeWithMap(text);return m.srcChars.flatMap((c,i)=>c===char?[m.pinyin.slice(...m.spans[i])]:[]);};
 assert.deepEqual(r('卷好的纸','卷'),['juǎn']);
 assert.deepEqual(r('不过要还','还'),['huán']);
 for(const text of ['这张我得留着','还得从脚下重新看']) assert.deepEqual(r(text,'得'),['děi'],text);
 assert.deepEqual(r('吹得轻轻碰墙','得'),['de']);
 assert.deepEqual(r('只肯给我看好看的','只'),['zhǐ']);
 assert.deepEqual(r('要还有问题就问','还'),['hái']);
});


test('meeting records keep line, return and left-behind readings distinct',()=>{
 const r=(text,char)=>{const m=romanizeWithMap(text);return m.srcChars.flatMap((c,i)=>c===char?[m.pinyin.slice(...m.spans[i])]:[]);};
 assert.deepEqual(r('那行住处保留','行'),['háng']);
 assert.deepEqual(r('把候车棚草图还给他','还'),['huán']);
 assert.deepEqual(r('只问纸够不够','只'),['zhǐ']);
 assert.deepEqual(r('笑得把信封也抖了一下','得'),['de']);
 assert.deepEqual(r('谁把杯子落在那里了','落'),['là']);
 assert.deepEqual(r('落在地上','落'),['luò']);
});


test('packing and woodwork contexts keep action and particle readings',()=>{
 const r=(text,char)=>{const m=romanizeWithMap(text);return m.srcChars.flatMap((c,i)=>c===char?[m.pinyin.slice(...m.spans[i])]:[]);};
 for(const text of ['描得深了些','笑得写不下字','说得有些快','切得歪','卷得比家信整齐','按得太用力']) assert.deepEqual(r(text,'得'),['de'],text);
 assert.deepEqual(r('那得看他肯不肯','得'),['děi']);
 for(const text of ['别只给一张','只在结尾','只数着日子']) assert.deepEqual(r(text,'只'),['zhǐ'],text);
 for(const text of ['卷着细细的亮屑','卷得比家信整齐']) assert.deepEqual(r(text,'卷'),['juǎn'],text);
 for(const text of ['夹在旧书里','纸夹','夹住萝卜皮']) assert.deepEqual(r(text,'夹'),['jiā'],text);
 assert.deepEqual(r('数着日子','数'),['shǔ']);
});


test('road departure contexts preserve strap, return and grammatical readings',()=>{
 const r=(text,char)=>{const m=romanizeWithMap(text);return m.srcChars.flatMap((c,i)=>c===char?[m.pinyin.slice(...m.spans[i])]:[]);};
 for(const text of ['醒得比钟早','淡得几乎分不清','小得认不出脸','走得远']) assert.deepEqual(r(text,'得'),['de'],text);
 assert.deepEqual(r('还得回去占脸盆','得'),['děi']);
 for(const text of ['只睡了半个脑袋','只叫他自己试试']) assert.deepEqual(r(text,'只'),['zhǐ'],text);
 assert.deepEqual(r('他数过','数'),['shǔ']);
 assert.deepEqual(r('代数过程','数'),['shù']);
 assert.deepEqual(r('惦记着还','还'),['huán']);
 assert.deepEqual(r('肩带勒不勒','勒'),['lēi','lēi']);
 assert.deepEqual(r('重新扎筐','扎'),['zā']);
 assert.deepEqual(r('拿针扎筐底','扎'),['zhā']);
 assert.deepEqual(r('倒是他们','倒'),['dào']);
});


test('wayside conversations preserve growth and grammatical readings',()=>{
 const r=(text,char)=>{const m=romanizeWithMap(text);return m.srcChars.flatMap((c,i)=>c===char?[m.pinyin.slice(...m.spans[i])]:[]);};
 for(const text of ['磨得发白','改得好听']) assert.deepEqual(r(text,'得'),['de'],text);
 for(const text of ['还得自己带灯','这个得等回去']) assert.deepEqual(r(text,'得'),['děi'],text);
 for(const text of ['只肯修山门往上的','只问他昨日','只认到山门']) assert.deepEqual(r(text,'只'),['zhǐ'],text);
 assert.deepEqual(r('只要里头长的','长'),['zhǎng']);
 assert.deepEqual(r('长短不同','长'),['cháng']);
 assert.deepEqual(r('里头长的那一根','长'),['cháng']);
});
