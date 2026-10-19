// Stroke order + handwriting practice for Chinese characters (Hanzi Writer).
//
// openWriter("螺丝", "luósī") opens a sheet with one tab per character:
//   • Watch    — animates the strokes in order;
//   • Practise — trace each stroke with a finger; a hint appears after two
//                misses, and the result is shown when the character is done;
//   • Outline  — show/hide the faint guide underneath.
// The library is loaded on first use; stroke data for each character is fetched
// once from jsDelivr and then kept offline by the service worker.

const $ = (id) => document.getElementById(id);
const HAN = /[㐀-鿿]/;
const SIZE = 260;

let _libLoading = null;
function loadLib() {
  if (window.HanziWriter) return Promise.resolve();
  if (_libLoading) return _libLoading;
  _libLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/hanzi-writer.min.js";
    s.onload = () => resolve();
    s.onerror = () => { _libLoading = null; reject(new Error("Couldn't load the handwriting tool.")); };
    document.head.appendChild(s);
  });
  return _libLoading;
}

const W = { chars: [], idx: 0, writer: null, outline: true, pinyin: "" };

function status(text, cls = "") {
  const el = $("write-status");
  el.textContent = text;
  el.className = `write-status ${cls}`;
}

// Per-character pinyin when the word's pinyin splits cleanly into one syllable
// per character (tone-marked syllables end at a vowel/n/ng/r boundary).
const SYLLABLE = /(?:[bpmfdtnlgkhjqxrzcsyw]|zh|ch|sh)?[aeiouüāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+(?:ng|n|r(?![aeiouüāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]))?/gi;
function splitPinyin(pinyin, count) {
  const parts = String(pinyin || "").replace(/[^a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü\s]/g, " ").trim().split(/\s+/)
    .flatMap((w) => w.match(SYLLABLE) || []);
  return parts.length === count ? parts : null;
}

function renderTabs() {
  const tabs = $("write-tabs");
  const per = splitPinyin(W.pinyin, W.chars.length);
  tabs.innerHTML = W.chars.map((c, i) => `
    <button class="write-tab${i === W.idx ? " on" : ""}" data-i="${i}">
      <span class="write-tab-char">${c}</span>${per ? `<span class="write-tab-py">${per[i]}</span>` : ""}
    </button>`).join("");
  tabs.querySelectorAll(".write-tab").forEach((b) => b.addEventListener("click", () => showChar(+b.dataset.i)));
}

async function showChar(i) {
  W.idx = i;
  renderTabs();
  const target = $("write-target");
  target.innerHTML = "";
  status("Loading strokes…");
  try {
    await loadLib();
  } catch (err) {
    status(err.message, "error");
    return;
  }
  const char = W.chars[i];
  W.writer = window.HanziWriter.create(target, char, {
    width: SIZE,
    height: SIZE,
    padding: 14,
    showOutline: W.outline,
    strokeColor: "#f0f2f7",
    outlineColor: "#2d3446",
    radicalColor: "#7dd3fc",
    drawingColor: "#6aa7ff",
    highlightColor: "#ffd089",
    strokeAnimationSpeed: 1,
    delayBetweenStrokes: 220,
    showHintAfterMisses: 2,
    onLoadCharDataSuccess: (data) => {
      status(`${data.strokes.length} stroke${data.strokes.length === 1 ? "" : "s"} · tap Watch, then Practise`);
    },
    onLoadCharDataError: () => {
      status(navigator.onLine
        ? "No stroke data for this character."
        : "Stroke data needs an internet connection the first time you open a character.", "error");
    },
  });
}

function watch() {
  if (!W.writer) return;
  W.writer.cancelQuiz?.();
  W.writer.animateCharacter({ onComplete: () => status("Now try it: tap Practise and trace each stroke.") });
}

function practise() {
  if (!W.writer) return;
  status("Trace the strokes in order. A hint shows after two misses.");
  W.writer.quiz({
    onCorrectStroke: (d) => status(`Stroke ${d.strokeNum + 1} ✓ · ${d.strokesRemaining} to go`),
    onMistake: (d) => status(`Not quite. Stroke ${d.strokeNum + 1} again`, "warn"),
    onComplete: (d) => {
      const m = d.totalMistakes;
      status(m === 0 ? "Perfect! No mistakes." : `Done, with ${m} mistake${m === 1 ? "" : "s"}. Practise again?`, m === 0 ? "ok" : "");
      if (W.idx < W.chars.length - 1) $("write-next").hidden = false;
    },
  });
  $("write-next").hidden = true;
}

function toggleOutline() {
  W.outline = !W.outline;
  $("write-outline").classList.toggle("on", W.outline);
  if (!W.writer) return;
  if (W.outline) W.writer.showOutline(); else W.writer.hideOutline();
}

/** Open the writing sheet for a Chinese word (characters only are practised). */
export function openWriter(word, pinyin = "") {
  const chars = [...String(word || "")].filter((c) => HAN.test(c));
  if (!chars.length) return;
  W.chars = chars;
  W.pinyin = pinyin;
  W.idx = 0;
  $("write-word").textContent = word;
  $("write-pinyin").textContent = pinyin || "";
  $("write-next").hidden = true;
  $("write-outline").classList.toggle("on", W.outline);
  $("write-backdrop").hidden = false;
  const sheet = $("write-sheet");
  sheet.hidden = false;
  void sheet.offsetHeight;
  sheet.classList.add("open");
  showChar(0);
}

function close() {
  const sheet = $("write-sheet");
  sheet.classList.remove("open");
  W.writer?.cancelQuiz?.();
  setTimeout(() => { sheet.hidden = true; $("write-backdrop").hidden = true; $("write-target").innerHTML = ""; W.writer = null; }, 240);
}

export function initWriter() {
  $("write-close")?.addEventListener("click", close);
  $("write-backdrop")?.addEventListener("click", close);
  $("write-watch")?.addEventListener("click", watch);
  $("write-practise")?.addEventListener("click", practise);
  $("write-outline")?.addEventListener("click", toggleOutline);
  $("write-next")?.addEventListener("click", () => { showChar(W.idx + 1); $("write-next").hidden = true; });
  window.addEventListener("view:changed", () => { if (!$("write-sheet").hidden) close(); });
}
