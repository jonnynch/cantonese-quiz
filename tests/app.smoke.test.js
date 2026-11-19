/* End-to-end smoke test of the real page (public/index.html + js/*) in jsdom with a fake IndexedDB. */
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { newIdb, legacyBlob } = require('./helpers');
const { S } = require('./helpers');

const fs = require('node:fs');
const PUB = path.join(__dirname, '../public');
function pageHtml() {   // inline the local scripts so the page can run on an http origin (localStorage needs a non-opaque origin)
  return fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/<script src="([^"]+)"><\/script>/g, (_, f) => '<script>' + fs.readFileSync(path.join(PUB, f), 'utf8') + '</script>');
}
/* active: id kept in sessionStorage, i.e. a page REFRESH of a tab where this learner was already selected */
async function openPage(idb, legacy, canvas, active) {
  const dom = new JSDOM(pageHtml(), {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.indexedDB = idb; if (active) w.sessionStorage.setItem('cq-active-profile', active); w.confirm = () => true; w.alert = () => { }; if (canvas) canvas(w); if (legacy) w.localStorage.setItem(S.LEGACY_KEY, legacy); },
  });
  await dom.window.__cqReady; await new Promise(r => setTimeout(r, 30));   // the picker list renders asynchronously
  return dom;
}
const pick = async dom => { await dom.window.eval("selectProfile('p-legacy')"); await tick(); };   // choose the default learner on the picker
const text = dom => dom.window.document.querySelector('#main').textContent;
const tick = () => new Promise(r => setTimeout(r, 20));

test('page boots, migrates legacy data, and an unfinished session survives a page reload', async () => {
  const idb = newIdb();
  let dom = await openPage(idb, legacyBlob());
  await pick(dom);
  // legacy session (write, question 2 of 2) was migrated and the user is taken to the practice tab with resume/discard
  assert.match(text(dom), /有未完成的聽音寫字/); assert.match(text(dom), /第 2 \/ 2 題/);
  assert.equal(dom.window.localStorage.getItem(S.LEGACY_KEY), null);
  dom.window.eval('discard()'); await tick();                          // confirm() stubbed to true
  assert.doesNotMatch(text(dom), /有未完成/);
  dom.window.eval("start('read','L1','practice')"); await tick();
  dom.window.eval('mark(true)'); await tick();
  assert.match(text(dom), /2 \/ 2/);
  dom.window.close();

  dom = await openPage(idb, undefined, undefined, 'p-legacy');         // simulated browser refresh
  assert.match(text(dom), /有未完成的讀字練習/); assert.match(text(dom), /第 2 \/ 2 題/);
  assert.equal(dom.window.eval('tab'), 'practice');
  dom.window.eval('resume()'); await tick();
  assert.match(text(dom), /2 \/ 2/);                                   // continues at the second question
  dom.window.eval('leave()'); await tick();
  assert.match(text(dom), /有未完成的讀字練習/);                        // leaving did not delete it
  dom.window.close();
});

test('page shows a clear error when IndexedDB is unavailable', async () => {
  const dom = await openPage(undefined);
  assert.match(text(dom), /無法使用儲存空間/);
  dom.window.close();
});

test('page: a failed save shows an error banner, stays on the question, and retry then advances', async () => {
  const idb = newIdb();
  const dom = await openPage(idb, legacyBlob());
  await pick(dom);
  dom.window.eval('discard()'); await tick();
  dom.window.eval("start('read','L1','practice')"); await tick();
  dom.window.eval('Q.store = { ...Q.store, saveSession: () => Promise.reject(Object.assign(new Error("x"), { code: "quota" })) }'); // simulate full storage
  dom.window.eval('mark(true)'); await tick();
  const bar = dom.window.document.querySelector('#errbar');
  assert.ok(bar && !bar.hidden); assert.match(bar.textContent, /沒有儲存成功/); assert.match(bar.textContent, /儲存空間不足/);
  assert.match(text(dom), /1 \/ 2/);                                   // still on question 1
  dom.window.eval('Q.store = store'); dom.window.eval('retrySave()'); await tick();
  assert.match(text(dom), /2 \/ 2/); assert.ok(dom.window.document.querySelector('#errbar').hidden);
  dom.window.close();
});

/* jsdom has no canvas: provide a recording stub so the real autosave/restore wiring in app.js runs */
function canvasStub(log) {
  return w => {
    const ctx = { fillRect() { }, beginPath() { }, moveTo() { }, lineTo() { }, stroke() { }, drawImage(img) { log.push('draw:' + img.src); } };
    w.HTMLCanvasElement.prototype.getContext = () => ctx;
    w.HTMLCanvasElement.prototype.setPointerCapture = () => { };
    w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,STROKES' + log.filter(x => x === 'ink').length;
    w.Image = class { set src(v) { this._s = v; setTimeout(() => this.onload && this.onload(), 0); } get src() { return this._s; } };
  };
}
const ptr = { preventDefault() { }, pointerId: 1, clientX: 5, clientY: 5 };

test('page: strokes are autosaved, survive a reload, and are restored only on the same question', async () => {
  const idb = newIdb(), log = [];
  let dom = await openPage(idb, legacyBlob(), canvasStub(log));
  await pick(dom);
  dom.window.eval('discard()'); await tick();
  dom.window.eval("start('write','L1','practice')"); await tick();
  const cv = dom.window.document.querySelector('#cv'); assert.ok(cv);
  cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 640 });
  cv.onpointerdown(ptr); log.push('ink'); cv.onpointerup();                     // one stroke
  await new Promise(r => setTimeout(r, 600));                                    // debounce (400ms) + write
  const d = await dom.window.eval('store.getDraft()');
  assert.equal(d.data, 'data:image/jpeg;base64,STROKES1'); assert.equal(d.qi, 0);
  dom.window.close();

  log.length = 0;
  dom = await openPage(idb, undefined, canvasStub(log), 'p-legacy');                         // refresh
  dom.window.eval('resume()'); await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(log.filter(x => x.startsWith('draw')), ['draw:data:image/jpeg;base64,STROKES1']);
  assert.equal(dom.window.eval('dirty'), true);
  dom.window.eval('clr()'); await tick(); await tick();                          // clearing persists an empty drawing
  assert.equal((await dom.window.eval('store.getDraft()')).data, null);
  dom.window.close();

  log.length = 0;
  dom = await openPage(idb, undefined, canvasStub(log), 'p-legacy');
  dom.window.eval('resume()'); await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(log.filter(x => x.startsWith('draw')), [], 'cleared strokes must not reappear');
  dom.window.close();
});

test('page: a failing autosave shows a warning, keeps the drawing and blocks completion until retried', async () => {
  const idb = newIdb(), log = [];
  const dom = await openPage(idb, legacyBlob(), canvasStub(log));
  await pick(dom);
  dom.window.eval('discard()'); await tick();
  dom.window.eval("start('write','L1','practice')"); await tick();
  const cv = dom.window.document.querySelector('#cv');
  cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 640 });
  dom.window.eval('Q.store = { ...Q.store, saveDraft: () => Promise.reject(Object.assign(new Error("x"), { code: "quota" })) }');
  cv.onpointerdown(ptr); log.push('ink'); cv.onpointerup();
  await new Promise(r => setTimeout(r, 600));
  const bar = dom.window.document.querySelector('#errbar');
  assert.ok(bar && !bar.hidden); assert.match(bar.textContent, /筆跡未能自動儲存/); assert.match(bar.textContent, /不能完成/);
  assert.equal(dom.window.eval('dirty'), true);                                  // drawing still there
  dom.window.eval('done()'); await tick(); await tick();
  assert.match(text(dom), /1 \/ 2/);                                            // not advanced
  dom.window.eval('Q.store = store; retryDraft()'); await tick(); await tick();
  assert.ok(dom.window.document.querySelector('#errbar').hidden);
  dom.window.eval('done()'); await tick(); await tick();
  assert.match(text(dom), /2 \/ 2/);
  dom.window.close();
});

/* ---------------- learner profiles in the real page ---------------- */
const P = require('../public/js/profiles.js'), Core = require('../public/js/core.js');
const { CH, level } = require('./helpers');
async function seedLearners(idb) {
  const m = new P.ProfileManager(idb); await m.init(); const out = {};
  for (const [name, avatar, lv, chars] of [['小明', 'cat', '甲組', ['日', '月']], ['小美', 'rabbit', '乙組', ['水', '火', '木']]]) {
    const p = await m.create({ name, avatar }); const q = new Core.Quiz(await m.openStore(p.id)); await q.init();
    await q.mutateLevels(ls => ls.push(level('L-' + p.id, lv, chars.map((c, i) => CH('c' + i, c))))); out[name] = p;
  }
  m.closeAll(); return out;
}
const nav = dom => dom.window.document.querySelector('#nav').textContent;
const main = dom => dom.window.document.querySelector('#main').textContent;

test('page: opens on the learner picker, enters no learning screen until one is chosen, and switching leaks nothing', async () => {
  const idb = newIdb(), L = await seedLearners(idb);
  const dom = await openPage(idb);
  assert.match(main(dom), /選擇學習者/); assert.match(main(dom), /小明/); assert.match(main(dom), /小美/); assert.match(main(dom), /新增學習者/);
  assert.doesNotMatch(main(dom), /甲組|乙組/); assert.equal(nav(dom), '');                      // no learning screens, no tabs
  await dom.window.eval(`selectProfile('${L['小明'].id}')`); await tick();
  assert.match(nav(dom), /小明/); assert.match(nav(dom), /切換學習者/); assert.match(main(dom), /甲組/); assert.match(main(dom), /乙組/);   // the levels are shared: every learner sees all of them
  dom.window.eval("start('read','L-" + L['小明'].id + "','practice')"); await tick();         // A has an unfinished session...
  dom.window.eval('mark(true)'); await tick(); assert.match(main(dom), /2 \/ 2/);
  const qA = dom.window.eval('Q'); await dom.window.eval('switchLearner()'); await tick();
  assert.match(main(dom), /選擇學習者/); assert.doesNotMatch(main(dom), /甲組|2 \/ 2/);        // ...nothing of it stays on screen
  assert.ok(!dom.window.eval('Q')); assert.equal(qA.closed, true);
  await dom.window.eval(`selectProfile('${L['小美'].id}')`); await tick();
  assert.match(nav(dom), /小美/); assert.doesNotMatch(nav(dom), /小明/); assert.match(main(dom), /乙組/); assert.match(main(dom), /甲組/);
  dom.window.eval("go('practice')"); await tick(); assert.doesNotMatch(main(dom), /有未完成/); // A's unfinished session is not visible to B
  assert.equal(dom.window.eval('Q.cur'), null); assert.equal(dom.window.eval('Q.levels.length'), 2);   // shared content (each learner's own progress is separate)
  dom.window.eval("go('hist')"); await tick(); assert.doesNotMatch(main(dom), /2 \/ 2|小明/);   // nothing of the other learner's progress
  dom.window.close();
  // A's session is still there for A
  const dom2 = await openPage(idb, undefined, undefined, L['小明'].id);                        // refresh in the tab where 小明 was active
  assert.match(nav(dom2), /小明/); assert.match(main(dom2), /有未完成的讀字練習/); assert.match(main(dom2), /第 2 \/ 2 題/);
  dom2.window.close();
});

test('page: after a refresh the chosen learner is kept; a fresh start asks again; archived learners are not offered', async () => {
  const idb = newIdb(), L = await seedLearners(idb);
  let dom = await openPage(idb, undefined, undefined, L['小美'].id);
  assert.match(nav(dom), /小美/); assert.match(main(dom), /乙組/); dom.window.close();
  dom = await openPage(idb); assert.match(main(dom), /選擇學習者/); assert.ok(!dom.window.eval('Q'));
  dom.window.eval(`archiveProfile('${L['小美'].id}')`); await tick(); await tick();
  dom.window.eval("pview='pick';render()"); await tick();
  assert.match(main(dom), /小明/); assert.doesNotMatch(main(dom), /小美/);
  dom.window.close();
  dom = await openPage(idb, undefined, undefined, L['小美'].id);                                 // stale remembered id of an archived learner
  assert.match(main(dom), /選擇學習者/); assert.ok(!dom.window.eval('Q')); dom.window.close();
});

test('page: parents can create, edit, archive, restore and delete learners from the management screen', async () => {
  const idb = newIdb(), L = await seedLearners(idb); const dom = await openPage(idb);
  dom.window.eval("pview='manage';render()"); await tick();
  assert.match(main(dom), /管理學習者/); for (const t of ['編輯資料', '封存學習者', '刪除學習者']) assert.match(main(dom), new RegExp(t));
  dom.window.eval("profileForm()"); await tick();
  const form = dom.window.document.querySelector('.modal form'); form.querySelector('[name=name]').value = '小強';
  form.querySelectorAll('.avs .av')[3].click(); form.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await tick(); await tick();
  const created = (await new P.ProfileManager(idb).init().then(m => m.list())).find(p => p.name === '小強'); assert.equal(created.avatar, 'panda');
  dom.window.eval(`archiveProfile('${created.id}')`); await tick(); await tick(); assert.match(main(dom), /已封存/); assert.match(main(dom), /還原學習者/);
  dom.window.eval(`restoreProfile('${created.id}')`); await tick(); await tick(); assert.doesNotMatch(main(dom), /已封存/);
  let asked = ''; dom.window.confirm = m => { asked = m; return false; };
  dom.window.eval(`deleteProfile('${created.id}')`); await tick(); await tick(); assert.match(asked, /永久刪除「小強」/); assert.match(main(dom), /小強/);   // cancelled
  dom.window.confirm = () => true; dom.window.eval(`deleteProfile('${created.id}')`); await tick(); await tick(); await tick();
  assert.doesNotMatch(main(dom), /小強/); assert.match(main(dom), /小明/); assert.match(main(dom), /小美/);
  dom.window.close();
});

test('page: existing pre-profile data appears as the default learner and keeps its unfinished session', async () => {
  const idb = newIdb(); const dom = await openPage(idb, legacyBlob());
  assert.match(main(dom), /選擇學習者/); assert.match(main(dom), /學習者/);
  assert.equal(dom.window.localStorage.getItem(S.LEGACY_KEY), null);
  await pick(dom); assert.match(main(dom), /有未完成的聽音寫字/); assert.match(nav(dom), /學習者/);
  dom.window.close();
});
