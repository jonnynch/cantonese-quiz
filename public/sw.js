/* Service worker for offline use.
   - Precaches the application shell (HTML, JS, manifest, icons) as ONE versioned, all-or-nothing cache.
   - Serves the shell cache-first from the CURRENT version's cache only, so HTML, CSS and JavaScript can never come from different versions.
   - A new version installs in the background and then WAITS. It is only activated when the page asks for it (the learner taps
     "立即更新" at a safe moment) or when every tab has been closed. It never calls skipWaiting by itself.
   - It does not use IndexedDB at all and never caches learner data: nothing but the files listed in PRECACHE is ever stored.
   VERSION is the hash of the PRECACHE files; run `npm run stamp-sw` after changing anything in public/ (a test enforces this). */
'use strict';
const PREFIX = 'cq-shell-';
const VERSION = '52671095d9ab';
const CACHE = PREFIX + VERSION;
const PRECACHE = [
  './',
  'manifest.webmanifest',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'js/storage.js',
  'js/core.js',
  'js/profiles.js',
  'js/pwa.js',
  'js/app.js',
];
const SCOPE = self.registration.scope;
const urlOf = p => new URL(p, SCOPE).href;

/* a redirected response cannot be used to answer a navigation: store a clean copy */
async function clean(res) { return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers }); }

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      for (const p of PRECACHE) {
        const res = await fetch(new Request(urlOf(p), { cache: 'reload' }));      // bypass the HTTP cache: always the real current files
        if (!res.ok) throw new Error('Precache failed: ' + p + ' (' + res.status + ')');
        await cache.put(urlOf(p), res.redirected ? await clean(res) : res);
      }
    } catch (err) {
      await caches.delete(CACHE);                                                  // never leave a half-filled cache; the old version keeps working
      throw err;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);   // only our own obsolete caches
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();         // only on the page's explicit request
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;                                                 // never touch anything but plain GETs
  const url = new URL(req.url);
  if (!url.href.startsWith(SCOPE)) return;                                          // other origins / outside the scope: the browser handles it
  event.respondWith(handle(req, url));
});

async function handle(req, url) {
  const cache = await caches.open(CACHE);                                           // this version only, never older caches
  let hit = await cache.match(url.origin + url.pathname);                           // query strings and fragments are ignored
  if (!hit && req.mode === 'navigate') hit = await cache.match(urlOf('./'));        // single-page app: every navigation gets the shell
  if (hit) return hit;
  try { return await fetch(req); }                                                  // not part of the app: plain network, nothing is cached
  catch (e) { return new Response('離線中，這個內容暫時不能使用。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }); }
}
