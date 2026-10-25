import { getSettings, updateSettings, getAllBooks, getLibrary } from './db.js';
import { getLearningLanguage, setLearningLanguage } from './languages.js';
import { downloadChapter, refreshCatalog } from './library.js';
export async function showWelcome({ force = false } = {}) {
  const settings = await getSettings();
  if (!force && (settings.welcomeCompleted || (await getAllBooks()).length)) return;
  if (document.getElementById('welcome-panel')) return;
  let step = 0, starter = null;
  const overlay = document.createElement('div'); overlay.className = 'welcome-overlay';
  const panel = document.createElement('section'); panel.id = 'welcome-panel'; panel.className = 'welcome-panel';
  panel.setAttribute('role','dialog'); panel.setAttribute('aria-modal','true'); overlay.append(panel); document.body.append(overlay);
  const finish = async () => { await updateSettings({welcomeCompleted:true}); overlay.remove(); window.dispatchEvent(new CustomEvent("welcome:complete")); };
  async function draw() {
    panel.replaceChildren();
    const label = document.createElement('p'); label.className='home-eyebrow'; label.textContent=`Getting started · ${step+1} of 3`;
    const title=document.createElement('h2'); const text=document.createElement('p'); const next=document.createElement('button'); next.className='btn-primary btn-block';
    panel.append(label,title,text);
    if(step===0) {
      title.textContent='Which language are you learning?';text.textContent='Read with an English guide and keep useful words for later.';
      const select=document.createElement('select');select.setAttribute('aria-label','Choose a language');
      for(const [value,name] of [['zh','Chinese'],['fr','French']]){const option=document.createElement('option');option.value=value;option.textContent=name;select.append(option)}select.value=getLearningLanguage();panel.append(select);
      next.textContent='Continue';next.onclick=async()=>{await setLearningLanguage(select.value);step++;draw()};
    } else if(step===1) {
      title.textContent='Add a first chapter';text.textContent='Start with one chapter. Download the rest from the book’s page whenever you’re ready.';
      const select=document.createElement('select');select.setAttribute('aria-label','Choose a starter book');panel.append(select);
      let catalogue=await getLibrary();
      if(!catalogue?.books?.length){try{await refreshCatalog();catalogue=await getLibrary()}catch{}}
      for(const book of catalogue?.books||[]){if(book.language!==getLearningLanguage()||['la-lettre-du-grenier','the-river-repair-shop'].includes(book.id))continue;const option=document.createElement('option');option.value=book.id;option.textContent=book.title.english;select.append(option)}
      next.textContent=select.options.length?'Add first chapter':'Browse books later';
      next.onclick=async()=>{if(select.value){next.disabled=true;skip.disabled=true;next.textContent='Downloading…';try{const book=catalogue.books.find(b=>b.id===select.value);await downloadChapter(book.id,book.chapters[0].id);starter={bookId:book.id,chapterId:book.chapters[0].id}}catch(error){text.textContent=error.message;next.disabled=false;skip.disabled=false;next.textContent='Retry download';return}}step++;draw()};
      const skip=document.createElement('button');skip.textContent='Skip for now';skip.onclick=()=>{step++;draw()};panel.append(skip);
    } else {
      title.textContent='Make the page your own';text.textContent='Tap a word for its meaning. Long-press and drag to select text, then use Save. Tap › for Copy and Feedback. Listen reads the chapter aloud. Swipe sideways to turn pages.';
      const note=document.createElement('p');note.className='hint';note.textContent='AI explanations, voices and practice stories are optional. Add your own OpenAI key in Settings; ordinary reading and saved words do not need one.';
      const ai=document.createElement('button');ai.textContent='Set up AI (optional)';ai.onclick=async()=>{await finish();window.dispatchEvent(new CustomEvent('app:settings',{detail:'ai'}))};panel.append(note,ai);
      next.textContent=starter?'Start reading':'Browse books';next.onclick=async()=>{await finish();window.dispatchEvent(new CustomEvent(starter?'nav:reader':'app:setview',{detail:starter||'browse'}))};
    }
    panel.append(next);title.tabIndex=-1;title.focus();
  }
  draw();
}
