# Bilingual Reader (PWA)

A personal-use Progressive Web App for reading paired-line bilingual chapters (Mandarin pinyin / English, with Spanish coming later). Designed to be installed to the iPhone home screen and used offline — perfect for planes.

```
.
├── app/                # The PWA (static files — what you host)
│   ├── index.html
│   ├── styles.css
│   ├── manifest.webmanifest
│   ├── sw.js
│   ├── icons/
│   └── js/
└── content/            # Chapter content (fetched by the PWA at runtime)
    ├── library.json
    └── chapters/
        └── ch-2001.json
```

The PWA fetches `content/library.json` to discover available chapters, downloads selected chapters into IndexedDB for offline use, and renders them as horizontally-paginated paired lines (bold target language on top, English below).

---

## 1. Run locally

The PWA must be served over HTTP (not `file://`) for service workers and modules to work. Easiest:

```bash
cd "Learn Chinese"
python3 -m http.server 8000
```

Then open <http://localhost:8000/app/> in your browser. The default library URL (`../content/library.json`) will resolve correctly relative to the app.

You should see Chapter 2001 in the library — tap **Download**, then tap **Read**. Swipe horizontally to navigate pages.

### Test from your iPhone over the local network

1. Find your Mac's local IP: `ipconfig getifaddr en0`
2. From the iPhone (on the same Wi-Fi), open `http://<that-ip>:8000/app/`
3. Safari → Share → **Add to Home Screen**

Note: Safari is strict about service workers without HTTPS. Local testing works for the basic flow; full offline behavior is best verified after you deploy to GitHub Pages.

---

## 2. Deploy to GitHub Pages

One repo holds both the app and the content. Same-origin means no CORS headaches.

```bash
cd "Learn Chinese"
git init
git add .
git commit -m "Initial reader PWA + sample chapter"
gh repo create bilingual-reader --public --source=. --push
```

Then enable Pages:

1. GitHub → your repo → **Settings → Pages**
2. **Source: Deploy from a branch**
3. **Branch: `main`**, folder: `/ (root)`
4. Save. Wait ~1 minute for the first deploy.

Your PWA lives at:
```
https://<your-username>.github.io/bilingual-reader/app/
```

Its library URL will be:
```
https://<your-username>.github.io/bilingual-reader/content/library.json
```

The default `../content/library.json` already resolves to that path — no manual config needed once deployed.

### Install on iPhone

1. Open the deployed URL in Safari on your iPhone.
2. Share button → **Add to Home Screen**.
3. Launch from the home-screen icon — it opens as a standalone app.

---

## 3. Add new chapters

The content side is intentionally dead-simple: drop a `chapter.json` into `content/chapters/`, add an entry to `content/library.json`, commit, push. The PWA will pick it up next time it's online.

### `chapter.json` schema

```json
{
  "id": "ch-2002",
  "language": "zh",
  "version": 1,
  "title": {
    "target": "Dì èr líng líng èr zhāng: ...",
    "english": "Chapter 2002: ..."
  },
  "pairs": [
    { "target": "...", "english": "..." },
    { "target": "...", "english": "..." }
  ],
  "meta": {
    "source": "(optional note)",
    "createdAt": "YYYY-MM-DD"
  }
}
```

- `id` — kebab-case, unique. Used as the IndexedDB key.
- `language` — `"zh"` for Chinese, `"es"` for Spanish (Spanish UI is deferred).
- `version` — bump this when you re-edit a chapter; the app shows an "Update" badge so you can re-download.
- `pairs` — flat array, in reading order. No sections, no headings nested inside.

### `library.json` schema

```json
{
  "version": 1,
  "chapters": [
    {
      "id": "ch-2001",
      "language": "zh",
      "version": 1,
      "title": { "target": "...", "english": "..." },
      "url": "chapters/ch-2001.json"
    }
  ]
}
```

`url` is resolved relative to `library.json`, so a sibling path like `chapters/ch-2001.json` works fine.

---

## 4. LLM prompt template for generating chapters

You said you generate the bilingual paired text via an LLM. Use this prompt to make it output `chapter.json` directly — no manual conversion needed.

> **System / instructions:**
> You are a translator producing a bilingual paired-line learning document. You will be given an English passage. Your job is to translate it into natural Mandarin Chinese, rendered as **pinyin with tone marks** (no Chinese characters), and emit a JSON document I can drop into a personal reading app.
>
> **Hard rules:**
> 1. Split the English into short clauses of roughly 3–10 words. Break on commas, semicolons, em dashes, and sentence boundaries. Don't pair full long sentences — keep clauses short for legible word-order mapping.
> 2. Translate each clause into natural Chinese phrasing within that clause's scope — not word-for-word.
> 3. Pinyin only. **Tone marks mandatory** (mā / má / mǎ / mà). Numbered pinyin (ma1, ma2) is **not** acceptable.
> 4. Word spacing follows standard pinyin orthography: syllables of a single word run together (e.g., `zhàndòu`), separate words space-separated.
> 5. Transliterate proper nouns to pinyin by default.
> 6. Return **only valid JSON**, no commentary, no markdown fence. The JSON must match this schema:
>
> ```json
> {
>   "id": "<kebab-case-id-I-give-you>",
>   "language": "zh",
>   "version": 1,
>   "title": { "target": "<pinyin title>", "english": "<English title>" },
>   "pairs": [
>     { "target": "<pinyin clause>", "english": "<English clause>" }
>   ],
>   "meta": { "source": "<short note>", "createdAt": "<YYYY-MM-DD>" }
> }
> ```
>
> **Inputs I will provide:**
> - `id`: the chapter id (e.g. `ch-2002`)
> - `english_title`: the chapter's English title
> - `passage`: the English prose to translate
>
> Output the JSON and nothing else.

When the chapter is ready, save the output as `content/chapters/<id>.json`, add a matching entry to `content/library.json`, commit, push. Done.

For **Spanish**, swap rule 3 for: "Output the Spanish translation with proper accent marks (á, é, í, ó, ú, ñ, ¿, ¡). Natural Spanish phrasing within each clause." And set `"language": "es"` in the JSON.

---

## 5. The offline flow

1. **Online (at home / on Wi-Fi):** open the app. Library refreshes from GitHub. Tap **Download** on chapters you want for the flight.
2. **Before flight:** double-check downloaded chapters show the ✓ pill in the library. Optionally airplane-mode-test by toggling Wi-Fi off and confirming chapters still open.
3. **Offline (on plane):** open the app from your home screen. Library shows cached rows; downloaded chapters open normally. Page position is saved as you read.
4. **After landing:** reopen the app. Library refreshes; "Update" badges appear on any chapters whose version bumped in the repo while you were away.

All offline data lives in IndexedDB inside the PWA's storage — independent of the Files app, independent of iCloud, no sync required.

---

## 6. Settings

Accessible via the ⚙ button in the top right:

- **Library URL** — defaults to `../content/library.json`. Change this if you ever split content into a separate repo.
- **Font size** — small / medium / large.
- **Pairs per page** — 5–10. Default 7. Tune in-hand.
- **Clear cache** — wipes all downloaded chapters, progress, and settings.

---

## 7. What's deferred (not in v1)

- AI-generated quizzes per chapter
- Spanish UI toggle (data model already supports `language: "es"`)
- Text-to-speech audio playback
- Tone-color highlighting on pinyin
- Tap-to-reveal Chinese characters
- Vocabulary side-panel
- Cross-device progress sync

The schema and architecture are designed so any of these can be added without breaking changes.
