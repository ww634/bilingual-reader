#!/usr/bin/env node
import { sentenceSegments } from '../translate/lib/french-sentences.js';
import { assertEnglishSpans } from "../translate/lib/english-spans.js";
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertSentenceUnit } from '../translate/lib/sentences.js';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const fail = (ok, message) => { if (!ok) throw Error(message); };
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cats = new Set(['noun','verb','adjective','adverb','function_word','measure_word','particle','proper_noun','idiom']);
const bands = new Set([null,'very_common','common','uncommon','rare']);
const meaningful = /[\p{L}\p{N}]/u;
export function sentenceCount(text, language) {
  if (language === 'zh') { try { assertSentenceUnit(text); return 1; } catch { return 2; } }
  return sentenceSegments(text, language).length;
}
export async function inspectChapter(c, entry, book) {
  fail(c && /^ch-[1-9]\d*$/.test(c.id ?? ''), 'Invalid chapter id');
  fail(c.book_id === book.id && c.language === book.language, 'Book/language mismatch');
  fail(Number.isSafeInteger(c.version) && c.version > 0, 'Invalid chapter version');
  fail(entry?.id === c.id && entry.version === c.version && isDeepStrictEqual(entry.title,c.title) && entry.url === `books/${book.id}/${c.id}.json`, 'Chapter/catalog mismatch');
  for (const k of ['target','english']) fail(typeof c.title?.[k] === 'string' && c.title[k].trim(), `Missing title.${k}`);
  fail(Array.isArray(c.pairs) && c.pairs.length, 'No pairs');
  fail(c.meta?.has_alignment===true&&c.meta.alignment_complete===true&&typeof c.meta.source==='string'&&c.meta.source.trim()&&/^\d{4}-\d{2}-\d{2}$/.test(c.meta.createdAt??''),'Missing/incomplete chapter metadata');
  const warnings=[];
  c.pairs.forEach((p,i)=>{
    const label=`pair ${i+1}`, source=c.language==='zh'?p.hanzi:p.target;
    for (const value of [source,p.target,p.english]) fail(typeof value==='string' && value.trim(), `${label}: missing text/gloss`);
    fail(sentenceCount(source,c.language)<=1, `${label}: multi-sentence paragraph pair`);
    const length=c.language==='zh'?[...source].filter(x=>/\p{Script=Han}/u.test(x)).length:source.split(/\s+/).length;
    if(length>(c.language==='zh'?80:55))warnings.push({code:`pair-${i+1}-long-source`,detail:`${length} ${c.language==='zh'?'Han characters':'words'}; inspect natural clause boundaries and guide layout`});
    fail(Array.isArray(p.alignment)&&p.alignment.length,`${label}: missing alignment`);
    let cursor=0;
    p.alignment.forEach((w,j)=>{
      const text=c.language==='zh'?w.hanzi:w.target, at=source.indexOf(text,cursor);
      fail(typeof text==='string'&&text.trim()&&at>=cursor&&!meaningful.test(source.slice(cursor,at)),`${label}, word ${j+1}: source coverage/order`);
      cursor=at+text.length;
      fail(typeof w.target==='string'&&w.target.trim(),`${label}: missing target gloss`);
      fail(typeof w.english==='string'&&w.english.trim()&&p.english.toLowerCase().includes(w.english.toLowerCase()),`${label}, word ${j+1}: English span outside own pair`);
      fail(cats.has(w.category)&&bands.has(w.frequency_band)&&typeof w.is_idiom==='boolean',`${label}: invalid category/band/idiom`);
      const size=c.language==='zh'?[...text].filter(x=>/\p{Script=Han}/u.test(x)).length:text.split(/\s+/).length;
      if(size>6&&!['proper_noun','idiom'].includes(w.category))warnings.push({code:`pair-${i+1}-chunk-${j+1}-coarse`,detail:'Large chunk; inspect vocabulary granularity and line alignment'});
      if(c.language==='fr') {
        fail(Array.isArray(w.lookup)&&w.lookup.length,`${label}: French contextual word lookup missing`);
        let end=0;
        for(const l of w.lookup){
          fail(Number.isSafeInteger(l.start)&&Number.isSafeInteger(l.end)&&l.start>=end&&l.end>l.start&&text.slice(l.start,l.end)===l.target&&!meaningful.test(text.slice(end,l.start)),`${label}: lookup offsets/coverage`);
          fail(typeof l.english==='string'&&l.english.trim()&&cats.has(l.category)&&bands.has(l.frequency_band)&&typeof l.is_idiom==='boolean',`${label}: invalid lookup gloss`);end=l.end;
        }
        fail(!meaningful.test(text.slice(end)),`${label}: uncovered lookup word`);
      }
    });
    fail(!meaningful.test(source.slice(cursor)),`${label}: uncovered trailing words`);
  });
  if(c.language==='zh') {
    c.pairs.forEach((p,i)=>assertEnglishSpans(p,`pair ${i+1}`));
    const {finalizeDraft}=await import('../translate/finalize-chapter.js');
    const raw={title:{hanzi:c.title.hanzi,english:c.title.english},pairs:c.pairs.map(p=>({hanzi:p.hanzi,english:p.english,alignment:p.alignment.map(w=>({hanzi:w.hanzi,english:w.english,category:w.category,is_idiom:w.is_idiom}))}))};
    const expected=finalizeDraft(raw);
    fail(isDeepStrictEqual(expected.title,c.title)&&isDeepStrictEqual(expected.pairs,c.pairs),'Chinese generated pinyin/bands differ from finalizer');
  }
  return warnings;
}
export function validateReceipt(r, expected, warnings, count, language, read) {
  fail(r?.schema===1&&r.book_id===expected.book_id&&r.chapter_id===expected.chapter_id,'Missing/wrong review receipt');
  for(const k of ['chapter_sha256','catalog_sha256','renderer_sha256'])fail(r[k]===expected[k],`Stale review: ${k}`);
  fail(typeof r.reviewer==='string'&&r.reviewer.trim().length>=3&&/^\d{4}-\d{2}-\d{2}T/.test(r.reviewed_at??'')&&Number.isFinite(Date.parse(r.reviewed_at)),'Reviewer/date missing');
  for(const k of ['editorial','continuity_or_facts','english_alignment'])fail(typeof r.review?.[k]==='string'&&r.review[k].trim().length>=20,`Incomplete review: ${k}`);
  for(const w of warnings)fail(typeof r.warning_resolutions?.[w.code]==='string'&&r.warning_resolutions[w.code].trim().length>=20,`Unreviewed warning: ${w.code}`);
  fail(Array.isArray(r.samples),'Reader screenshots missing');
  const expectedPair={beginning:1,middle:Math.ceil(count/2),end:count};
  for(const section of Object.keys(expectedPair)) {
    const s=r.samples.find(s=>s.section===section);
    fail(s&&Number.isInteger(s.pair)&&s.pair>=1&&s.pair<=count&&Math.abs(s.pair-expectedPair[section])<=Math.max(1,Math.floor(count*.15)),`Missing ${section} reader sample`);
  }
  for(const s of r.samples){
    fail(['beginning','middle','end','extra'].includes(s.section)&&Number.isInteger(s.width)&&s.width>=240&&s.width<=4000,'Invalid reader viewport/section');
    fail((language==='zh'?['pinyin','characters']:['target']).includes(s.mode),'Wrong preview script mode');
    fail(typeof s.notes==='string'&&s.notes.trim().length>=20,'Visual review findings missing');
    fail(/^tools\/studio\/qa\/evidence\/[a-zA-Z0-9_./-]+\.png$/.test(s.path??'')&&!s.path.includes('..'),'Invalid screenshot path');
    const bytes=read(s.path);fail(bytes&&bytes.length>100&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&sha(bytes)===s.sha256,'Missing/stale PNG evidence');
  }
  fail(r.samples.some(s=>s.width<=480),'Phone preview missing');
  if(language==='zh')for(const mode of ['pinyin','characters'])fail(r.samples.some(s=>s.mode===mode),`Missing ${mode} preview`);
}
const repoGit=root=>(...args)=>execFileSync('git',args,{cwd:root,maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});
function context(ref,root=ROOT) {
  const git=repoGit(root);
  const read=p=>{
    fail(!p.startsWith('/')&&!p.split('/').includes('..'),'Unsafe repository path');
    try{return ref==='WORKTREE'?fs.readFileSync(path.join(root,p)):git('show',`${ref}:${p}`);}catch{return null;}
  };
  const json=p=>{const b=read(p);fail(b,`Missing ${p}`);return JSON.parse(b);};
  const paths=(ref==='WORKTREE'?git('ls-files','--cached','--others','--exclude-standard','--','app'):git('ls-tree','-r','--name-only',ref,'--','app')).toString().trim().split('\n').filter(Boolean).sort();
  const renderer=sha(Buffer.concat(paths.flatMap(p=>[Buffer.from(p+'\0'),read(p)??Buffer.alloc(0)])));
  return {read,json,renderer};
}
export function validateRetirement(review, book, prior, ctx) {
  fail(review?.schema === 1 && review.book_id === book.id, 'Missing book retirement review');
  fail(review.catalog_sha256 === sha(JSON.stringify(book)), 'Stale retirement catalog');
  fail(review.renderer_sha256 === ctx.renderer, 'Stale retirement renderer');
  fail(typeof review.reviewer === 'string' && review.reviewer.length >= 3 && Number.isFinite(Date.parse(review.reviewed_at)), 'Retirement reviewer/date missing');
  for (const key of ['authorization', 'reason', 'local_data_migration']) fail(typeof review[key] === 'string' && review[key].trim().length >= 30, `Retirement review missing ${key}`);
  for (const entry of book.chapters) {
    const p = `content/${entry.url}`;
    fail(!ctx.read(p), `Retired chapter still published: ${p}`);
    fail(review.chapter_sha256?.[entry.id] === sha(prior.read(p)), 'Stale retirement content');
  }
  for (const scenario of ['downloaded_read', 'remove_download']) {
    const sample = review.samples?.find(s => s.scenario === scenario);
    fail(sample && sample.width >= 240 && sample.width <= 480 && sample.notes?.length >= 20, `Retirement phone preview missing: ${scenario}`);
    fail(/^docs\/qa-evidence\/[a-zA-Z0-9_./-]+\.png$/.test(sample.path || '') && !sample.path.includes('..'), 'Invalid retirement evidence path');
    const image = ctx.read(sample.path);
    fail(image?.length > 100 && image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && sha(image) === sample.sha256, 'Stale retirement preview');
  }
}

export async function checkRelease({base,head='HEAD',root=ROOT}) {
  const git=repoGit(root);
  fail(/^[0-9a-f]{40}$/.test(base??''),'--base must be the full last-live commit SHA');
  const ctx=context(head,root),prior=context(base,root),catalog=ctx.json('content/library.json'),old=prior.json('content/library.json');
  const args=['diff','--name-only',base];if(head!=='WORKTREE')args.push(head);args.push('--','content/books','content/library.json');
  const changed=new Set(git(...args).toString().split('\n').filter(p=>/^content\/books\/[^/]+\/ch-\d+\.json$/.test(p)));
  for(const book of catalog.books)for(const e of book.chapters){const before=old.books.find(b=>b.id===book.id)?.chapters.find(c=>c.id===e.id);if(!isDeepStrictEqual(before,e))changed.add(`content/${e.url}`);}
  const retired = new Set();
  for (const book of old.books) {
    const current = catalog.books.find(b => b.id === book.id);
    if (!current) {
      validateRetirement(ctx.json(`tools/qa/retirements/${book.id}.json`), book, prior, ctx);
      retired.add(book.id);
    } else for (const e of book.chapters) fail(current.chapters.some(c => c.id === e.id), `Chapter removal needs a separately reviewed migration: ${book.id}/${e.id}`);
  }
  for (const p of changed) if (retired.has(p.split('/')[2])) changed.delete(p);
  let desktop=false;
  for(const p of changed){
    const c=ctx.json(p);fail(p===`content/books/${c.book_id}/${c.id}.json`,'Chapter path/identity mismatch');const book=catalog.books.find(b=>b.id===c.book_id);fail(book,`Missing book ${c.book_id}`);
    const entry=book.chapters.find(e=>e.id===c.id),warnings=await inspectChapter(c,entry,book);
    const previous=prior.read(p);if(previous)fail(c.version>JSON.parse(previous).version,`${p}: edited chapter must bump version`);
    const expected={book_id:c.book_id,chapter_id:c.id,chapter_sha256:sha(ctx.read(p)),catalog_sha256:sha(JSON.stringify(entry)),renderer_sha256:ctx.renderer};
    const receipt=ctx.json(`tools/studio/qa/${c.book_id}/${c.id}.json`);
    validateReceipt(receipt,expected,warnings,c.pairs.length,c.language,ctx.read);
    desktop ||= receipt.samples.some(s=>s.width>=900);
  }
  fail(!changed.size||desktop,'Batch desktop preview missing');
  return {chapters:changed.size,base,head};
}
async function main(){
  const [command,...args]=process.argv.slice(2);const opts={};for(let i=0;i<args.length;i+=2){fail(args[i].startsWith('--')&&args[i+1],'Expected --option value');opts[args[i].slice(2)]=args[i+1];}
  if(command==='check')console.log(JSON.stringify(await checkRelease({base:opts.base,head:opts.head??'HEAD'})));
  else if(command==='prepare'){
    const ctx=context('WORKTREE'),p=opts.chapter;fail(/^content\/books\/[^/]+\/ch-\d+\.json$/.test(p??''),'--chapter must be a reader chapter path');
    const c=ctx.json(p),book=ctx.json('content/library.json').books.find(b=>b.id===c.book_id);fail(book,'Missing book');
    const entry=book.chapters.find(e=>e.id===c.id),warnings=await inspectChapter(c,entry,book);
    const receipt={schema:1,book_id:c.book_id,chapter_id:c.id,chapter_sha256:sha(ctx.read(p)),catalog_sha256:sha(JSON.stringify(entry)),renderer_sha256:ctx.renderer,reviewer:null,reviewed_at:null,review:{editorial:null,continuity_or_facts:null,english_alignment:null},warning_resolutions:Object.fromEntries(warnings.map(w=>[w.code,null])),samples:[]};
    fail(opts.out,'--out required');fs.writeFileSync(path.resolve(opts.out),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:'INCOMPLETE—review and screenshots still required',pairs:c.pairs.length,warnings,out:opts.out}));
  }else throw Error('Use prepare --chapter PATH --out PATH or check --base FULL_SHA [--head HEAD|WORKTREE]');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error('Publication QA:',e.message);process.exitCode=1;});
