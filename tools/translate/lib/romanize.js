// Deterministic Han (Chinese characters) → tone-marked pinyin with proper
// orthographic word spacing.
//
// Two libraries, each doing what it's best at:
//   - pinyin-pro romanizes characters WITH SENTENCE CONTEXT, so polyphones
//     resolve correctly (了 → "le" as an aspect particle, "liǎo" in 了解).
//   - @node-rs/jieba segments the text into WORDS, so we know which syllables
//     to join ("fùqīn", not "fù qīn").
//
// romanizeWithMap() is the core: it romanizes the whole string in context AND
// returns, per source character, the [start,end) span its pinyin occupies in
// the output. That lets the aligner SLICE a chunk's pinyin straight out of the
// pair's pinyin (instead of romanizing the chunk in isolation, which would
// lose polyphone context — e.g. an isolated 了 → "liǎo"). Sliced chunk pinyin
// is therefore always an exact substring of the pair pinyin.

import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict.js";
import { pinyin } from "pinyin-pro";

const jieba = Jieba.withDict(dict);

// The upstream lexicon misses the return verb 递还. Reuse the unambiguous
// reading from 归还 rather than hand-authoring syllables in chapter data.
const returnSyllable = pinyin("归还", { type: "array", toneType: "symbol" })[1];
const rolledSyllable = pinyin("卷起", { type: "array", toneType: "symbol" })[0];
const obligationSyllable = pinyin("非得", { type: "array", toneType: "symbol" })[1];
const complementSyllable = pinyin("得", { type: "array", toneType: "none" })[0];
const leftBehindSyllable = pinyin("丢三落四", { type: "array", toneType: "symbol" })[2];
const growingSyllable = pinyin("生长", { type: "array", toneType: "symbol" })[1];
const carryingBackSyllable = pinyin("背负", { type: "array", toneType: "symbol" })[0];
const completedSyllable = pinyin("看了", { type: "array", toneType: "symbol" })[1];
const startledSyllable = pinyin("怔", { type: "array", multiple: true, toneType: "symbol" })[1];
const loadSyllable = pinyin("负载", { type: "array", toneType: "symbol" })[1];
const coughSyllable = pinyin("咳嗽", { type: "array", toneType: "symbol" })[0];
const towardSyllable = pinyin("冲", { type: "array", multiple: true, toneType: "symbol" })[1];
const plantingSyllable = pinyin("种", { type: "array", multiple: true, toneType: "symbol" })[1];
const tightenSyllable = pinyin("旋", { type: "array", multiple: true, toneType: "symbol" })[1];
const peelingSyllable = pinyin("剥削", { type: "array", toneType: "symbol" })[0];
const spreadSyllable = pinyin("铺开", { type: "array", toneType: "symbol" })[0];
const neutralZiSyllable = pinyin("子", { type: "array", toneType: "none" })[0];
const grippingSyllable = pinyin("夹子", { type: "array", toneType: "symbol" })[0];
const suppressSyllable = pinyin("屏息", { type: "array", toneType: "symbol" })[0];
const napSyllable = pinyin("睡觉", { type: "array", toneType: "symbol" })[1];
const vacateSyllable = pinyin("空缺", { type: "array", toneType: "symbol" })[0];
const nearSyllable = pinyin("挨近", { type: "array", toneType: "symbol" })[0];
const sufferSyllable = pinyin("挨", { type: "array", toneType: "symbol", multiple: true }).find(s => s !== nearSyllable);
const emptySyllable = pinyin("空船", { type: "array", toneType: "symbol" })[0];
// 系 also defaults to the relationship/system sense in explicit tying phrases.
// Select its other dictionary reading; never store authored pinyin in chapters.
const relationSyllable = pinyin("关系", { type: "array", toneType: "symbol" })[1];
const tieSyllable = pinyin("系", { type: "array", toneType: "symbol", multiple: true })
  .find(syllable => syllable !== relationSyllable);
const tyingWords = new Set(["系鞋带", "系扣子", "系紧", "系牢", "系绳"]);
// Anatomical bending and the back of the hand can be misread across a
// segmentation boundary (手 + 背包). Derive the readings from clear words.
const bendSyllable = pinyin("弯曲", { type: "array", toneType: "symbol" })[1];
const backSyllable = pinyin("背面", { type: "array", toneType: "symbol" })[0];
const againSyllable = pinyin("重新", { type: "array", toneType: "symbol" })[0];
const viscousSyllable = pinyin("粘度", { type: "array", toneType: "symbol" })[0];
const stickSyllable = pinyin("粘", { type: "array", toneType: "symbol", multiple: true })
  .find(syllable => syllable !== viscousSyllable);
const extortSyllable = pinyin("勒索", { type: "array", toneType: "symbol" })[0];
const cinchSyllable = pinyin("勒", { type: "array", toneType: "symbol", multiple: true })
  .find(syllable => syllable !== extortSyllable);
const nailSyllable = pinyin("钉子", { type: "array", toneType: "symbol" })[0];
const fastenSyllable = pinyin("钉", { type: "array", toneType: "symbol", multiple: true })
  .find(syllable => syllable !== nailSyllable);
const transmitSyllable = pinyin("传达", { type: "array", toneType: "symbol" })[0];
const negativeHaveSyllable = pinyin("没有", { type: "array", toneType: "symbol" })[0];
const countSyllable = pinyin("倒数", { type: "array", toneType: "symbol" })[1];
const tradeSyllable = pinyin("行业", { type: "array", toneType: "symbol" })[0];
const giveSyllable = pinyin("给你", { type: "array", toneType: "symbol" })[0];
const heavySyllable = pinyin("沉重", { type: "array", toneType: "symbol" })[1];
const carrySyllable = pinyin("担任", { type: "array", toneType: "symbol" })[0];
const swellSyllable = pinyin("胀", { type: "array", toneType: "symbol" })[0];
const fallSyllable = pinyin("跌倒", { type: "array", toneType: "symbol" })[1];
const pourSyllable = pinyin("倒", { type: "array", toneType: "symbol", multiple: true })
  .find(syllable => syllable !== fallSyllable);
const scatterSyllable = pinyin("播撒", { type: "array", toneType: "symbol" })[1];
const aspectSyllable = pinyin("看着", { type: "array", toneType: "symbol" })[1];
const onlySyllable = pinyin("只有", { type: "array", toneType: "symbol" })[0];
const bandageSyllable = pinyin("包扎", { type: "array", toneType: "symbol" })[1];
const claspSyllable = pinyin("夹杂", { type: "array", toneType: "symbol" })[0];

const HAN_CHAR = /[㐀-䶿一-鿿]/;

// Convert full-width Chinese punctuation to ASCII; drop bracket-style quotes.
function normalizeNonHan(s) {
  return s
    .replace(/[，、]/g, ", ")
    .replace(/。/g, ". ")
    .replace(/！/g, "! ")
    .replace(/？/g, "? ")
    .replace(/；/g, "; ")
    .replace(/：/g, ": ")
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[《》【】「」（）]/g, " ");
}

/**
 * Romanize a string (Han + Latin + punctuation), returning:
 *   pinyin — the full tone-marked, word-spaced pinyin string
 *   spans  — array indexed by SOURCE code-point; spans[i] = [start,end) of that
 *            character's pinyin within `pinyin` (null if it produced nothing)
 *   srcChars — the source split into code points (so callers can map offsets)
 */
export function romanizeWithMap(text) {
  const srcChars = [...String(text || "")];
  const spans = new Array(srcChars.length).fill(null);
  let out = "";
  const sep = () => { if (out && !out.endsWith(" ")) out += " "; };

  let i = 0;
  while (i < srcChars.length) {
    if (HAN_CHAR.test(srcChars[i])) {
      // Gather the contiguous Han run.
      let j = i;
      while (j < srcChars.length && HAN_CHAR.test(srcChars[j])) j++;
      const run = srcChars.slice(i, j).join("");
      const syllables = pinyin(run, { toneType: "symbol", type: "array", nonZh: "consecutive" });
      for (const match of run.matchAll(/手背/g)) syllables[match.index + 1] = backSyllable;
      // Elliptical self-tying question; exclude explicit needle/stabbing objects.
      for (const match of run.matchAll(/自己扎的$/g)) syllables[match.index + 2] = bandageSyllable;
      // Avoid a cross-word 外传 reading when the verb is 传来.
      for (const match of run.matchAll(/传来/g)) syllables[match.index] = transmitSyllable;
      // Explicit adverbial contexts, preserving the animal classifier.
      for (const match of run.matchAll(/只(?=擦出|摇头|让|记得|松松地|搁|看见|说|将|捏住|剩|想|把|等|听见|知道)/g)) syllables[match.index] = onlySyllable;
      // Negative 收回去 is not the confiscation verb 没收.
      for (const match of run.matchAll(/没(?=收回去)/g)) syllables[match.index] = negativeHaveSyllable;
      // Disambiguate body swelling, pouring beans, and the beans that spilled.
      for (const match of run.matchAll(/涨(?=得难受)/g)) syllables[match.index] = swellSyllable;
      for (const match of run.matchAll(/倒(?=豆子|沙)/g)) syllables[match.index] = pourSyllable;
      for (const match of run.matchAll(/撒(?=的豆子)/g)) syllables[match.index] = scatterSyllable;
      for (const match of run.matchAll(/(?:扶|顺)着/g)) syllables[match.index + 1] = aspectSyllable;
      // With an aspect marker and quantity, 担 is the verb for carrying.
      for (const match of run.matchAll(/担(?=了(?:满|一|两))/g)) syllables[match.index] = carrySyllable;
      for (const match of run.matchAll(/布(?:还|仍)?扎着/g)) syllables[match.index + match[0].length - 2] = bandageSyllable;
      for (const match of run.matchAll(/数(?=货|的也是|一遍|了一遍|起)/g)) syllables[match.index] = countSyllable;
      if (run.endsWith("做过这行")) syllables[run.length - 1] = tradeSyllable;
      for (const match of run.matchAll(/给(?=水洇)/g)) syllables[match.index] = giveSyllable;
      for (const match of run.matchAll(/没(?=入单)/g)) syllables[match.index] = negativeHaveSyllable;
      for (const match of run.matchAll(/闭着眼/g)) syllables[match.index + 1] = aspectSyllable;
      for (const match of run.matchAll(/一轻一重/g)) syllables[match.index + 3] = heavySyllable;
      for (const match of run.matchAll(/(?<=把席子|把表|把图|把碗|草图)还(?=给他)/g)) syllables[match.index] = returnSyllable;
      // Explicit return obligation and rolled-map classifier; preserve 还有 and book volumes.
      for (const m of run.matchAll(/都得一道还/g)) { syllables[m.index + 1] = obligationSyllable; syllables[m.index + 4] = returnSyllable; }
      for (const m of run.matchAll(/一卷图/g)) syllables[m.index + 1] = rolledSyllable;
      for (const m of run.matchAll(/卷好的纸/g)) syllables[m.index] = rolledSyllable;
      for (const m of run.matchAll(/卷着细细|卷得比/g)) syllables[m.index] = rolledSyllable;
      for (const m of run.matchAll(/夹在旧书|夹住萝卜皮/g)) syllables[m.index] = grippingSyllable;
      for (const m of run.matchAll(/纸夹/g)) syllables[m.index + 1] = grippingSyllable;
      for (const m of run.matchAll(/数着日子/g)) syllables[m.index] = countSyllable;
      for (const m of run.matchAll(/(?<=他)数过/g)) syllables[m.index] = countSyllable;
      for (const m of run.matchAll(/惦记着还$/g)) syllables[m.index + 3] = returnSyllable;
      for (const m of run.matchAll(/勒不勒/g)) { syllables[m.index] = cinchSyllable; syllables[m.index + 2] = cinchSyllable; }
      for (const m of run.matchAll(/重新扎筐/g)) syllables[m.index + 2] = bandageSyllable;
      for (const m of run.matchAll(/倒是他们/g)) syllables[m.index] = pourSyllable;
      for (const m of run.matchAll(/勒紧包带/g)) syllables[m.index] = cinchSyllable;
      for (const m of run.matchAll(/短矢钉在/g)) syllables[m.index + 2] = fastenSyllable;
      for (const m of run.matchAll(/钉进身后废屋/g)) syllables[m.index] = fastenSyllable;
      for (const m of run.matchAll(/把布扎住/g)) syllables[m.index + 2] = bandageSyllable;
      for (const m of run.matchAll(/会勒住他喉咙/g)) syllables[m.index + 1] = cinchSyllable;
      for (const m of run.matchAll(/移过了断口/g)) syllables[m.index + 2] = completedSyllable;
      for (const m of run.matchAll(/也得剪开/g)) syllables[m.index + 1] = obligationSyllable;
      for (const m of run.matchAll(/是他自己系的/g)) syllables[m.index + 4] = tieSyllable;
      for (const m of run.matchAll(/系得太紧/g)) syllables[m.index] = tieSyllable;
      for (const m of run.matchAll(/右掌的布勒着/g)) syllables[m.index + 4] = cinchSyllable;
      for (const m of run.matchAll(/还没找着/g)) syllables[m.index + 3] = pinyin("着火", { type: "array", toneType: "symbol" })[0];
      for (const m of run.matchAll(/挡不挡得住/g)) syllables[m.index + 3] = complementSyllable;
      for (const m of run.matchAll(/说得很快|硬得要/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/得先找|得抬/g)) syllables[m.index] = obligationSyllable;
      for (const m of run.matchAll(/坐着干的活/g)) syllables[m.index + 2] = pinyin("干活", { type: "array", toneType: "symbol" })[0];
      for (const m of run.matchAll(/痛快地/g)) syllables[m.index + 2] = complementSyllable;
      for (const m of run.matchAll(/妻子|轮子/g)) syllables[m.index + 1] = neutralZiSyllable;
      for (const m of run.matchAll(/看了看/g)) syllables[m.index + 2] = pinyin("看见", { type: "array", toneType: "symbol" })[0];
      for (const m of run.matchAll(/只挑|只认看/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/挡得最好/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/数完/g)) syllables[m.index] = countSyllable;
      for (const m of run.matchAll(/只去码头|只认名字|只凭自己|只替她/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/赶得回来|对得上|看得很大|画得像/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/都得叫得应/g)) { syllables[m.index + 1] = obligationSyllable; syllables[m.index + 3] = complementSyllable; }
      for (const m of run.matchAll(/得先问/g)) syllables[m.index] = obligationSyllable;
      for (const m of run.matchAll(/倒愿意|倒扣/g)) syllables[m.index] = pourSyllable;
      for (const m of run.matchAll(/罐子/g)) syllables[m.index + 1] = neutralZiSyllable;
      for (const m of run.matchAll(/钻出/g)) syllables[m.index] = pinyin("钻研", { type: "array", toneType: "symbol" })[0];
      for (const m of run.matchAll(/日头下同行/g)) syllables[m.index + 4] = pinyin("行走", { type: "array", toneType: "symbol" })[0];
      for (const m of run.matchAll(/冲塔维/g)) syllables[m.index] = towardSyllable;
      for (const m of run.matchAll(/只多一件|只答应/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/得先把|得一直|得知道|得重查/g)) syllables[m.index] = obligationSyllable;
      for (const m of run.matchAll(/移得不快|答得太早/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/长得很大/g)) { syllables[m.index] = pinyin("长大", { type: "array", toneType: "symbol" })[0]; syllables[m.index + 1] = complementSyllable; }
      for (const m of run.matchAll(/冲人发火/g)) syllables[m.index] = towardSyllable;
      for (const m of run.matchAll(/教这一件/g)) syllables[m.index] = pinyin("教", { type: "array", toneType: "symbol", multiple: true }).find(s => s !== pinyin("教室", { type: "array", toneType: "symbol" })[0]);
      for (const m of run.matchAll(/重查/g)) syllables[m.index] = againSyllable;
      for (const m of run.matchAll(/只在桌上/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/走得再深|悬得那么远|说得像背书|写得慢/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/得先停/g)) syllables[m.index] = obligationSyllable;
      for (const m of run.matchAll(/整片夹在里头/g)) syllables[m.index + 2] = grippingSyllable;
      for (const m of run.matchAll(/一着急/g)) syllables[m.index] = pinyin("一天", { type: "array", toneType: "symbol" })[0];
      for (const m of run.matchAll(/货行/g)) syllables[m.index + 1] = tradeSyllable;
      for (const m of run.matchAll(/只保一段|只带走/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/得跟着/g)) syllables[m.index] = obligationSyllable;
      for (const m of run.matchAll(/带子|垫子/g)) syllables[m.index + 1] = neutralZiSyllable;
      for (const m of run.matchAll(/闷得很/g)) { syllables[m.index] = pinyin("沉闷", { type: "array", toneType: "symbol" })[1]; syllables[m.index + 1] = complementSyllable; }
      for (const m of run.matchAll(/得走开/g)) syllables[m.index] = obligationSyllable;
      for (const m of run.matchAll(/踏得太长|拦得没错|学得很像|拿得动/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/够得着/g)) { syllables[m.index + 1] = complementSyllable; syllables[m.index + 2] = pinyin("着火", { type: "array", toneType: "symbol" })[0]; }
      for (const m of run.matchAll(/倒像因为|倒问他看见|倒有得/g)) syllables[m.index] = pourSyllable;
      for (const m of run.matchAll(/只看那块|只记下/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/说不出没有/g)) syllables[m.index + 3] = negativeHaveSyllable;
      for (const m of run.matchAll(/袖子/g)) syllables[m.index + 1] = neutralZiSyllable;
      for (const m of run.matchAll(/推得太深|做得好|说得不大合时/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/拆时得/g)) syllables[m.index + 2] = obligationSyllable;
      for (const m of run.matchAll(/只多退|只占了/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/木刨/g)) syllables[m.index + 1] = pinyin("刨", { type: "array", toneType: "symbol", multiple: true }).find(s => s !== pinyin("刨土", { type: "array", toneType: "symbol" })[0]);
      for (const m of run.matchAll(/往里夹/g)) syllables[m.index + 2] = grippingSyllable;
      for (const m of run.matchAll(/将相碰|将门边|将门再推开/g)) syllables[m.index] = pinyin("将要", { type: "array", toneType: "symbol" })[0];
      for (const m of run.matchAll(/刨木/g)) syllables[m.index] = pinyin("刨", { type: "array", toneType: "symbol", multiple: true }).find(s => s !== pinyin("刨土", { type: "array", toneType: "symbol" })[0]);
      for (const m of run.matchAll(/系了短绳/g)) syllables[m.index] = tieSyllable;
      for (const m of run.matchAll(/法子/g)) syllables[m.index + 1] = neutralZiSyllable;
      for (const m of run.matchAll(/分量/g)) syllables[m.index + 1] = pinyin("量", { type: "array", toneType: "none" })[0];
      for (const m of run.matchAll(/一卷画好的路图/g)) { syllables[m.index] = pinyin("一天", { type: "array", toneType: "symbol" })[0]; syllables[m.index + 1] = rolledSyllable; }
      for (const m of run.matchAll(/卷边/g)) syllables[m.index] = rolledSyllable;
      for (const m of run.matchAll(/只练普通/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/举得像盾|短得宋远|小得挤到/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/空着手/g)) syllables[m.index + 1] = aspectSyllable;
      for (const m of run.matchAll(/感觉还清楚/g)) syllables[m.index + 2] = pinyin("还有", { type: "array", toneType: "symbol" })[0];
      for (const m of run.matchAll(/倒问他还记不记得/g)) syllables[m.index] = pourSyllable;
      for (const m of run.matchAll(/数过的日子/g)) syllables[m.index] = countSyllable;
      for (const m of run.matchAll(/先重做普通站姿/g)) syllables[m.index + 1] = againSyllable;
      for (const m of run.matchAll(/不由自主地/g)) syllables[m.index + 4] = pinyin("地", { type: "array", toneType: "symbol", multiple: true })[1];
      for (const m of run.matchAll(/握久了/g)) syllables[m.index + 2] = completedSyllable;
      for (const m of run.matchAll(/骡车还了没有/g)) syllables[m.index + 2] = returnSyllable;
      for (const m of run.matchAll(/说还了/g)) syllables[m.index + 1] = returnSyllable;
      for (const m of run.matchAll(/卷好的图/g)) syllables[m.index] = rolledSyllable;
      for (const m of run.matchAll(/被翻得发软/g)) syllables[m.index + 2] = complementSyllable;
      for (const m of run.matchAll(/一沓纸/g)) syllables[m.index + 1] = pinyin("沓", { type: "array", toneType: "symbol", multiple: true })[1];
      for (const m of run.matchAll(/扎短辫|扎紧/g)) syllables[m.index] = bandageSyllable;
      for (const m of run.matchAll(/本能地/g)) syllables[m.index + 2] = pinyin("地", { type: "array", toneType: "symbol", multiple: true })[1];
      for (const m of run.matchAll(/安全得很/g)) syllables[m.index + 2] = complementSyllable;
      for (const m of run.matchAll(/有点冲/g)) syllables[m.index + 2] = towardSyllable;
      for (const m of run.matchAll(/把一把洗好的葱/g)) syllables[m.index + 1] = pinyin("一碗", { type: "array", toneType: "symbol" })[0];
      for (const m of run.matchAll(/不只半句/g)) syllables[m.index + 1] = onlySyllable;
      for (const m of run.matchAll(/护着手/g)) syllables[m.index + 1] = aspectSyllable;
      for (const m of run.matchAll(/猛地变成/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/挨打/g)) syllables[m.index] = pinyin("挨", { type: "array", toneType: "symbol", multiple: true })[1];
      for (const m of run.matchAll(/互不相让地/g)) syllables[m.index + 4] = complementSyllable;
      for (const m of run.matchAll(/看得了/g)) syllables[m.index + 2] = pinyin("了解", { type: "array", toneType: "symbol" })[0];
      for (const m of run.matchAll(/教(?=这件事|他站着|吗)|(?<=她说也)教/g)) syllables[m.index] = pinyin("教", { type: "array", toneType: "symbol", multiple: true })[1];
      for (const m of run.matchAll(/数着前车/g)) syllables[m.index] = countSyllable;
      for (const m of run.matchAll(/卷好的旧毡|卷过肘/g)) syllables[m.index] = rolledSyllable;
      for (const m of run.matchAll(/没有数它/g)) syllables[m.index + 2] = countSyllable;
      for (const m of run.matchAll(/夹簧/g)) syllables[m.index] = grippingSyllable;
      for (const m of run.matchAll(/背着饭包|背着她的皮袋/g)) syllables[m.index] = carryingBackSyllable;
      for (const m of run.matchAll(/只要里头长的/g)) syllables[m.index + 4] = growingSyllable;
      for (const m of run.matchAll(/要还$/g)) syllables[m.index + 1] = returnSyllable;
      for (const m of run.matchAll(/纸卷/g)) syllables[m.index + 1] = rolledSyllable;
      for (const m of run.matchAll(/得空着船/g)) { syllables[m.index] = obligationSyllable; syllables[m.index + 1] = emptySyllable; }
      for (const m of run.matchAll(/又得听/g)) syllables[m.index + 1] = obligationSyllable;
      for (const m of run.matchAll(/得停|得找别的|得扫|得再去问|得先空掉|得开口去问|得把每个字|得他们自己|得给家里写信|得答应|得认清|得接着看|得送进城里|得有你真能做的事|得翻|得分神|得有人|得请渠务所|得等渠务所|得看去哪儿|得看撑船|得算他的活|得先知道|得画大一点|得自己开口|得问她|得站着|得坐下来谈|得留着|得从脚下|得看他肯不肯|得回去占|得自己带灯|得等回去/g)) syllables[m.index] = obligationSyllable;
      for (const m of run.matchAll(/说得很干脆|说得慢些|说得很随意|问得烦|问得直接|跑得肚子疼|裂得很长|浸得发黑|磨得发亮|暗得像|装得不对|洗得比|辣得他|笑得往后仰|压得很平|写得很重|说得不大妥当|干得很慢|说得很平|小得出奇|写得太宽|吹得乱响|拆得出来|答得干脆|听得出来|笑得刚|笑得把信封|熏得闭了|饿得去吃|响得不肯|吹得轻轻|描得深了些|笑得写不下字|说得有些快|切得歪|卷得比|按得太用力|淡得几乎|小得认不出脸|走得远|醒得比钟|磨得发白|改得好听|让得开些|短得塔维|笑得饭包|紧得发亮|疼得弯了|白得塔维|抖得厉害|牵得她|弯得更少|疼得一张脸|叫得像|伤得重|撑得住|喊得像|晃得真像|牵得紧|擦得发白|练得怎样|练得更快|摔得也更快|练得发软|喝得太快|慢得像怕|写得像三个人|说得漂亮|看得见|放得太重|跑得勤些|沉得不像|退得深|熟得不能再熟|练得好|看得了|咬得太急|说得乱|睡得怎样|坐得越来越直|包得比原先厚|亮得很寻常|举得很高|动得很慢|疼得连话|系得太紧|动得多些|画得几乎|画得太小|绷得发酸|走得比|骂得很响|挂得太低|咬得比|酸得眼角|种得太迟|笑得手|搁得像|抱得那么紧/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/拿着长夹/g)) syllables[m.index + 3] = grippingSyllable;
      for (const m of run.matchAll(/剪子|凳子|板子|步子|册子|匣子|果子|碟子|豆子|镊子|肚子|脑子/g)) syllables[m.index + 1] = neutralZiSyllable;
      for (const m of run.matchAll(/铺着|铺好|铺回去/g)) syllables[m.index] = spreadSyllable;
      for (const m of run.matchAll(/铁夹/g)) syllables[m.index + 1] = grippingSyllable;
      for (const m of run.matchAll(/种得太迟/g)) syllables[m.index] = plantingSyllable;
      for (const m of run.matchAll(/没还的书/g)) syllables[m.index + 1] = returnSyllable;
      for (const m of run.matchAll(/把纸还给他/g)) syllables[m.index + 2] = returnSyllable;
      for (const m of run.matchAll(/倒不是黑|倒没人再睡/g)) syllables[m.index] = pourSyllable;
      for (const m of run.matchAll(/出了事/g)) syllables[m.index + 1] = completedSyllable;
      for (const m of run.matchAll(/上次数错/g)) syllables[m.index + 2] = countSyllable;
      for (const m of run.matchAll(/数了两颗/g)) syllables[m.index] = countSyllable;
      for (const m of run.matchAll(/岔出去的调/g)) syllables[m.index + 4] = pinyin("调子", { type: "array", toneType: "symbol" })[0];
      for (const m of run.matchAll(/没收到/g)) syllables[m.index] = negativeHaveSyllable;
      for (const m of run.matchAll(/杯子落在那里了/g)) syllables[m.index + 2] = leftBehindSyllable;
      for (const m of run.matchAll(/那行住处/g)) syllables[m.index + 1] = tradeSyllable;
      for (const m of run.matchAll(/只写另行通知|只问一次|只问洛衡|只问纸|只问他昨日|只认到山门|只给一张|只在结尾|只数着日子|只托伊文|只睡了半个|只叫他自己|只肯|只用脚尖|只看两边|只来得及|只在地上|只往前|只点头|只沿绳边|只叫林珂|只从林珂|只会那一边|只这一处|只记一处|只到山门|只问修栏|只问信里|只问|只走步子|只侧了|只问下一回|只往前踏|只认三处|只叫两人|只凭字丑|只给他添|只站着看|只问还有没有|只教他站着|只留下其中|只跟她学|只撑一会儿|只扶木槽|只在匣底|只抬到半截|只背着饭包|只挡在胸前|只够半坐|只会后半段|只从回来的人|只写还没有/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/怔了一下/g)) syllables[m.index] = startledSyllable;
      for (const m of run.matchAll(/轻载/g)) syllables[m.index + 1] = loadSyllable;
      for (const m of run.matchAll(/只看了几眼|只叫他看看/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/轻咳/g)) syllables[m.index + 1] = coughSyllable;
      for (const m of run.matchAll(/分开得|册子合得/g)) syllables[m.index + (m[0].startsWith("分") ? 2 : 3)] = complementSyllable;
      for (const m of run.matchAll(/屏住气/g)) syllables[m.index] = suppressSyllable;
      for (const m of run.matchAll(/贴得|轻得|倒得|烫得/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/不由得/g)) syllables[m.index + 2] = complementSyllable;
      for (const m of run.matchAll(/水倒得/g)) syllables[m.index + 1] = pourSyllable;
      for (const m of run.matchAll(/夹走一片菜/g)) syllables[m.index] = grippingSyllable;
      for (const m of run.matchAll(/屋里弄的/g)) syllables[m.index + 2] = pinyin("弄好", { type: "array", toneType: "symbol" })[0];
      for (const m of run.matchAll(/只叫人|只预备|只叫他留|只叫他把/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/扣得住|住得好|收得慢/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/也得重新/g)) syllables[m.index + 1] = obligationSyllable;
      for (const m of run.matchAll(/(?<!关)系(?=垫|松)/g)) syllables[m.index] = tieSyllable;
      for (const m of run.matchAll(/带得走|守得住|拿得比/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/只须|只走(?=$)|只叫换人|只在布前/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/倒水/g)) syllables[m.index] = pourSyllable;
      for (const m of run.matchAll(/还得用/g)) syllables[m.index + 1] = obligationSyllable;
      for (const m of run.matchAll(/重画/g)) syllables[m.index] = againSyllable;
      for (const m of run.matchAll(/挪到了/g)) syllables[m.index + 2] = completedSyllable;
      for (const m of run.matchAll(/载着布包/g)) syllables[m.index] = loadSyllable;
      for (const m of run.matchAll(/湿得/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/抱着手臂/g)) syllables[m.index + 1] = aspectSyllable;
      for (const m of run.matchAll(/只挪到/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/只留下(?=一)|只记学生|只看车/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/一只好的/g)) syllables[m.index + 1] = pinyin("一只碗", { type: "array", toneType: "symbol" })[1];
      for (const m of run.matchAll(/抖得|画得好/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/去还维老师/g)) syllables[m.index + 1] = returnSyllable;
      for (const m of run.matchAll(/缝好/g)) syllables[m.index] = pinyin("缝合", { type: "array", toneType: "symbol" })[0];
      for (const m of run.matchAll(/试着落稳/g)) syllables[m.index + 1] = aspectSyllable;
      for (const m of run.matchAll(/空出的/g)) syllables[m.index] = vacateSyllable;
      for (const m of run.matchAll(/(?<=一行仍|右边|一行还)空着(?!手|船)/g)) syllables[m.index] = vacateSyllable;
      for (const m of run.matchAll(/弯得深|想得比/g)) syllables[m.index + 1] = complementSyllable;
      for (const m of run.matchAll(/还得先|还得同/g)) syllables[m.index + 1] = obligationSyllable;
      for (const m of run.matchAll(/得先说/g)) syllables[m.index] = obligationSyllable;
      for (const m of run.matchAll(/只在货行/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/米拉还的/g)) syllables[m.index + 2] = returnSyllable;
      for (const m of run.matchAll(/水杯倒过来/g)) syllables[m.index + 2] = pourSyllable;
      for (const m of run.matchAll(/饭后的觉/g)) syllables[m.index + 3] = napSyllable;
      // These result phrases mean vacating space / taking a hit, not sky or proximity.
      for (const m of run.matchAll(/空出来|空处|(?<=好好地|人手仍|空处仍)空着/g)) syllables[m.index] = vacateSyllable;
      for (const m of run.matchAll(/没挨上/g)) syllables[m.index + 1] = sufferSyllable;
      for (const m of run.matchAll(/只准走|只扫到|只解释|只会当|只到河岔|只做这一件|只拿木头/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/只看一眼/g)) syllables[m.index] = onlySyllable;
      for (const m of run.matchAll(/冲孩子吵/g)) syllables[m.index] = towardSyllable;
      for (const m of run.matchAll(/倒像她不讲理|倒像只是|倒把塔维|倒让他不知|倒记得很清楚|倒一点不嫌累|倒没有谁/g)) syllables[m.index] = pourSyllable;
      for (const m of run.matchAll(/守着力/g)) syllables[m.index + 1] = aspectSyllable;
      for (const m of run.matchAll(/夹口|夹进纸缝|夹固/g)) syllables[m.index] = grippingSyllable;
      for (const m of run.matchAll(/旋紧/g)) syllables[m.index] = tightenSyllable;
      for (const m of run.matchAll(/剥落/g)) syllables[m.index] = peelingSyllable;
      for (const m of run.matchAll(/路仍夹在/g)) syllables[m.index + 2] = grippingSyllable;
      for (const m of run.matchAll(/只付了|只换这块板|只换板子|只差最后|只咬/g)) syllables[m.index] = onlySyllable;
      const words = jieba.cut(run);
      let ci = 0;          // char index within the run
      let firstWord = true;
      for (const w of words) {
        const wlen = [...w].length;
        if (w === "曲" && run[ci + 1] === "指") syllables[ci] = bendSyllable;
        if (w === "重" && run[ci + 1] === "捆") syllables[ci] = againSyllable;
        if (w === "粘住") syllables[ci] = stickSyllable;
        // A verb before 回, not the nail noun in 铁钉回收/钉子回收.
        if (w === "钉" && run[ci + 1] === "回") syllables[ci] = fastenSyllable;
        if (w === "夹着" || (w === "夹" && run[ci + 1] === "着")) syllables[ci] = claspSyllable;
        // Explicit tightening contexts, without changing 勒索/勒马 readings.
        if ((w === "勒" && run[ci - 1] === "再") ||
            (w === "勒住" && /[线绳带]/.test(run[ci - 1] || ""))) {
          syllables[ci] = cinchSyllable;
        }
        // Respect the segment boundary: 传递还需… contains 传递 + 还, not 递还.
        if (w === "递还" || (w === "递" && srcChars[i + ci + 1] === "还")) {
          syllables[ci + 1] = returnSyllable;
        }
        if (tyingWords.has(w) || (w === "系" && /^(腰|鞋|扣|绳|紧|牢|好|上|住|在|着)/.test(run.slice(ci + 1)))) {
          syllables[ci] = tieSyllable;
        }
        if (!firstWord) sep();           // space between words
        else { sep(); }                  // and space before the run if needed
        firstWord = false;
        for (let k = 0; k < wlen; k++) {
          const start = out.length;
          out += syllables[ci] ?? "";
          spans[i + ci] = [start, out.length];
          ci++;
        }
      }
      i = j;
    } else {
      // Non-Han run: normalize, emit as one unit.
      let j = i;
      while (j < srcChars.length && !HAN_CHAR.test(srcChars[j])) j++;
      const run = srcChars.slice(i, j).join("");
      const norm = normalizeNonHan(run).replace(/\s+/g, " ").trim();
      if (norm) {
        sep();
        const start = out.length;
        out += norm;
        const end = out.length;
        for (let k = i; k < j; k++) spans[k] = [start, end];
      }
      i = j;
    }
  }
  return { pinyin: out, spans, srcChars };
}

/** Plain romanization (no map). Identical output to romanizeWithMap().pinyin. */
export function romanize(text) {
  return romanizeWithMap(text).pinyin;
}

/**
 * Given a pair's Hanzi and the result of romanizeWithMap(pairHanzi), return the
 * context-correct pinyin for a chunk (a Hanzi substring of the pair) by slicing
 * the pair's pinyin. Falls back to isolated romanization if the chunk can't be
 * located (e.g. duplicate handling edge cases).
 */
export function chunkPinyinFromPair(pairHanzi, chunkHanzi, map) {
  const chunk = (chunkHanzi || "").trim();
  if (!chunk) return "";
  const utf16Idx = pairHanzi.indexOf(chunk);
  if (utf16Idx === -1) return romanize(chunk);
  const cpStart = [...pairHanzi.slice(0, utf16Idx)].length;
  const cpLen = [...chunk].length;
  const startSpan = map.spans[cpStart];
  const endSpan = map.spans[cpStart + cpLen - 1];
  if (!startSpan || !endSpan) return romanize(chunk);
  return map.pinyin.slice(startSpan[0], endSpan[1]).trim();
}

/** True if the string contains any Han character (for validation/guards). */
export function hasHan(text) {
  return HAN_CHAR.test(String(text || ""));
}

/**
 * Segment a string into words using the SHARED jieba instance (same dictionary
 * romanization uses). Exposed so the frequency module can band words without
 * loading a second 5 MB copy of the dict.
 */
export function segment(text) {
  return jieba.cut(String(text || ""));
}
