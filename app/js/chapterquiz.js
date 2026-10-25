// Chapter quizzes use local vocabulary, occurrence counts and the last two
// word sets for this chapter/level. Starting a quiz records a new round;
// previewing the level picker never consumes one.
import { clozeRange, vocabularyKey, vocabularyUnits, distinctOptions } from './learning-utils.js';
import { chunkLevel, NOT_VOCAB, learnerLevel } from './levels.js';
import { getSettings, updateSettings } from './db.js';
export const QUIZ_SIZE = 8;
const TYPES = ['t2e','cloze','dictation','e2t'];
function hash(s) { let h=2166136261; for (const c of s) {h^=c.charCodeAt(0);h=Math.imul(h,16777619)} return h>>>0; }
function rng(seed) {let a=seed;return()=>{a+=0x6d2b79f5;let t=Math.imul(a^(a>>>15),a|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296}}
function shuffled(values, random) {return values.map(value=>({value,tie:random()})).sort((a,b)=>a.tie-b.tie).map(x=>x.value)}
function inEnglish(sentence, gloss) {
 const text=sentence.toLowerCase(),needle=gloss.toLowerCase();
 for(let at=text.indexOf(needle);at>=0;at=text.indexOf(needle,at+1)) {
  if(!/[\p{L}\p{N}'’]/u.test(text[at-1]||'')&&!/[\p{L}\p{N}'’]/u.test(text[at+needle.length]||''))return at;
 }
 return -1;
}
export function chapterWords(chapter) {
 const lang=chapter?.language||'zh',seen=new Map();
 for(const pair of chapter?.pairs||[]) {
  let parentCursor=0;
  for(const parent of pair.alignment||[]) {
   const at=pair.target.indexOf(parent.target,parentCursor);if(at>=0)parentCursor=at+parent.target.length;
   for(const c of vocabularyUnits(parent)) {
    const key=vocabularyKey(c.hanzi||c.target,lang),gloss=(c.english||'').trim(),eAt=inEnglish(pair.english||'',gloss);
    if(!key||NOT_VOCAB.has(c.category)||!/[\p{L}]/u.test(key)||/^\p{N}/u.test(key))continue;
    if(gloss.length<3||gloss.length>40||/^[([\]]/.test(gloss)||eAt<0)continue;
    if(eAt>0&&/^[A-Z]/.test(gloss)&&/\s/.test(gloss))continue;
    if(seen.has(key)){seen.get(key).count++;continue}
    const start=at<0?null:at+(c===parent?0:c.start);
    seen.set(key,{id:key,hanzi:c.hanzi||c.target,pinyin:lang==='zh'&&c.hanzi?c.target:'',english:gloss[0].toLowerCase()+gloss.slice(1),lang,category:c.category||null,frequency_band:c.frequency_band||null,level:chunkLevel(c,lang),count:1,context:{hanzi:pair.hanzi||pair.target,target:pair.target,english:pair.english,targetStart:start,hanziStart:c.hanzi?pair.hanzi?.indexOf(c.hanzi):null}});
   }
  }
 }
 return [...seen.values()];
}
export function wordsPerLevel(chapter) {const result={};for(const word of chapterWords(chapter)){const l=Math.min(word.level,6);result[l]=(result[l]||0)+1}return result}
export function buildChapterQuiz(chapter,level,{bookId='',size=QUIZ_SIZE,history=[]}={}) {
 const words=chapterWords(chapter),random=rng(hash(`${bookId}/${chapter?.id}/${level}/${JSON.stringify(history)}`));
 const recent=new Set(history.slice(-2).flat()),ranked=shuffled(words,random).sort((a,b)=>Math.abs(Math.min(a.level,6)-level)-Math.abs(Math.min(b.level,6)-level)||a.level-b.level||b.count-a.count);
 const picked=ranked.filter(w=>!recent.has(w.id)).slice(0,size);
 if(picked.length<size){const repeat=ranked.find(w=>recent.has(w.id));if(repeat)picked.push(repeat)}
 const types=shuffled(TYPES,random);
 const cards=picked.map((item,i)=>{let dir=types[i%types.length];if(dir==='cloze'&&!clozeRange(item.context.hanzi,item.hanzi,item.lang==='zh'?item.context.hanziStart:item.context.targetStart))dir='t2e';const options=distinctOptions(item,shuffled(words,random).sort((a,b)=>(a.category===item.category?-1:0)-(b.category===item.category?-1:0)),dir).slice(0,3);return {item,dir,options}});
 return {cards:words.length>=4?cards:[],level,available:words.length};
}
export async function nextChapterQuiz(chapter,level,options={}) {
 const key=`${options.bookId||chapter.book_id}/${chapter.id}/${level}`,settings=await getSettings();
 const quiz=buildChapterQuiz(chapter,level,{...options,history:settings.chapterQuizHistory?.[key]||[]});
 if(quiz.cards.length)await updateSettings(s=>({chapterQuizHistory:{...s.chapterQuizHistory,[key]:[...(s.chapterQuizHistory?.[key]||[]),quiz.cards.map(c=>c.item.id)].slice(-2)}}));
 return quiz;
}
export function bookQuizPrefs(settings,bookId,lang=settings?.learningLanguage||'zh') {const p=settings?.bookQuiz?.[bookId]||{};return {on:p.on!==false,level:Math.min(6,Math.max(1,parseInt(p.level,10)||learnerLevel(settings,lang)))}}
