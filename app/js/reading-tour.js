import { updateSettings } from './db.js';
import { closePopover } from './popover.js';

let stopTour = null;
export const isReadingTourActive = () => !!stopTour;

// Keep the card inside the usable viewport and on the other side of its target.
export function placeTourCard(rect, width, height, cardHeight, top = 16, bottom = height - 16) {
  const cardWidth = Math.min(350, width - 32);
  const below = bottom - rect.bottom, above = rect.top - top;
  const y = below >= cardHeight + 28 || below >= above
    ? Math.min(bottom - cardHeight, rect.bottom + 28)
    : Math.max(top, rect.top - cardHeight - 28);
  return { left: Math.max(16, Math.min(width - cardWidth - 16, rect.left + rect.width / 2 - cardWidth / 2)), top: Math.max(top, y), width: cardWidth };
}

export function closeReadingTour() { stopTour?.(false); }

export function showReadingTour({ preparePage, restorePage, previewWord }) {
  closeReadingTour();
  const previousFocus = document.activeElement;
  const app = document.getElementById('app'), wasInert = app.inert;
  const root = document.createElement('div'); root.id = 'reading-tour';
  root.innerHTML = `<div class="tour-spotlight" aria-hidden="true"></div>
    <svg class="tour-arrow" aria-hidden="true"><defs><marker id="tour-arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M1 1 L6 4 L1 7"/></marker></defs><path class="tour-arrow-line" marker-end="url(#tour-arrowhead)"/></svg>
    <section class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-description">
      <div class="tour-heading"><span class="tour-count"></span><button class="tour-skip">Skip tour</button></div>
      <h2 id="tour-title" tabindex="-1"></h2><p id="tour-description"></p>
      <div class="tour-actions"><button class="tour-back">Back</button><button class="tour-next btn-primary">Next</button></div>
    </section>`;
  document.body.append(root); document.body.classList.add('reader-tour-active'); app.inert = true;
  preparePage();
  const card = root.querySelector('.tour-card'), title = root.querySelector('h2');
  const word = () => [...document.querySelectorAll('#reader-pages .target .chunk')].find(visible);
  const line = () => word()?.closest('.target');
  const guide = () => [...document.querySelectorAll('#reader-pages .english')].find(el => visible(el) && el.textContent.trim());
  const steps = [
    { title: 'Every word has a meaning', text: 'Tap a word like this to see its meaning in this sentence. This tour only shows you around; nothing is saved or played.', target: word },
    { title: 'Keep a useful word', text: 'This is the word’s own menu. Save to Memory Vault keeps it for later review and quizzes. You can do that after the tour.', target: () => document.getElementById('pop-act-save'), enter: () => { previewWord(word()); document.getElementById('pop-act-save').scrollIntoView({ block: 'nearest' }); }, available: () => !!word() },
    { title: 'English follows the text', text: 'These English hints follow the words above. Use them when you need a hand, or hide them in Reading options.', target: guide },
    { title: 'Select a whole phrase', text: 'Long-press the reading text, then drag to extend your selection. A menu appears with actions for the selected phrase.', target: line },
    { title: 'Listen to your chapter', text: 'Listen opens the audio player. From there you can play, pause, move between sentences and change the speed. AI voices need your optional API key.', target: () => document.getElementById('listen-btn') },
    { title: 'Ask about what you’re reading', text: 'Open the language assistant here to ask about grammar or meaning. It uses your optional API key; ordinary reading works without one.', target: () => document.getElementById('assistant-btn') },
    { title: 'Make reading comfortable', text: 'Reading options lets you change the English hints, word categories and reading display. Chinese books also offer characters and pinyin when included.', target: () => document.getElementById('reader-options-btn') },
    { title: 'Turn the page', text: 'Swipe left to move forward and right to go back. This counter shows where you are in the chapter.', target: () => document.getElementById('page-indicator') },
    { title: 'Settings is always nearby', text: 'Change your font size or add your optional OpenAI key here. You can also replay this reading tour from Settings whenever you like.', target: () => document.getElementById('settings-btn') },
  ].filter(step => step.available ? step.available() : visible(step.target()));
  let index = 0, target, frame, ended = false;
  const observer = new ResizeObserver(() => schedule()); observer.observe(card);

  function position() {
    if (ended) return;
    // Reader reflow replaces word nodes. Resolve a fresh target each time.
    target = steps[index].target();
    if (!visible(target)) { end(false); return; }
    const rect = target.getBoundingClientRect();
    const vv = window.visualViewport;
    const width = vv?.width || innerWidth, height = vv?.height || innerHeight;
    const offsetTop = vv?.offsetTop || 0;
    const safe = getComputedStyle(root);
    const minTop = offsetTop + (parseFloat(safe.paddingTop) || 16);
    const maxBottom = offsetTop + height - (parseFloat(safe.paddingBottom) || 16);
    card.style.width = `${Math.min(350, width - 32)}px`;
    const p = placeTourCard(rect, width, height, card.offsetHeight, minTop, maxBottom);
    Object.assign(card.style, { left: `${p.left}px`, top: `${p.top}px` });
    const hole = root.querySelector('.tour-spotlight');
    Object.assign(hole.style, { left: `${Math.max(4, rect.left - 6)}px`, top: `${Math.max(4, rect.top - 6)}px`, width: `${Math.min(width - 8, rect.width + 12)}px`, height: `${rect.height + 12}px` });
    const below = p.top >= rect.bottom;
    const fromX = Math.max(p.left + 24, Math.min(p.left + p.width - 24, rect.left + rect.width / 2));
    const fromY = below ? p.top - 2 : p.top + card.offsetHeight + 2;
    const toX = rect.left + rect.width / 2, toY = below ? rect.bottom + 9 : rect.top - 9;
    root.querySelector('.tour-arrow-line').setAttribute('d', `M ${fromX} ${fromY} L ${toX} ${toY}`);
  }
  function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); }
  function draw() {
    closePopover();
    steps[index].enter?.();
    root.querySelector('.tour-count').textContent = `Reading tour · ${index + 1} of ${steps.length}`;
    title.textContent = steps[index].title;
    root.querySelector('#tour-description').textContent = steps[index].text;
    root.querySelector('.tour-back').disabled = index === 0;
    root.querySelector('.tour-next').textContent = index === steps.length - 1 ? 'Start reading' : 'Next';
    root.dataset.step = String(index + 1);
    title.focus({ preventScroll: true }); position();
  }
  function end(completed) {
    if (ended) return;
    ended = true; stopTour = null; cancelAnimationFrame(frame); observer.disconnect();
    window.removeEventListener('resize', schedule); window.removeEventListener('reader:rerendered', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
    window.removeEventListener('view:changed', viewChanged);
    closePopover(); restorePage(); root.remove(); document.body.classList.remove('reader-tour-active'); app.inert = wasInert;
    if (completed) updateSettings({ readerHintsSeen: true }).catch(() => {});
    if (previousFocus?.isConnected && previousFocus.getBoundingClientRect().width) previousFocus.focus({ preventScroll: true });
  }
  function viewChanged(event) { if (event.detail !== 'reader') end(false); }
  root.querySelector('.tour-next').onclick = () => { if (index === steps.length - 1) end(true); else { index++; draw(); } };
  root.querySelector('.tour-back').onclick = () => { if (index > 0) { index--; draw(); } };
  root.querySelector('.tour-skip').onclick = () => end(true);
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); end(true); }
    if (event.key !== 'Tab') return;
    const buttons = [...card.querySelectorAll('button:not(:disabled)')];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === title)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  stopTour = end;
  window.addEventListener('resize', schedule); window.addEventListener('reader:rerendered', schedule);
  window.visualViewport?.addEventListener('resize', schedule); window.visualViewport?.addEventListener('scroll', schedule);
  window.addEventListener('view:changed', viewChanged);
  if (steps.length) draw(); else end(false);
}

function visible(element) {
  if (!element || element.hidden) return false;
  const r = element.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight && getComputedStyle(element).visibility !== 'hidden';
}
