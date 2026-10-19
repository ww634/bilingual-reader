// Custom text selection for the reader.
//
// Why not the browser's own selection? On iOS the system draws the selection
// highlight itself and fills the whole region between the first and last
// selected line — a big box that also covers the English gloss lines in
// between. Page CSS cannot change that. So the reader owns selection instead:
//
//   • long-press a word (touch) or press-and-drag (mouse) to start;
//   • drag to extend; drag the two handles to adjust afterwards;
//   • the highlight is drawn by us — one bar per TARGET-language line, behind
//     the text, never over the English;
//   • iOS' own selection/callout is switched off for the reading area (CSS), so
//     its Copy / Look Up / Writing Tools menu never competes with our action bar.
//
// Selection is word-based (every target word is a span) and confined to the page
// it started on. The assistant module listens for `reader:selection` events to
// show its action bar, and reads the chosen words via getSelectedSpans().

const $ = (id) => document.getElementById(id);

// Every selectable word in a reading block: tagged word spans (chunks and the
// gaps between them) plus any untagged "uncovered" tokens.
const WORD_SEL = ".reader-block > p.target [data-hanzi], .reader-block > p.target .seg.uncov";
const LONG_PRESS_MS = 380;      // hold time before a touch starts a selection
const TOUCH_SLOP_PX = 10;       // finger travel that turns a press into a scroll
const MOUSE_DRAG_PX = 4;        // mouse travel that turns a press into a drag

let state = null;               // { page, spans, rects, lo, hi, anchor }
let press = null;               // a pointer-down that might become a selection
let drag = null;                // "new" | "start" | "end" while a drag is live
let knobGrab = { x: 0, y: 0 };  // where on a handle the finger grabbed it
let suppressClick = false;      // swallow the click that follows a selection gesture
let suppressTimer = null;
let knobs = null;               // { root, start, end }
let lastPointer = null;         // latest pointer position during a drag
let autoRaf = null;             // timer id of the auto-scroll loop
let autoLast = 0;               // timestamp of the previous auto-scroll step

// Auto-scroll: while dragging a selection, a finger near the top/bottom of the
// page scrolls it (faster the closer to the edge), like iOS does. Driven by a
// timer with a time-based step, so the speed stays right even if frames lag.
const EDGE_PX = 70;             // edge zone height
const MAX_SPEED = 900;          // px per second at the very edge
const STEP_MS = 16;

// ── Word helpers (also used by the assistant) ──

/** The word in its own script: hanzi for Chinese, the word itself otherwise. */
export const wordHanzi = (el) => el.getAttribute("data-hanzi") ?? el.textContent ?? "";
/** The word's romanization (pinyin), or its text for languages without one. */
export const wordPinyin = (el) => el.getAttribute("data-pinyin") ?? el.textContent ?? "";

function collectSpans(page) {
  return [...page.querySelectorAll(WORD_SEL)].filter((el) => (el.textContent || "").trim() !== "");
}

// The nearest word to a point. Vertical distance dominates so a finger dragged
// across an English line (or the gap between blocks) snaps to the closest
// target line instead of jumping around.
function nearestIndex(x, y) {
  let best = 0, bestScore = Infinity;
  state.rects.forEach((r, i) => {
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const score = dy * 4 + dx;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

// ── Public API ──

export const hasSelection = () => !!state;
export function getSelectedSpans() {
  return state ? state.spans.slice(state.lo, state.hi + 1) : [];
}

export function clearSelection() {
  if (!state && !drag) return;
  state = null;
  drag = null;
  press = null;
  stopAutoScroll();
  removeHighlights();
  hideKnobs();
  emit();
}

// ── Rendering ──

function removeHighlights() {
  document.querySelectorAll(".sel-hl").forEach((el) => el.remove());
}

/**
 * Group word elements into visual lines: same paragraph and vertically
 * overlapping. Uses each element's per-line boxes, so a span that wraps (in the
 * book layout, a run of punctuation and spaces can) lands on both its lines.
 * Returns, in order, [{ line: <p.target>, rects: [...] }].
 */
export function groupByLine(els) {
  const groups = [];
  for (const el of els) {
    const line = el.closest("p.target");
    for (const r of el.getClientRects()) {
      if (r.width < 1) continue;
      const mid = (r.top + r.bottom) / 2;
      let g = groups.find((x) => x.line === line && Math.abs(x.mid - mid) < Math.max(4, Math.min(x.h, r.bottom - r.top) * 0.5));
      if (!g) { g = { line, mid, h: r.bottom - r.top, rects: [] }; groups.push(g); }
      g.rects.push(r);
    }
  }
  return groups;
}

const unionRect = (rects) => ({
  left: Math.min(...rects.map((r) => r.left)),
  right: Math.max(...rects.map((r) => r.right)),
  top: Math.min(...rects.map((r) => r.top)),
  bottom: Math.max(...rects.map((r) => r.bottom)),
});

let geometry = null;

function render() {
  removeHighlights();
  if (!state) { geometry = null; hideKnobs(); return; }

  const els = state.spans.slice(state.lo, state.hi + 1);
  // Group the selected words by visual line. (A bilingual block's target is one
  // line; in the book layout a paragraph wraps over many.)
  const groups = groupByLine(els);

  let firstRect = null, lastRect = null, lastLineEl = null;
  for (const { line, rects } of groups) {
    const u = unionRect(rects);
    const lineBox = line.getBoundingClientRect();
    const hl = document.createElement("div");
    hl.className = "sel-hl";
    hl.style.left = `${u.left - lineBox.left - 3}px`;
    hl.style.top = `${u.top - lineBox.top - 2}px`;
    hl.style.width = `${u.right - u.left + 6}px`;
    hl.style.height = `${u.bottom - u.top + 4}px`;
    line.appendChild(hl);
    if (!firstRect) firstRect = u;
    lastRect = u;
    lastLineEl = line;
  }

  if (!lastRect) { geometry = null; hideKnobs(); return; }   // nothing laid out (yet)

  // The action bar sits under the English line of the last selected line — or,
  // with no English (book layout), right under the line itself.
  const block = lastLineEl && lastLineEl.closest(".reader-block");
  geometry = {
    first: firstRect,
    last: lastRect,
    blockBottom: block && !block.classList.contains("flow") ? block.getBoundingClientRect().bottom : lastRect.bottom,
  };
  positionKnobs();
}

function emit() {
  window.dispatchEvent(new CustomEvent("reader:selection", {
    detail: { active: !!state, dragging: !!drag, geometry },
  }));
}

// ── Drag handles ──

function ensureKnobs() {
  if (knobs) return knobs;
  const root = document.createElement("div");
  root.className = "sel-handles";
  const make = (which) => {
    const k = document.createElement("div");
    k.className = `sel-knob ${which}`;
    k.innerHTML = '<span class="sel-stem"></span><span class="sel-dot"></span>';
    k.addEventListener("pointerdown", (e) => onKnobDown(e, which));
    root.appendChild(k);
    return k;
  };
  knobs = { root, start: make("start"), end: make("end") };
  document.body.appendChild(root);
  return knobs;
}

function hideKnobs() { if (knobs) knobs.root.hidden = true; }

function positionKnobs() {
  const k = ensureKnobs();
  if (!geometry || drag === "new") { k.root.hidden = true; return; }
  k.root.hidden = false;
  const { first, last } = geometry;
  // Start handle: stem down the first line, dot above it. End handle: stem down
  // the last line, dot below it (the familiar iOS arrangement).
  const DOT = 14;
  Object.assign(k.start.style, { left: `${first.left}px`, top: `${first.top - DOT}px`, height: `${first.bottom - first.top + DOT}px` });
  Object.assign(k.end.style, { left: `${last.right}px`, top: `${last.top}px`, height: `${last.bottom - last.top + DOT}px` });
}

function onKnobDown(e, which) {
  if (!state || !geometry) return;
  e.preventDefault();
  e.stopPropagation();
  drag = which;
  const tip = which === "start"
    ? { x: geometry.first.left, y: (geometry.first.top + geometry.first.bottom) / 2 }
    : { x: geometry.last.right, y: (geometry.last.top + geometry.last.bottom) / 2 };
  knobGrab = { x: e.clientX - tip.x, y: e.clientY - tip.y };
  try { e.target.setPointerCapture(e.pointerId); } catch { /* not critical */ }
  emit();   // hides the action bar while adjusting
}

// ── Gesture handling ──

function armSuppress() {
  suppressClick = true;
  clearTimeout(suppressTimer);
  suppressTimer = setTimeout(() => { suppressClick = false; }, 450);
}

function beginAt(el) {
  const page = el.closest("section");
  if (!page) return false;
  const spans = collectSpans(page);
  const i = spans.indexOf(el);
  if (i < 0) return false;
  state = { page, spans, rects: spans.map((s) => s.getBoundingClientRect()), lo: i, hi: i, anchor: i };
  return true;
}

function startNewDrag(el) {
  if (!beginAt(el)) return;
  drag = "new";
  press = null;
  armSuppress();
  render();
  emit();
}

// Extend the selection to the word nearest (x, y) for the current drag kind.
function updateDragAt(x, y) {
  if (drag === "new") {
    const idx = nearestIndex(x, y);
    state.lo = Math.min(state.anchor, idx);
    state.hi = Math.max(state.anchor, idx);
  } else {
    const idx = nearestIndex(x - knobGrab.x, y - knobGrab.y);
    if (drag === "start") state.lo = Math.min(idx, state.hi);
    else state.hi = Math.max(idx, state.lo);
  }
  render();
}

// Word positions are cached in viewport coordinates; refresh after any scroll.
function remeasure() {
  if (state) state.rects = state.spans.map((el) => el.getBoundingClientRect());
}

function stopAutoScroll() {
  if (autoRaf) clearTimeout(autoRaf);
  autoRaf = null;
  lastPointer = null;
}

function autoScrollTick() {
  autoRaf = null;
  if (!drag || !state || !lastPointer) return;
  const page = state.page;
  const box = page.getBoundingClientRect();
  const top = Math.max(box.top, 0);
  const bottom = Math.min(box.bottom, window.innerHeight);
  const y = lastPointer.y;
  let dir = 0;
  if (y > bottom - EDGE_PX) dir = Math.min(1, (y - (bottom - EDGE_PX)) / EDGE_PX);
  else if (y < top + EDGE_PX) dir = -Math.min(1, (top + EDGE_PX - y) / EDGE_PX);
  if (!dir) return;                       // left the edge zone — stop until it re-enters
  const now = performance.now();
  const dt = Math.min(0.1, (now - autoLast) / 1000);   // cap so a stall can't jump far
  autoLast = now;
  const before = page.scrollTop;
  page.scrollTop = before + dir * Math.max(1, MAX_SPEED * dt);
  if (page.scrollTop !== before) {        // actually moved (not already at the end)
    remeasure();
    updateDragAt(lastPointer.x, lastPointer.y);
  }
  autoRaf = setTimeout(autoScrollTick, STEP_MS);
}

function onPointerDown(e) {
  if (e.button) return;                          // primary button only
  if (state) { clearSelection(); armSuppress(); } // a tap while selected just dismisses
  const el = e.target.closest && e.target.closest(WORD_SEL);
  if (!el) { press = null; return; }
  press = { id: e.pointerId, x: e.clientX, y: e.clientY, el, type: e.pointerType, timer: null };
  if (e.pointerType !== "mouse") {
    // Touch/pen: a still finger held for a moment starts selecting.
    press.timer = setTimeout(() => { if (press) startNewDrag(press.el); }, LONG_PRESS_MS);
  }
}

function onPointerMove(e) {
  if (drag) {
    if (!state) return;
    lastPointer = { x: e.clientX, y: e.clientY };
    updateDragAt(e.clientX, e.clientY);
    if (!autoRaf) { autoLast = performance.now(); autoRaf = setTimeout(autoScrollTick, STEP_MS); }
    return;
  }
  if (!press || e.pointerId !== press.id) return;
  const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
  if (press.type === "mouse") {
    if (moved > MOUSE_DRAG_PX) startNewDrag(press.el);
  } else if (moved > TOUCH_SLOP_PX) {
    // The finger moved before the hold finished — it's a swipe/scroll, not a selection.
    clearTimeout(press.timer);
    press = null;
  }
}

function onPointerUp() {
  if (press) { clearTimeout(press.timer); press = null; }
  stopAutoScroll();
  if (drag) {
    drag = null;
    armSuppress();        // the click that follows a drag must not open the popover
    render();
    emit();               // drag finished → the action bar can show
  }
}

function init() {
  const pages = $("reader-pages");
  if (!pages) return;

  pages.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);

  // Swallow the click that trails a selection gesture so it doesn't also open the
  // tap-to-learn popover. Capture phase: runs before the reader's own click handler.
  pages.addEventListener("click", (e) => {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  // Once a selection drag has begun, stop the page from scrolling/paging under the
  // finger. Must be a non-passive listener to be allowed to cancel the scroll.
  document.addEventListener("touchmove", (e) => { if (drag && e.cancelable) e.preventDefault(); }, { passive: false });

  // No native long-press menu inside the reading area.
  pages.addEventListener("contextmenu", (e) => e.preventDefault());

  // Tapping anywhere else (not the reading area, action bar or handles) dismisses.
  document.addEventListener("pointerdown", (e) => {
    if (!state) return;
    if (e.target.closest && e.target.closest("#reader-pages, #sel-toolbar, .sel-knob")) return;
    clearSelection();
  }, true);

  // Anything that moves or rewrites the text invalidates the highlight geometry.
  // Scroll events don't bubble, so listen in the capture phase to also hear the
  // pages' own vertical scrolling. Turning the page (the pager itself scrolls)
  // clears the selection; scrolling within a page keeps it and re-positions the
  // handles and action bar.
  pages.addEventListener("scroll", (e) => {
    if (!state) return;
    if (e.target === pages) { clearSelection(); return; }
    remeasure();
    render();
    if (!drag) emit();
  }, { passive: true, capture: true });
  window.addEventListener("resize", clearSelection);
  window.addEventListener("reader:script", clearSelection);
  window.addEventListener("reader:opened", clearSelection);
  window.addEventListener("reader:rerendered", clearSelection);
  window.addEventListener("view:changed", clearSelection);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") clearSelection(); });
}

export function initSelection() { init(); }
