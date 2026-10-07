// Service worker: keeps the app shell (HTML/CSS/JS/icons) so the app opens even
// when the server can't be reached. Song data lives in IndexedDB, not here; API
// calls and YouTube are never cached.
//
// Strategy: network first (with a short timeout) so updates show up right away,
// falling back to the cached copy when the server is unreachable.

const CACHE = "lyric-player-shell-v2";
const NETWORK_TIMEOUT_MS = 3000;

// Every file the app needs to start. tests/test_pwa.py checks this covers static/js/*.js.
const SHELL = [
  "/",
  "/index.html",
  "/style.css",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/js/api.js",
  "/js/calibration.js",
  "/js/calibrator.js",
  "/js/create.js",
  "/js/data.js",
  "/js/keyboard.js",
  "/js/library-sync.js",
  "/js/library.js",
  "/js/lyrics.js",
  "/js/main.js",
  "/js/player.js",
  "/js/scroll.js",
  "/js/settings.js",
  "/js/songbar.js",
  "/js/store.js",
  "/js/sync.js",
  "/js/tapper.js",
  "/js/tapping.js",
  "/js/ui.js",
  "/js/util.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function fetchWithTimeout(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS);
    // no-cache: always revalidate with the server (304 if unchanged), never trust a stale HTTP cache
    fetch(request, { cache: "no-cache" }).then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // the page itself, whatever the hash/query: served as /index.html when offline
  const cacheKey = request.mode === "navigate" ? "/index.html" : url.pathname;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetchWithTimeout(request);
        // a proxy error page (server down behind tailscale serve) is not the app: use the cache
        if (response.status >= 502 && response.status <= 504) throw new Error(`HTTP ${response.status}`);
        if (response.ok) cache.put(cacheKey, response.clone());
        return response;
      } catch (err) {
        const cached = await cache.match(cacheKey);
        if (cached) return cached;
        throw err;
      }
    })(),
  );
});
