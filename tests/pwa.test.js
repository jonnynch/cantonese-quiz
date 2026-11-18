/* PWA: manifest, icons, page metadata, service worker (run for real in a sandbox with an in-memory Cache API and a fake network), registration. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), os = require('node:os');
const { computeVersion, currentVersion, precacheList } = require('../scripts/stamp-sw.js');
const P = require('../public/js/profiles.js'), Core = require('../public/js/core.js');
const { S, IMG, newIdb, CH, level } = require('./helpers');

const PUB = path.join(__dirname, '../public');
const read = f => fs.readFileSync(path.join(PUB, f), 'utf8');
const SW_SRC = read('sw.js');
const manifest = JSON.parse(read('manifest.webmanifest'));
const html = read('index.html');

/* ---------------- manifest, icons, metadata ---------------- */
test('manifest: required metadata for installation', () => {
  assert.equal(manifest.name, 'Cantonese Quiz'); assert.equal(manifest.short_name, '中文識字');
  assert.equal(manifest.lang, 'zh-Hant'); assert.equal(manifest.display, 'standalone');
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i); assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
  assert.equal(manifest.start_url, './'); assert.equal(manifest.scope, './');                       // relative: works at the domain root and under a sub-path
  for (const k of ['start_url', 'scope', 'id']) assert.ok(!/^(\/|https?:)/.test(manifest[k]), k + ' must not be absolute');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
});

function pngSize(file) {                                       // real dimensions from the PNG header
  const b = fs.readFileSync(file); assert.deepEqual([...b.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], file + ' is not a PNG');
  return b.readUInt32BE(16) + 'x' + b.readUInt32BE(20);
}
test('manifest: icon files exist, are real PNGs of the declared size, with standard and maskable icons', () => {
  for (const i of manifest.icons) {
    assert.ok(!/^(\/|https?:)/.test(i.src), i.src + ' must be relative'); assert.equal(i.type, 'image/png');
    assert.ok(fs.existsSync(path.join(PUB, i.src)), i.src); assert.equal(pngSize(path.join(PUB, i.src)), i.sizes, i.src);
  }
  const has = (size, purpose) => manifest.icons.some(i => i.sizes === size && i.purpose === purpose);
  assert.ok(has('192x192', 'any') && has('512x512', 'any') && has('512x512', 'maskable'));
  assert.equal(pngSize(path.join(PUB, 'icons/apple-touch-icon.png')), '180x180');
});

test('page: manifest link, theme colour and Apple / mobile web-app metadata (relative paths, Traditional Chinese)', () => {
  assert.match(html, /<html lang="zh-Hant"/);
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, new RegExp('<meta name="theme-color" content="' + manifest.theme_color + '">', 'i'));
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/); assert.match(html, /<meta name="mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="中文識字">/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png">/);
  assert.match(html, /viewport-fit=cover/);
  for (const m of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) assert.ok(!/^(\/|https?:)/.test(m[1]), 'absolute URL in index.html: ' + m[1]);   // no hard-coded deployment path
  assert.ok(!/<script[^>]*>[^<]*beforeinstallprompt/.test(html));                                    // installation never depends on beforeinstallprompt (not available on iPad Safari)
});

test('deployment: Cloudflare static-assets configuration serves public/ (manifest and service worker at the site root)', () => {
  const w = fs.readFileSync(path.join(__dirname, '../wrangler.jsonc'), 'utf8'); assert.match(w, /"directory":\s*"\.\/public"/);
  assert.ok(fs.existsSync(path.join(PUB, 'sw.js')) && fs.existsSync(path.join(PUB, 'manifest.webmanifest')));
  const h = read('_headers'); assert.match(h, /\/sw\.js\s+Cache-Control: no-cache/); assert.match(h, /manifest\+json/);
});

/* ---------------- cache versioning and the list of cached assets ---------------- */
test('cache versioning: VERSION is the hash of the precached files, so it changes exactly when an asset changes', () => {
  assert.equal(currentVersion(), computeVersion(), 'sw.js is stale: run `npm run stamp-sw`');
  assert.match(currentVersion(), /^[0-9a-f]{12}$/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-')); fs.cpSync(PUB, tmp, { recursive: true });
  const v0 = computeVersion(tmp); assert.equal(v0, computeVersion());
  fs.appendFileSync(path.join(tmp, 'js/app.js'), '\n// changed'); const v1 = computeVersion(tmp); assert.notEqual(v1, v0);
  fs.appendFileSync(path.join(tmp, 'index.html'), '\n<!-- changed -->'); assert.notEqual(computeVersion(tmp), v1);
  fs.appendFileSync(path.join(tmp, 'icons/icon-192.png'), 'x'); assert.notEqual(computeVersion(tmp), v1);
  fs.rmSync(tmp, { recursive: true });
});

test('cached assets: every file the app needs is precached, nothing else', () => {
  const list = precacheList(SW_SRC); const files = list.map(p => (p === './' ? 'index.html' : p));
  for (const f of files) assert.ok(fs.existsSync(path.join(PUB, f)), f + ' is listed but missing');
  const all = []; (function walk(d) { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); fs.statSync(f).isDirectory() ? walk(f) : all.push(path.relative(PUB, f).split(path.sep).join('/')); } })(PUB);
  const expected = all.filter(f => f !== 'sw.js' && f !== '_headers').sort();
  assert.deepEqual([...files].sort(), expected, 'a file in public/ is not precached (or a listed file is not in public/)');
  assert.ok(list.includes('./') && list.includes('manifest.webmanifest') && list.includes('js/app.js'));
  for (const m of html.matchAll(/<script src="([^"]+)">/g)) assert.ok(list.includes(m[1]), m[1] + ' is loaded by the page but not precached');
  for (const i of manifest.icons) assert.ok(list.includes(i.src));
});

test('offline: the application code makes no network requests and loads nothing from another site', () => {
  for (const f of ['js/app.js', 'js/core.js', 'js/storage.js', 'js/profiles.js', 'index.html', 'manifest.webmanifest']) {
    const s = read(f); assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(s), f + ' uses the network');
    assert.ok(!/https?:\/\//.test(s), f + ' references an external URL');
  }
});

/* ---------------- service worker sandbox ---------------- */
class FakeCache {
  constructor() { this.m = new Map(); }
  async put(k, res) { this.m.set(typeof k === 'string' ? k : k.url, { body: await res.arrayBuffer(), status: res.status, headers: [...res.headers] }); }
  async match(k) { const e = this.m.get(typeof k === 'string' ? k : k.url); return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined; }
  keys() { return [...this.m.keys()]; }
}
class FakeCaches {
  constructor() { this.s = new Map(); }
  async open(n) { if (!this.s.has(n)) this.s.set(n, new FakeCache()); return this.s.get(n); }
  async keys() { return [...this.s.keys()]; }
  async delete(n) { return this.s.delete(n); }
}
const TYPES = { html: 'text/html', js: 'text/javascript', webmanifest: 'application/manifest+json', png: 'image/png' };
function loadSw({ scope = 'https://quiz.example.test/', dir = PUB, src = SW_SRC } = {}) {
  const h = { listeners: {}, caches: new FakeCaches(), fetched: [], online: true, down: new Set(), skipped: 0, claimed: 0, scope, dir };
  h.fetch = async input => {
    const url = typeof input === 'string' ? input : input.url; h.fetched.push(url);
    if (!h.online || h.down.has(url)) throw new TypeError('Failed to fetch');
    if (!url.startsWith(scope)) return new Response('other site', { status: 200 });
    const rel = url.slice(scope.length).split('?')[0] || 'index.html'; const f = path.join(h.dir, rel);
    if (!fs.existsSync(f)) return new Response('not found', { status: 404 });
    return new Response(fs.readFileSync(f), { status: 200, headers: { 'Content-Type': TYPES[rel.split('.').pop()] || 'application/octet-stream' } });
  };
  const ctx = { caches: h.caches, fetch: h.fetch, Request, Response, URL, console };
  ctx.self = { registration: { scope }, addEventListener: (t, f) => { h.listeners[t] = f; }, clients: { claim: async () => { h.claimed++; } }, skipWaiting: () => { h.skipped++; } };
  vm.runInNewContext(src, ctx); h.ctx = ctx; return h;
}
const ev = (extra) => Object.assign({ waits: [], waitUntil(p) { this.waits.push(p); } }, extra);
const install = async h => { const e = ev(); h.listeners.install(e); await Promise.all(e.waits); };
const activate = async h => { const e = ev(); h.listeners.activate(e); await Promise.all(e.waits); };
async function request(h, url, { mode = 'same-origin', method = 'GET' } = {}) {
  const e = ev({ request: { url, method, mode }, respondWith(p) { this.p = p; } }); h.listeners.fetch(e); return e.p ? e.p : undefined;
}
const CACHE = 'cq-shell-' + currentVersion();

test('service worker: install fills one versioned cache with exactly the precache list, and does not skip waiting by itself', async () => {
  const h = loadSw(); await install(h);
  assert.deepEqual(await h.caches.keys(), [CACHE]);
  const cache = await h.caches.open(CACHE);
  assert.deepEqual(cache.keys().sort(), precacheList(SW_SRC).map(p => new URL(p, h.scope).href).sort());
  assert.equal(h.skipped, 0); await activate(h); assert.equal(h.skipped, 0);                 // never activates early on its own
  for (const u of h.fetched) assert.ok(u.startsWith(h.scope));                                 // only its own files were requested
  assert.equal(CACHE, 'cq-shell-' + computeVersion());
});

test('service worker: activation removes obsolete shell caches only, and claims clients', async () => {
  const h = loadSw(); for (const n of ['cq-shell-old1', 'cq-shell-old2', 'unrelated-cache', 'workbox-precache-v2']) await h.caches.open(n);
  await install(h); await activate(h);
  assert.deepEqual((await h.caches.keys()).sort(), [CACHE, 'unrelated-cache', 'workbox-precache-v2'].sort());
  assert.equal(h.claimed, 1);
});

test('service worker: SKIP_WAITING is honoured only when the page asks for it', () => {
  const h = loadSw(); h.listeners.message({ data: { type: 'SOMETHING_ELSE' } }); h.listeners.message({ data: null }); assert.equal(h.skipped, 0);
  h.listeners.message({ data: { type: 'SKIP_WAITING' } }); assert.equal(h.skipped, 1);
});

test('offline: the app shell loads, navigation works and all static assets are served from the cache', async () => {
  const h = loadSw(); await install(h); await activate(h); h.online = false;                 // network gone
  const root = await request(h, h.scope, { mode: 'navigate' }); assert.equal(root.status, 200);
  assert.equal(await root.text(), read('index.html')); assert.match(root.headers.get('content-type'), /text\/html/);
  for (const u of [h.scope + '?utm=1', h.scope + 'index.html', h.scope + 'any/other/page', h.scope + '#x']) {                       // query strings, /index.html and unknown paths -> the shell
    const r = await request(h, u, { mode: 'navigate' }); assert.equal(r.status, 200, u); assert.equal(await r.text(), read('index.html'));
  }
  for (const p of precacheList(SW_SRC).filter(p => p !== './')) {
    const r = await request(h, h.scope + p); assert.equal(r.status, 200, p);
    assert.equal(Buffer.compare(Buffer.from(await r.arrayBuffer()), fs.readFileSync(path.join(PUB, p))), 0, p + ' content');
  }
  assert.match((await request(h, h.scope + 'js/app.js')).headers.get('content-type'), /javascript/);
  assert.match((await request(h, h.scope + 'icons/icon-192.png')).headers.get('content-type'), /png/);
  assert.equal(h.fetched.filter(u => u.startsWith(h.scope)).length, precacheList(SW_SRC).length, 'no network request while offline');
});

test('service worker: failed network requests are handled gracefully and nothing extra is cached', async () => {
  const h = loadSw(); await install(h); const cache = await h.caches.open(CACHE); const before = cache.keys().length;
  h.online = false;
  const r = await request(h, h.scope + 'something-not-cached.json'); assert.equal(r.status, 503);                         // an answer, not an exception
  assert.match(r.headers.get('cache-control'), /no-store/); assert.match(await r.text(), /離線/);
  h.online = true; const ok = await request(h, h.scope + 'js/not-in-the-list.js'); assert.equal(ok.status, 404);          // plain network pass-through
  assert.equal(cache.keys().length, before, 'runtime responses must never be cached');
  assert.equal((await h.caches.keys()).length, 1);
});

test('service worker: other origins, non-GET requests and requests outside the scope are never intercepted', async () => {
  const h = loadSw(); await install(h);
  assert.equal(await request(h, 'https://other.example.org/api/x'), undefined);
  assert.equal(await request(h, 'https://api.anthropic.com/v1/messages', { method: 'POST' }), undefined);
  assert.equal(await request(h, h.scope + 'js/app.js', { method: 'POST' }), undefined);
  assert.equal(await request(h, h.scope + 'js/app.js', { method: 'PUT' }), undefined);
  const sub = loadSw({ scope: 'https://quiz.example.test/app/' }); await install(sub);
  assert.equal(await request(sub, 'https://quiz.example.test/other/page.html'), undefined);                                 // sibling path outside the scope
});

test('service worker: a failed install leaves no partial cache and keeps the previous version working', async () => {
  for (const failure of ['offline', 'missing-file', 'server-error']) {
    const h = loadSw(); const old = await h.caches.open('cq-shell-previous'); await old.put(h.scope, new Response('old shell'));
    if (failure === 'offline') h.online = false;
    if (failure === 'missing-file') h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-empty-'));
    if (failure === 'server-error') h.fetch = async () => new Response('boom', { status: 500 }), h.ctx.fetch = h.fetch;
    await assert.rejects(install(h), /./, failure);
    assert.deepEqual(await h.caches.keys(), ['cq-shell-previous'], failure + ': no half-filled cache');
    assert.equal(await (await (await h.caches.open('cq-shell-previous')).match(h.scope)).text(), 'old shell');
  }
});

test('service worker: a redirected response is stored as a clean copy (usable for navigations)', async () => {
  const h = loadSw(); const real = h.fetch;
  h.ctx.fetch = async input => { const r = await real(input); if ((input.url || input) === h.scope) { Object.defineProperty(r, 'redirected', { value: true }); } return r; };
  await install(h); const r = await request(h, h.scope, { mode: 'navigate' }); assert.equal(r.redirected, false); assert.equal(await r.text(), read('index.html'));
});

test('service worker: works under a sub-path deployment (relative scope, no hard-coded paths)', async () => {
  const scope = 'https://example.github.io/cantonese-quiz/'; const h = loadSw({ scope }); await install(h); await activate(h); h.online = false;
  assert.equal(await (await request(h, scope, { mode: 'navigate' })).text(), read('index.html'));
  assert.equal((await request(h, scope + 'js/app.js')).status, 200); assert.equal((await request(h, scope + 'manifest.webmanifest')).status, 200);
  assert.ok(!/['"]\/[a-z]/i.test(SW_SRC.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/'\.\/'/g, '')), 'sw.js must not contain absolute paths');
});

/* ---------------- updates never touch learner data ---------------- */
test('service worker code never touches IndexedDB, localStorage or any learner data', () => {
  const code = SW_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/indexedDB|IDB|localStorage|sessionStorage|deleteDatabase|openDatabase/i.test(code));
  assert.deepEqual([...code.matchAll(/caches\.(\w+)/g)].map(m => m[1]).sort(), ['delete', 'delete', 'keys', 'open', 'open']);   // only open / keys / delete on its own caches
  assert.equal([...code.matchAll(/skipWaiting\(\)/g)].length, 1);                                                                 // only in the message handler
});

async function learnerWithEverything(idb) {
  const m = new P.ProfileManager(idb); await m.init(); const p = await m.create({ name: '小明', avatar: 'cat' });
  const st = await m.openStore(p.id); const q = new Core.Quiz(st, { draftDelay: 5 }); await q.init();
  await q.mutateLevels(ls => ls.push(level('L1', '甲組', ['日', '月', '火', '水'].map((c, i) => CH('c' + i, c)))));
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); for (let i = 0; i < 4; i++) await q.answerWrite(IMG + 'w' + i);
  for (let i = 0; i < 4; i++) await q.setOk(i, i !== 1); await q.finishMarking();                                                 // finished record with one wrong character -> correction activity
  const corr = q.corrections[0]; for (const k of [0, 1, 2]) await q.saveAttempt(corr.id, 0, k, IMG + 'c' + k);                  // correction half done
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); await q.answerWrite(IMG + 'u0');   // unfinished session...
  q.scheduleDraft(() => IMG + 'DRAFT', { immediate: true }); await q.flushDraft();                                                // ...with an unsaved-looking drawing
  m.closeAll(); return p;
}
const snapshot = async (idb, p) => { const m = new P.ProfileManager(idb); await m.init(); const st = await m.openStore(p.id); const d = JSON.stringify([await st.exportAll(), await st.loadAll(), await st.getDraft()]); m.closeAll(); return d; };

test('updates: installing and activating a new version keeps IndexedDB intact (profiles, records, session, draft, corrections and their handwriting)', async () => {
  const idb = newIdb(); const p = await learnerWithEverything(idb); const before = await snapshot(idb, p);
  const dbsBefore = (await idb.databases()).map(d => d.name).sort();
  const h = loadSw(); await (await h.caches.open('cq-shell-previous-version')).put(h.scope, new Response('old'));
  await install(h); await activate(h);                                                                                            // the update, end to end
  assert.deepEqual((await h.caches.keys()), [CACHE]);
  assert.equal(await snapshot(idb, p), before);                                                                                    // not a single byte changed
  assert.deepEqual((await idb.databases()).map(d => d.name).sort(), dbsBefore);
  const m = new P.ProfileManager(idb); await m.init(); assert.deepEqual((await m.list()).map(x => x.id), [p.id]);
  const q = new Core.Quiz(await m.openStore(p.id)); await q.init();
  assert.equal(q.cur.i, 1); assert.equal((await q.loadDraft()).data, IMG + 'DRAFT');                                               // unfinished session + drawing resume
  const c = q.openCorrections()[0]; assert.equal(c.items[0].attempts.filter(Boolean).length, 3);                                    // correction progress
  assert.equal((await q.store.getImage(c.items[0].attempts[2])).data, IMG + 'c2'); assert.equal(q.records.length, 1);
});

/* ---------------- registration ---------------- */
function loadPwa(env) {
  const ctx = { ...env }; ctx.globalThis = ctx; vm.runInNewContext(fs.readFileSync(path.join(PUB, 'js/pwa.js'), 'utf8'), ctx); return ctx.CQPwa;
}
function swEnv({ controller = {}, waiting = null, registerFails = false } = {}) {
  const e = { calls: [], reloads: 0, handlers: {}, regHandlers: {}, updates: 0, posted: [] };
  const reg = { waiting, installing: null, addEventListener: (t, f) => { e.regHandlers[t] = f; }, update: async () => { e.updates++; } };
  e.reg = reg;
  e.navigator = { serviceWorker: { controller, register: async (...a) => { e.calls.push(a); if (registerFails) throw new Error('nope'); return reg; }, addEventListener: (t, f) => { e.handlers[t] = f; } } };
  e.document = { visibilityState: 'visible', addEventListener: (t, f) => { e.handlers['doc:' + t] = f; } };
  e.location = { reload: () => { e.reloads++; } }; return e;
}

test('registration: registers ./sw.js with a relative scope; unsupported browsers and failures are harmless', async () => {
  const e = swEnv(); const pwa = loadPwa(e); assert.equal(await pwa.register(), e.reg);
  assert.deepEqual(JSON.parse(JSON.stringify(e.calls)), [['sw.js', { scope: './' }]]);                                          // relative to the page: correct under any deployment path
  assert.equal(await loadPwa({ navigator: {}, document: undefined }).register(), null);              // no serviceWorker support (e.g. file://)
  assert.equal(await loadPwa({}).register(), null);
  assert.equal(await loadPwa(swEnv({ registerFails: true })).register(), null);
});

test('registration: update notifications only for real updates, and a reload only after the learner applied the update', async () => {
  let notified = 0; const worker = { posted: [], postMessage(m) { this.posted.push(m); } };
  let e = swEnv({ waiting: worker }); let pwa = loadPwa(e); await pwa.register({ onUpdate: () => { notified++; } });
  assert.equal(notified, 1); assert.equal(pwa.hasUpdate(), true);
  e.handlers.controllerchange(); assert.equal(e.reloads, 0, 'no reload unless the update was applied');
  assert.equal(pwa.applyUpdate(), true); assert.deepEqual(JSON.parse(JSON.stringify(worker.posted)), [{ type: 'SKIP_WAITING' }]); assert.equal(e.reloads, 0);
  e.handlers.controllerchange(); e.handlers.controllerchange(); assert.equal(e.reloads, 1, 'exactly one reload');
  // first ever install (no controller yet): nothing to announce
  notified = 0; e = swEnv({ controller: null, waiting: worker }); pwa = loadPwa(e); await pwa.register({ onUpdate: () => { notified++; } }); assert.equal(notified, 0);
  // an update found later
  e = swEnv(); pwa = loadPwa(e); await pwa.register({ onUpdate: () => { notified++; } });
  const installing = { state: 'installing', addEventListener: (t, f) => { installing.fire = f; }, postMessage() { } };
  e.reg.installing = installing; e.regHandlers.updatefound(); installing.state = 'installed'; e.reg.waiting = installing; installing.fire(); assert.equal(notified, 1);
  assert.equal(loadPwa(swEnv()).applyUpdate(), false);                                              // nothing waiting
  e.document.visibilityState = 'visible'; e.handlers['doc:visibilitychange'](); assert.equal(e.updates, 1);     // looks for updates when the app is reopened/focused
});
