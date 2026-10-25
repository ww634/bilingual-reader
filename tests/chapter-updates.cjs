const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  const books = new Map();
  const chapters = new Map();
  const progress = new Map([['book/ch-1', { lastPage: 4 }]]);
  const requests = [];
  let chapterReads = 0, progressReads = 0;
  const elements = new Map();
  function element() {
    return { textContent: '', innerHTML: '', children: [], classList: { contains: () => false, add() {}, remove() {} },
      appendChild(child) { this.children.push(child); }, addEventListener() {}, setAttribute() {},
      querySelector() { return this.actions ||= element(); } };
  }
  const catalog = { id: 'book', language: 'fr', version: 1, title: { english: 'Book' },
    chapters: [{ id: 'ch-1', version: 3, url: 'ch-1.json' }, { id: 'ch-2', version: 2, url: 'ch-2.json' }] };
  const context = vm.createContext({ URL, AbortController, setTimeout, clearTimeout, console: { ...console, error() {} }, navigator: { onLine: true },
    window: { addEventListener() {}, location: { href: 'https://reader.test/app/' } },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element },
    getLearningLanguage: () => 'fr', languageName: () => 'French',
    getSettings: async () => ({ libraryUrl: 'https://reader.test/content/library.json' }),
    getBook: async id => books.get(id),
    getAllBooks: async () => [...books.values()].map(b => structuredClone(b)),
    getAllChapterKeys: async () => [...chapters.keys()],
    getAllChapterMetadata: async () => [...chapters].map(([key,c]) => ({key,bookId:key.split('/')[0],chapterId:key.split('/')[1],version:c.catalogVersion??c.version??1,pairs:c.pairs?.length||0})),
    deleteChapter: async (b,c) => chapters.delete(`${b}/${c}`),
    chapterKey: (b,c) => `${b}/${c}`,
    getProgress: async (b,c) => progress.get(`${b}/${c}`),
    getAllProgress: async () => { progressReads++; return [...progress].map(([key,value]) => ({key,value})); },
    getChapter: async (b, c) => { chapterReads++; return chapters.get(`${b}/${c}`); },
    putBook: async b => books.set(b.id, structuredClone(b)),
    putChapter: async (b, c, data) => chapters.set(`${b}/${c}`, structuredClone(data)),
    putProgressRecord: async (key,value) => progress.set(key,structuredClone(value)),
    fetch: async url => {
      requests.push(url);
      if (context.fail && url.endsWith('ch-2.json')) throw Error('offline');
      return { ok: true, blob: async () => "new-cover", json: async () => ({ version: 1, pairs: [{ target: '« Bonjour. »', english: '“Hello.”' }] }) };
    },
  });
  let source = fs.readFileSync('app/js/library.js', 'utf8').replace(/import\s+[\s\S]*?from\s+"[^\"]+";/g, '').replace(/export /g, '');
  source += '\nrenderLibrary = () => {}; renderHomeCounts = () => {}; globalThis.api = { state, loadDownloadedIndex, renderBrowse, downloadBook, downloadChapter, computeBookProgress };';
  vm.runInContext(source, context);
  return { ...context.api, context, books, chapters, progress, requests, elements, catalog, element, reads: () => ({chapterReads,progressReads}) };
}

test('chapter-only revisions show Update and replace old text without removing progress', async () => {
  const s = setup(); s.books.set('book', s.catalog);
  s.chapters.set('book/ch-1', { version: 2, pairs: [{ target: 'Old text' }] });
  s.chapters.set('book/ch-2', { version: 2, pairs: [{ target: 'Current text' }] });
  s.state.catalog = { books: [s.catalog] }; s.state.downloadedBooks = await s.loadDownloadedIndex();
  s.renderBrowse();
  const row = s.elements.get('browse-list').children[0];
  assert.match(row.innerHTML, /Update available/);
  assert.equal(row.actions.children[0].textContent, 'Update');
  await s.downloadBook(s.catalog, s.element());
  assert.equal(s.requests.length, 1);
  assert.equal(s.chapters.get('book/ch-1').pairs[0].target, '« Bonjour. »');
  assert.equal(s.chapters.get('book/ch-1').catalogVersion, 3);
  assert.equal(s.progress.get('book/ch-1').lastPage, 4);
  await s.downloadBook(s.catalog, s.element());
  assert.equal(s.requests.length, 1, 'matching catalogue revision must not re-download');
});

test('interrupted update remains available despite already-updated book metadata', async () => {
  const s = setup(); s.books.set('book', s.catalog);
  for (const id of ['ch-1', 'ch-2']) s.chapters.set(`book/${id}`, { version: 1, pairs: [{ target: 'Old' }] });
  s.state.catalog = { books: [s.catalog] }; s.context.fail = true;
  await s.downloadBook(s.catalog, s.element());
  s.state.downloadedBooks = await s.loadDownloadedIndex(); s.renderBrowse();
  assert.match(s.elements.get('browse-list').children[0].innerHTML, /Update available/);
  s.context.fail = false; await s.downloadBook(s.catalog, s.element());
  assert.equal(s.requests.filter(u => u.endsWith('ch-1.json')).length, 1);
  assert.equal(s.chapters.get('book/ch-2').catalogVersion, 2);
});

test('missing or empty chapters resume and legacy files are stamped with catalogue versions', async () => {
  const s = setup(); s.books.set('book', s.catalog);
  s.chapters.set('book/ch-1', { version: 3, pairs: [] });
  s.state.catalog = { books: [s.catalog] }; s.state.downloadedBooks = await s.loadDownloadedIndex();
  s.renderBrowse(); assert.match(s.elements.get('browse-list').children[0].innerHTML, /Partial/);
  await s.downloadBook(s.catalog, s.element());
  assert.equal(s.requests.length, 2);
  assert.equal(s.state.downloadedBooks.get('book').downloadedChapterCount, 2);
});

 test('book edition updates refresh cached covers and preserve reading progress', async () => {
  const s = setup();
  s.books.set('book', { ...s.catalog, coverBlob: 'old-cover' });
  s.state.downloadedBooks = await s.loadDownloadedIndex();
  for (const c of s.catalog.chapters) s.chapters.set(`book/${c.id}`, { catalogVersion: c.version, pairs: [{}] });
  const updated = { ...s.catalog, version: 2, cover: 'books/book/cover.svg' };
  await s.downloadBook(updated, s.element());
  assert.equal(s.books.get('book').coverBlob, 'new-cover');
  assert.match(s.requests[0], /cover.svg\?edition=2$/);
  assert.equal(s.requests.length, 1);
  assert.equal(s.progress.get('book/ch-1').lastPage, 4);
  await s.downloadBook(updated, s.element());
  assert.equal(s.requests.length, 1);
});

 test('startup and progress use chapter summaries without reading book prose', async () => {
  const s=setup();const book={...s.catalog,chapters:Array.from({length:300},(_,i)=>({id:`ch-${i+1}`}))};s.books.set('book',book);
  for(const ch of book.chapters)s.chapters.set(`book/${ch.id}`,{version:1,pairs:Array(150).fill({})});
  const index=await s.loadDownloadedIndex();assert.equal(index.get('book').downloadedChapterCount,300);assert.equal(s.reads().chapterReads,0);
  const progress=await s.computeBookProgress(index.get('book'));assert.ok(progress.totalUnits>300);assert.equal(s.reads().chapterReads,0);assert.equal(s.reads().progressReads,1);
 });
 test('duplicate Add clicks share one download and dropped chapters retain study progress', async () => {
  const s=setup();await Promise.all([s.downloadBook(s.catalog,s.element()),s.downloadBook(s.catalog,s.element())]);
  assert.equal(s.requests.length,2);s.progress.set('book/ch-2',{lastPage:3});
  await s.downloadBook({...s.catalog,version:2,chapters:[s.catalog.chapters[0]]},s.element());
  assert.equal(s.chapters.has('book/ch-2'),false);assert.equal(s.progress.get('book/ch-2').lastPage,3);
 });

test('sentence-unit updates map the saved pair without changing its read time',async()=>{
 const s=setup();const catalog={...s.catalog,chapters:[s.catalog.chapters[0]]};s.chapters.set('book/ch-1',{version:2,pairs:[{},{}]});s.progress.set('book/ch-1',{lastPage:2,pair:1,updatedAt:'2026-10-01T00:00:00Z'});
 s.context.fetch=async()=>({ok:true,json:async()=>({version:3,pairs:[{},{},{},{}],meta:{sentence_unit_repair:{from_version:2,pair_index_map:[0,2]}}})});await s.downloadBook(catalog,s.element());assert.equal(s.progress.get('book/ch-1').pair,2);assert.equal(s.progress.get('book/ch-1').updatedAt,'2026-10-01T00:00:00Z');
});
test('single missing chapter download leaves other downloads and progress intact',async()=>{
 const s=setup();s.books.set('book',s.catalog);s.chapters.set('book/ch-1',{version:3,pairs:[{target:'kept'}]});s.state.catalog={books:[s.catalog]};
 s.context.fetch=async()=>({ok:true,json:async()=>({book_id:'book',id:'ch-2',language:'fr',version:2,pairs:[{target:'Bonjour.'}]})});
 await Promise.all([s.downloadChapter('book','ch-2'),s.downloadChapter('book','ch-2')]);assert.equal(s.chapters.size,2);assert.equal(s.chapters.get('book/ch-1').pairs[0].target,'kept');assert.equal(s.progress.get('book/ch-1').lastPage,4);
});
test('book progress uses saved sentence anchors rather than retired page-size estimates',async()=>{
 const s=setup();const book={...s.catalog,chapterIndex:{'ch-1':{pairs:100},'ch-2':{pairs:100}}};s.progress.set('book/ch-1',{lastPage:77,pair:49,updatedAt:'2026-10-25T12:00:00Z'});const report=await s.computeBookProgress(book);assert.equal(report.pct,25);assert.equal(report.chapterProgress.get('ch-1').finished,false);s.progress.set('book/ch-1',{lastPage:99,pair:-1,updatedAt:'2026-10-25T12:00:00Z'});assert.equal((await s.computeBookProgress(book)).pct,50);
});
