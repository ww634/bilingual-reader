// Service worker — caches the app shell only.
// Chapter content is stored in IndexedDB by the app, not here.

// Keep this version in sync with APP_VERSION in js/version.js — bump both on
// each deploy so the version shown in Settings matches the cached shell.
const SHELL_CACHE = "reader-shell-v51";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/version.js",
  "./js/languages.js",
  "./js/vault.js",
  "./js/main.js",
  "./js/db.js",
  "./js/library.js",
  "./js/reader.js",
  "./js/popover.js",
  "./js/settings.js",
  "./js/reader-options.js",
  "./js/assistant.js",
  "./js/selection.js",
  "./js/speech.js",
  "./js/backup.js",
  "./js/home.js",
  "./js/listen.js",
  "./js/levels.js",
  "./js/chapterquiz.js",
  "./js/write.js",
  "./js/stories.js",
  "./js/feedback.js",
  "./data/zh-levels.tsv",
  "./icons/icon.svg",
];

// Caches that hold the learner's own (paid-for / slow-to-fetch) data. They are
// kept across app updates — only old app-shell caches are deleted on activate.
const KEEP_CACHE_PREFIXES = ["tts-audio", "hanzi-data"];
const HANZI_DATA_CACHE = "hanzi-data-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Best-effort: don't fail install if one asset 404s during dev.
      Promise.all(
        SHELL_FILES.map((url) =>
          cache.add(url).catch((err) => console.warn("SW cache miss:", url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys
        .filter((k) => k !== SHELL_CACHE && !KEEP_CACHE_PREFIXES.some((p) => k.startsWith(p)))
        .map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Network-first for library.json and per-book content so updates show up
  // online. The app itself handles offline fallback via IndexedDB — SW just
  // lets the network call fail and the app catches it.
  if (url.pathname.endsWith("library.json") || url.pathname.includes("/books/")) {
    return; // default fetch
  }

  // Stroke-order data for handwriting practice: cache-first, kept forever, so a
  // character seen once works offline.
  if (url.hostname === "cdn.jsdelivr.net" && url.pathname.includes("/hanzi-writer-data")) {
    event.respondWith(
      caches.open(HANZI_DATA_CACHE).then((cache) =>
        cache.match(req).then((hit) => hit || fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        }))
      )
    );
    return;
  }

  // Cache-first for app shell.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Cache same-origin successful GETs into the shell cache.
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
