// Styx Sports service worker (4.0 phase 4.2): the app shell opens at once, and offline, from a
// cache that is refreshed in the background on every visit. Nothing else is cached: no API
// answers (the app keeps its own last schedule), no video (/hls/, /ts/), no sign-in pages, and
// no other hosts. A shell fetch that ends on the password page (signed out) is never stored.
const CACHE = 'styx-shell-v1';
const SHELL = ['/', '/app.js', '/app.css', '/tokens.css', '/wordmark.png', '/icon-192.png', '/manifest.webmanifest'];

async function refresh(cache, path) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (res.ok && !res.redirected && res.type === 'basic') await cache.put(path, res.clone());
  return res;
}

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map((p) => refresh(cache, p).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = req.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html') ? '/' : url.pathname;
  if (!SHELL.includes(path)) return;
  // Stale-while-revalidate: the cached copy now, a fresh one for next time.
  ev.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(path);
    if (cached) {
      ev.waitUntil(refresh(cache, path).catch(() => null));
      return cached;
    }
    // First visit: the browser's own request (a page load keeps its redirect handling, so the
    // password page still comes up when signed out), stored only when it is the real thing.
    const res = await fetch(req);
    if (res.ok && !res.redirected && res.type === 'basic') ev.waitUntil(cache.put(path, res.clone()));
    return res;
  })());
});
