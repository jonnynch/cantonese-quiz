/* The real page under jsdom with a mocked navigator.serviceWorker: the safe-update flow, and a full offline run (no network at all). */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const P = require('../public/js/profiles.js'), Core = require('../public/js/core.js');
const { S, IMG, newIdb, CH, level } = require('./helpers');

const PUB = path.join(__dirname, '../public');
const pageHtml = () => fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/<script src="([^"]+)"><\/script>/g, (_, f) => '<script>' + fs.readFileSync(path.join(PUB, f), 'utf8') + '</script>');
const wait = ms => new Promise(r => setTimeout(r, ms)), tick = () => wait(25);
const ev = (dom, code) => dom.window.eval(code);
const main = dom => dom.window.document.querySelector('#main').textContent;
const ptr = { preventDefault() { }, pointerId: 1, clientX: 5, clientY: 5 };
const stroke = el => { el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 360 }); el.onpointerdown(ptr); el.onpointerup(); };

function swMock({ waiting = true, controller = true } = {}) {
  const m = { posted: [], handlers: {}, registered: [] };
  m.worker = { postMessage(x) { m.posted.push(x); } };
  m.reg = { waiting: waiting ? m.worker : null, installing: null, addEventListener() { }, update: async () => { } };
  m.sw = { controller: controller ? {} : null, register: async (...a) => { m.registered.push(a); return m.reg; }, addEventListener: (t, f) => { m.handlers[t] = f; } };
  return m;
}
async function openPage(idb, { active, sw, net } = {}) {
  const dom = new JSDOM(pageHtml(), { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    w.indexedDB = idb; w.confirm = () => true; w.alert = () => { };
    const ctx = { fillRect() { }, beginPath() { }, moveTo() { }, lineTo() { }, stroke() { }, drawImage(i) { (w.__drawn = w.__drawn || []).push(i.src); } };
    const C = w.HTMLCanvasElement.prototype; C.getContext = () => ctx; C.setPointerCapture = () => { }; let n = 0; C.toDataURL = () => 'data:image/jpeg;base64,INK' + (++n);
    w.Image = class { set src(v) { this._s = v; setTimeout(() => this.onload && this.onload(), 0); } get src() { return this._s; } };
    if (active) w.sessionStorage.setItem('cq-active-profile', active);
    if (sw) Object.defineProperty(w.navigator, 'serviceWorker', { value: sw.sw, configurable: true });
    if (net) { Object.defineProperty(w.navigator, 'onLine', { value: false, configurable: true });       // offline: any network use is recorded and fails
      w.fetch = (...a) => { net.calls.push(['fetch', String(a[0])]); return Promise.reject(new TypeError('offline')); };
      w.XMLHttpRequest = class { open(m, u) { net.calls.push(['xhr', u]); throw new Error('offline'); } };
      w.WebSocket = class { constructor(u) { net.calls.push(['ws', u]); throw new Error('offline'); } }; w.navigator.sendBeacon = u => { net.calls.push(['beacon', u]); return false; }; }
  } });
  await dom.window.__cqReady; await wait(30);
  if (sw) { dom.window.CQPwa.reload = () => { sw.reloads = (sw.reloads || 0) + 1; }; }
  return dom;
}
async function seedLearner(idb, { corrections = false } = {}) {
  const m = new P.ProfileManager(idb); await m.init(); const p = await m.create({ name: '小明', avatar: 'cat' });
  const q = new Core.Quiz(await m.openStore(p.id), { draftDelay: 5 }); await q.init();
  await q.mutateLevels(ls => ls.push(level('L1', '甲組', ['日', '月', '火', '水', '木'].map((c, i) => CH('c' + i, c)))));
  if (corrections) {
    await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); for (let i = 0; i < 5; i++) await q.answerWrite(IMG + 'w' + i);
    for (let i = 0; i < 5; i++) await q.setOk(i, i > 1); await q.finishMarking();
    const c = q.corrections[0]; await q.saveAttempt(c.id, 0, 0, IMG + 'a0'); await q.saveAttempt(c.id, 0, 3, IMG + 'a3');
  }
  m.closeAll(); return p.id;
}
const bar = dom => dom.window.document.querySelector('#updbar');

test('update: the banner appears only when a new version is waiting, never on the first install', async () => {
  const idb = newIdb(), id = await seedLearner(idb);
  let sw = swMock({ waiting: false }); let dom = await openPage(idb, { active: id, sw }); assert.equal(bar(dom), null);
  assert.deepEqual(JSON.parse(JSON.stringify(sw.registered)), [['sw.js', { scope: './' }]]); dom.window.close();
  sw = swMock({ waiting: true, controller: false }); dom = await openPage(idb, { active: id, sw }); assert.equal(bar(dom), null); dom.window.close();   // first install
  sw = swMock({ waiting: true }); dom = await openPage(idb, { active: id, sw });
  assert.ok(bar(dom) && !bar(dom).hidden); assert.match(bar(dom).textContent, /有新版本可以使用/); assert.match(bar(dom).textContent, /立即更新/);
  ev(dom, 'hideUpdate()'); assert.ok(bar(dom).hidden); assert.deepEqual(sw.posted, []); assert.equal(sw.reloads || 0, 0);                         // "later" does nothing
  dom.window.close();
});

test('update: refused while a question, marking or a correction is in progress; nothing is reloaded or lost', async () => {
  const idb = newIdb(), id = await seedLearner(idb, { corrections: true }); const sw = swMock(); const dom = await openPage(idb, { active: id, sw });
  ev(dom, "start('write','L1','practice')"); await tick();                                                   // writing a question
  const cv = dom.window.document.querySelector('#cv'); stroke(cv);                                              // unsaved drawing
  await ev(dom, 'applyUpdate()'); assert.deepEqual(sw.posted, []); assert.equal(sw.reloads || 0, 0); assert.equal(ev(dom, 'dirty'), true);
  assert.match(dom.window.document.querySelector('#toast').textContent, /先完成或離開/);
  for (let i = 0; i < 5; i++) { if (i) stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await tick(); await tick(); }
  assert.equal(ev(dom, "Q.cur.phase"), 'mark'); await ev(dom, 'applyUpdate()'); assert.deepEqual(sw.posted, []);   // marking
  ev(dom, 'leave()'); await tick(); ev(dom, "discard()"); await tick();
  const cid = ev(dom, 'Q.openCorrections()[0].id'); ev(dom, `openCorrection('${cid}')`); await tick();           // correction screen
  await ev(dom, 'applyUpdate()'); assert.deepEqual(sw.posted, []);
  stroke(dom.window.document.querySelector('#cc1'));                                                            // an autosave still pending
  await ev(dom, 'applyUpdate()'); assert.deepEqual(sw.posted, []); assert.equal(sw.reloads || 0, 0);
  dom.window.close();
});

test('update: applied only at a safe moment, after everything is saved, with exactly one reload; progress survives', async () => {
  const idb = newIdb(), id = await seedLearner(idb, { corrections: true }); const sw = swMock(); let dom = await openPage(idb, { active: id, sw });
  ev(dom, "start('write','L1','practice')"); await tick(); stroke(dom.window.document.querySelector('#cv')); await wait(550);   // draft autosaved
  ev(dom, 'done()'); await tick(); await tick(); stroke(dom.window.document.querySelector('#cv'));                                 // second question, drawing in progress
  ev(dom, 'leave()'); await tick();                                                                          // leaving saves the drawing first
  assert.equal(ev(dom, 'updateSafe()'), true);
  await ev(dom, 'applyUpdate()'); assert.deepEqual(JSON.parse(JSON.stringify(sw.posted)), [{ type: 'SKIP_WAITING' }]); assert.equal(sw.reloads || 0, 0);
  sw.handlers.controllerchange(); sw.handlers.controllerchange(); assert.equal(sw.reloads, 1);
  dom.window.close();
  dom = await openPage(idb, { active: id, sw: swMock({ waiting: false }) });                                  // "the new version" starts
  assert.equal(ev(dom, 'Q.cur.i'), 1); assert.match(ev(dom, "go('practice'), main2 = document.querySelector('#main').textContent"), /有未完成的聽音寫字/);
  assert.match(main(dom), /有未完成的寫五次練習/); assert.match(main(dom), /2 \/ 5/);                            // correction progress
  ev(dom, 'resume()'); await tick(); await tick(); assert.ok((dom.window.__drawn || []).length >= 1, 'the drawing was restored');
  dom.window.close();
});

test('update: not applied when a save is failing (the learner keeps the unsaved work)', async () => {
  const idb = newIdb(), id = await seedLearner(idb); const sw = swMock(); const dom = await openPage(idb, { active: id, sw });
  ev(dom, "start('write','L1','practice')"); await tick(); stroke(dom.window.document.querySelector('#cv'));
  ev(dom, 'Q.store = { ...Q.store, saveDraft: () => Promise.reject(Object.assign(new Error("x"), { code: "quota" })) }');
  ev(dom, 'leave()'); await tick(); await tick();                                                             // leave asks (confirm=true in this test) -> now on a safe screen
  ev(dom, "resume()"); await tick(); await ev(dom, 'applyUpdate()'); assert.deepEqual(sw.posted, []);
  dom.window.close();
});

test('offline: the whole app works with no network at all (profiles, levels, reading, writing, marking, correction, history, settings)', async () => {
  const idb = newIdb(), id = await seedLearner(idb), net = { calls: [] };
  const dom = await openPage(idb, { net });                                                                   // opened offline: learner picker
  assert.match(main(dom), /選擇學習者/);
  ev(dom, `selectProfile('${id}')`); await tick(); assert.match(main(dom), /甲組/);                            // switch profile, levels, characters
  ev(dom, "lid='L1';render()"); await tick(); assert.match(main(dom), /日/);
  ev(dom, "go('practice')"); await tick();
  ev(dom, "start('read','L1','practice')"); await tick(); for (let i = 0; i < 5; i++) { ev(dom, 'mark(i % 2 === 0)'.replace('i % 2 === 0', i % 2 ? 'false' : 'true')); await tick(); }
  assert.match(main(dom), /用時/);                                                                            // reading practice finished, saved
  ev(dom, 'go("practice")'); await tick();
  ev(dom, "start('write','L1','practice')"); await tick();                                                     // writing practice with handwriting
  for (let i = 0; i < 5; i++) { stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await tick(); await tick(); }
  for (let i = 0; i < 5; i++) { ev(dom, `setOk(${i}, ${i > 1})`); await tick(); }                              // parent marking
  ev(dom, 'finish()'); await tick(); await tick(); assert.match(main(dom), /寫五次練習（2 個字）/);
  ev(dom, `openCorrection('corr-' + res.id)`); await tick();                                                   // correction activity
  for (let k = 0; k < 5; k++) stroke(dom.window.document.querySelector('#cc' + k)); await wait(550); assert.match(dom.window.document.querySelector('#cprog').textContent, /5 \/ 5/);
  ev(dom, 'leaveCorr()'); await tick(); ev(dom, "go('hist')"); await tick(); assert.match(main(dom), /甲組/);
  ev(dom, "go('set')"); await tick(); assert.match(main(dom), /安裝到主畫面/);
  ev(dom, 'switchLearner()'); await tick(); assert.match(main(dom), /選擇學習者/);
  assert.deepEqual(net.calls, [], 'the app must not need the network');
  const m = new P.ProfileManager(idb); await m.init(); const q = new Core.Quiz(await m.openStore(id)); await q.init();    // everything was really stored locally
  assert.equal(q.records.length, 2); assert.equal(q.corrections.length, 1); assert.equal(q.corrections[0].items[0].attempts.filter(Boolean).length, 5);
  dom.window.close();
});

test('offline: speech without a zh-HK voice (or no speech at all) does not break the app', async () => {
  const idb = newIdb(), id = await seedLearner(idb), net = { calls: [] }; const dom = await openPage(idb, { active: id, net });
  dom.window.speechSynthesis = { getVoices: () => [], cancel() { }, speak() { throw new Error('no voice'); } }; dom.window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  ev(dom, "start('write','L1','practice')"); await tick(); ev(dom, "say('c')"); stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await tick(); await tick();
  assert.equal(ev(dom, 'Q.cur.i'), 1); dom.window.close();
});
