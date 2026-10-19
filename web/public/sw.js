// Styx Sports service worker (4.0 phase 4.2): the app shell opens at once, and offline, from a
// cache that is refreshed in the background on every visit. Nothing else is cached: no API
// answers (the app keeps its own last schedule), no video (/hls/, /ts/), no sign-in pages, and
// no other hosts. A shell fetch that ends on the password page (signed out) is never stored.
//
// The page, its script and its styles depend on each other, so they are stored only as a set
// (CORE, all or nothing): a launch never pairs an index.html from one release with the app.js or
// app.css of another (a cached page without the elements the newer script needs stopped it at
// "Loading events…"). Bump CACHE when the caching itself changes; activate drops older caches.
const CACHE = 'styx-shell-v2';
const SHELL = ['/', '/app.js', '/app.css', '/tokens.css', '/wordmark.png', '/icon-192.png', '/manifest.webmanifest'];
const CORE = ['/', '/app.js', '/app.css'];

/** The real file, or null (an error, or the password page while signed out). */
async function fetchShell(path) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  return res.ok && !res.redirected && res.type === 'basic' ? res : null;
}

async function refresh(cache, path) {
  const res = await fetchShell(path);
  if (res) await cache.put(path, res.clone());
  return res;
}

/** CORE, fetched together and stored only when every file arrived whole (read into memory first). */
async function refreshCore(cache) {
  const got = await Promise.all(CORE.map(async (path) => {
    const res = await fetchShell(path).catch(() => null);
    if (!res) return null;
    const body = await res.arrayBuffer().catch(() => null);
    return body && new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }));
  if (got.some((r) => !r)) return;
  await Promise.all(CORE.map((path, i) => cache.put(path, got[i])));
}

/** For a new worker's cache: a fresh copy of a file outside CORE, else the one an older cache holds. */
async function fillShell(cache, path) {
  if (await refresh(cache, path).catch(() => null)) return;
  const old = await caches.match(path).catch(() => null);
  if (old) await cache.put(path, old);
}

async function holdsCore(cache) {
  return (await Promise.all(CORE.map((path) => cache.match(path)))).every(Boolean);
}

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all([refreshCore(cache).catch(() => null)]
      .concat(SHELL.filter((p) => !CORE.includes(p)).map((p) => fillShell(cache, p).catch(() => null))));
    // A worker takes over (and activate drops the older caches) only with a whole CORE set in its
    // cache: when the page, script or styles did not all arrive (a failed fetch, or signed out),
    // the install fails, the worker in charge keeps serving its own cache, and the browser tries
    // again on a later launch.
    if (!(await holdsCore(cache))) throw new Error('styx: shell incomplete');
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
  const core = CORE.includes(path);
  // Stale-while-revalidate: the cached copy now, a fresh one for next time.
  ev.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(path);
    // The set is refreshed when the page asks for its script, the last of the three it loads:
    // this launch has already been given its page and styles from the cache, so it stays whole.
    if (path === '/app.js') ev.waitUntil(refreshCore(cache).catch(() => null));
    else if (!core && cached) ev.waitUntil(refresh(cache, path).catch(() => null));
    if (cached) return cached;
    // Not cached: the browser's own request (a page load keeps its redirect handling, so the
    // password page still comes up when signed out). A CORE file is stored only by refreshCore.
    const res = await fetch(req);
    if (!core && res.ok && !res.redirected && res.type === 'basic') ev.waitUntil(cache.put(path, res.clone()));
    return res;
  })());
});
