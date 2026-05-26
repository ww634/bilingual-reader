// Service worker — caches the app shell only.
// Chapter content is stored in IndexedDB by the app, not here.

const SHELL_CACHE = "reader-shell-v1";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/main.js",
  "./js/db.js",
  "./js/library.js",
  "./js/reader.js",
  "./js/settings.js",
  "./icons/icon.svg",
];

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
      Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Network-first for library.json and chapter JSONs so updates show up online.
  // The app itself handles offline fallback via IndexedDB — SW just lets the
  // network call fail and the app catches it.
  if (url.pathname.endsWith("library.json") || url.pathname.includes("/chapters/")) {
    return; // default fetch
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
