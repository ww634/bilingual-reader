const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  const books = new Map();
  const chapters = new Map();
  const progress = new Map([['book/ch-1', { lastPage: 4 }]]);
  const requests = [];
  const elements = new Map();
  function element() {
    return { textContent: '', innerHTML: '', children: [], classList: { contains: () => false, add() {}, remove() {} },
      appendChild(child) { this.children.push(child); }, addEventListener() {},
      querySelector() { return this.actions ||= element(); } };
  }
  const catalog = { id: 'book', language: 'fr', version: 1, title: { english: 'Book' },
    chapters: [{ id: 'ch-1', version: 3, url: 'ch-1.json' }, { id: 'ch-2', version: 2, url: 'ch-2.json' }] };
  const context = vm.createContext({ URL, console: { ...console, error() {} }, navigator: { onLine: true },
    window: { location: { href: 'https://reader.test/app/' } },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element },
    getLearningLanguage: () => 'fr', languageName: () => 'French',
    getSettings: async () => ({ libraryUrl: 'https://reader.test/content/library.json' }),
    getAllBooks: async () => [...books.values()].map(b => structuredClone(b)),
    getAllChapterKeys: async () => [...chapters.keys()],
    getChapter: async (b, c) => chapters.get(`${b}/${c}`),
    putBook: async b => books.set(b.id, structuredClone(b)),
    putChapter: async (b, c, data) => chapters.set(`${b}/${c}`, structuredClone(data)),
    fetch: async url => {
      requests.push(url);
      if (context.fail && url.endsWith('ch-2.json')) throw Error('offline');
      return { ok: true, json: async () => ({ version: 1, pairs: [{ target: '« Bonjour. »', english: '“Hello.”' }] }) };
    },
  });
  let source = fs.readFileSync('app/js/library.js', 'utf8').replace(/import\s+[\s\S]*?from\s+"[^\"]+";/g, '').replace(/export /g, '');
  source += '\nrenderLibrary = () => {}; renderHomeCounts = () => {}; globalThis.api = { state, loadDownloadedIndex, renderBrowse, downloadBook };';
  vm.runInContext(source, context);
  return { ...context.api, context, books, chapters, progress, requests, elements, catalog, element };
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
