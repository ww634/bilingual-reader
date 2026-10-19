// Listen mode: the chapter read aloud, sentence by sentence.
//
//   • the headphones button in the reader's top bar opens a small player and
//     starts reading from the top of the current page;
//   • the sentence being read is highlighted (one bar per target line, like the
//     selection highlight) and kept in view; pages turn by themselves;
//   • while the player is open, tapping a word jumps to (and plays) its sentence
//     instead of opening the word popover;
//   • Slow / Normal pace — the voice itself is slowed, not the playback, so the
//     tones keep their natural pitch. Audio is cached like word pronunciation,
//     and the next sentence is fetched while the current one plays.

import { getReaderContext, getPageElements, goToPage } from "./reader.js";
import { playSpeech, prefetchSpeech } from "./speech.js";
import { getSettings, updateSettings } from "./db.js";
import { hasSelection, groupByLine } from "./selection.js";

const $ = (id) => document.getElementById(id);

const L = {
  active: false,
  playing: false,
  ended: false,        // reached the last sentence
  idx: 0,              // chapter-global pair (sentence) index
  slow: false,
  ctl: null,           // controller of the sentence currently playing
  pageOf: new Map(),   // pair index -> page index
  firstOfPage: new Map(), // page index -> first pair index on it
  expectPage: null,    // a page turn we caused ourselves (not the user's swipe)
};

// ── Chapter map ──
function buildMap() {
  L.pageOf.clear();
  L.firstOfPage.clear();
  getPageElements().forEach((page, pageIdx) => {
    for (const el of page.querySelectorAll(".reader-block > p.target [data-pair]")) {
      const i = parseInt(el.dataset.pair, 10);
      if (!Number.isFinite(i) || L.pageOf.has(i)) continue;
      L.pageOf.set(i, pageIdx);
      if (!L.firstOfPage.has(pageIdx) || i < L.firstOfPage.get(pageIdx)) L.firstOfPage.set(pageIdx, i);
    }
  });
}

function pairCount() {
  return getReaderContext()?.chapter?.pairs?.length || 0;
}

function sentenceText(i) {
  const ctx = getReaderContext();
  const pair = ctx?.chapter?.pairs?.[i];
  if (!pair) return "";
  // Chinese is voiced from the characters (far better than reading pinyin).
  return ctx.language === "zh" ? (pair.hanzi || pair.target) : pair.target;
}

// ── Highlight ──
function clearHighlight() {
  document.querySelectorAll(".listen-hl").forEach((el) => el.remove());
}

function drawHighlight() {
  clearHighlight();
  if (!L.active) return;
  const page = getPageElements()[L.pageOf.get(L.idx)];
  if (!page) return;
  const spans = [...page.querySelectorAll(`.reader-block > p.target [data-pair="${L.idx}"]`)]
    .filter((el) => (el.textContent || "").trim());
  const groups = groupByLine(spans);
  let first = null, sTop = Infinity, sBottom = -Infinity;
  for (const { line, rects } of groups) {
    const box = line.getBoundingClientRect();
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const hl = document.createElement("div");
    hl.className = "listen-hl";
    hl.style.left = `${left - box.left - 3}px`;
    hl.style.top = `${top - box.top - 2}px`;
    hl.style.width = `${right - left + 6}px`;
    hl.style.height = `${bottom - top + 4}px`;
    line.appendChild(hl);
    if (!first) first = line;
    sTop = Math.min(sTop, top);
    // Include the English line under it in the bilingual layout.
    const block = line.closest(".reader-block");
    sBottom = Math.max(sBottom, block && !block.classList.contains("flow") ? block.getBoundingClientRect().bottom : bottom);
  }
  // Keep the sentence comfortably in view inside the (vertically scrolling) page.
  if (first) {
    const pb = page.getBoundingClientRect();
    const margin = 90;
    if (sTop < pb.top + 10 || sBottom > pb.bottom - margin - 70) {
      page.scrollTo({ top: page.scrollTop + (sTop - pb.top) - pb.height * 0.3, behavior: "smooth" });
    }
  }
}

// ── Player bar ──
function renderBar(state) {
  const total = pairCount();
  $("listen-play").classList.toggle("playing", L.playing);
  $("listen-play").setAttribute("aria-label", L.playing ? "Pause" : "Play");
  $("listen-speed").textContent = L.slow ? "Slow" : "Normal";
  $("listen-speed").classList.toggle("on", L.slow);
  const status = state === "loading" ? "Loading…"
    : state === "end" ? "End of chapter"
    : `Sentence ${Math.min(L.idx + 1, total)} of ${total}`;
  $("listen-status").textContent = status;
}

// ── Playback ──
function stopAudio() {
  if (L.ctl) { L.ctl.stop(); L.ctl = null; }
}

function showSentence(i) {
  L.idx = Math.min(Math.max(i, 0), Math.max(pairCount() - 1, 0));
  const page = L.pageOf.get(L.idx);
  const ctx = getReaderContext();
  if (page != null && ctx && ctx.currentPage !== page) {
    L.expectPage = page;
    goToPage(page);
  }
  drawHighlight();
}

function playFrom(i) {
  stopAudio();
  L.ended = false;
  showSentence(i);
  L.playing = true;
  const idx = L.idx;
  const ctx = getReaderContext();
  const code = ctx?.language || "zh";
  renderBar("loading");
  L.ctl = playSpeech(sentenceText(idx), code, {
    slow: L.slow,
    onState: (s) => { if (L.idx === idx && L.playing) renderBar(s === "loading" ? "loading" : ""); },
    onEnded: () => {
      if (!L.active || !L.playing || L.idx !== idx) return;
      if (idx + 1 >= pairCount()) {
        L.playing = false;
        L.ended = true;
        L.ctl = null;
        renderBar("end");
        return;
      }
      playFrom(idx + 1);
    },
  });
  // Fetch the next sentence while this one plays.
  if (idx + 1 < pairCount()) prefetchSpeech(sentenceText(idx + 1), code, { slow: L.slow });
}

function pause() {
  L.playing = false;
  stopAudio();
  renderBar();
}

function togglePlay() {
  if (L.playing) pause();
  else if (L.ended) playFrom(0);
  else playFrom(L.idx);
}

function step(delta) {
  const next = L.idx + delta;
  if (next < 0 || next >= pairCount()) return;
  if (L.playing) playFrom(next);
  else { showSentence(next); renderBar(); }
}

// ── Open / close ──
function startIndexForCurrentPage() {
  const ctx = getReaderContext();
  if (!ctx) return 0;
  if (L.firstOfPage.has(ctx.currentPage)) return L.firstOfPage.get(ctx.currentPage);
  // Title page → the first sentence; end page → back to the start.
  return 0;
}

async function open() {
  if (!getReaderContext()) return;
  if (L.active) { close(); return; }   // the button toggles
  L.active = true;
  document.body.classList.add("listening");
  $("listen-btn")?.classList.add("on");
  $("listen-bar").hidden = false;
  buildMap();
  // Start immediately — this runs inside the tap, which unlocks audio on iOS.
  playFrom(startIndexForCurrentPage());
  const s = await getSettings();
  if (!!s.listenSlow !== L.slow) {   // apply a saved preference for next sentences
    L.slow = !!s.listenSlow;
    renderBar();
  }
}

export function closeListen() { close(); }
function close() {
  if (!L.active) return;
  L.active = false;
  L.playing = false;
  stopAudio();
  clearHighlight();
  document.body.classList.remove("listening");
  $("listen-btn")?.classList.remove("on");
  $("listen-bar").hidden = true;
}

export function initListen() {
  $("listen-btn")?.addEventListener("click", open);
  $("listen-close")?.addEventListener("click", close);
  $("listen-play")?.addEventListener("click", togglePlay);
  $("listen-prev")?.addEventListener("click", () => step(-1));
  $("listen-next")?.addEventListener("click", () => step(1));
  $("listen-speed")?.addEventListener("click", async () => {
    L.slow = !L.slow;
    renderBar();
    if (L.playing) playFrom(L.idx);   // restart this sentence at the new pace
    await updateSettings({ listenSlow: L.slow });
  });
  getSettings().then((s) => { L.slow = !!s.listenSlow; });

  // Tap a word while listening → play that sentence (instead of the popover).
  // Capture phase so it runs before the reader's own tap handler.
  $("reader-pages")?.addEventListener("click", (e) => {
    if (!L.active || hasSelection()) return;
    const el = e.target.closest && e.target.closest(".reader-block > p.target [data-pair], .reader-block > p.target .seg[data-pair]");
    if (!el) return;
    const i = parseInt(el.dataset.pair, 10);
    if (!Number.isFinite(i)) return;
    e.stopPropagation();
    e.preventDefault();
    playFrom(i);
  }, true);

  // The user swiped to another page: carry on from the top of that page.
  window.addEventListener("reader:page", (e) => {
    if (!L.active) return;
    const page = e.detail?.page;
    if (page === L.expectPage) { L.expectPage = null; return; }
    L.expectPage = null;
    if (!L.firstOfPage.has(page)) { pause(); clearHighlight(); return; }   // title / end page
    if (L.playing) playFrom(L.firstOfPage.get(page));
    else { showSentence(L.firstOfPage.get(page)); renderBar(); }
  });

  // Text re-rendered in another script → re-measure the highlight.
  window.addEventListener("reader:script", () => { if (L.active) setTimeout(drawHighlight, 0); });
  window.addEventListener("resize", () => { if (L.active) drawHighlight(); });
  // Leaving the reader or opening another chapter ends listening.
  window.addEventListener("view:changed", (e) => { if (e.detail !== "reader") close(); });
  window.addEventListener("reader:opened", close);
  // Re-laid out (English on/off): new pages, so re-map and redraw.
  window.addEventListener("reader:rerendered", () => {
    if (!L.active) return;
    buildMap();
    drawHighlight();
  });
}
