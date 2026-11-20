/* The real page under jsdom: several unfinished activities are listed, resumed independently, and survive a page reload. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const P = require('../public/js/profiles.js');
const { newIdb, CH, level } = require('./helpers');

const PUB = path.join(__dirname, '../public');
const pageHtml = () => fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/<script src="([^"]+)"><\/script>/g, (_, f) => '<script>' + fs.readFileSync(path.join(PUB, f), 'utf8') + '</script>');
const tick = () => new Promise(r => setTimeout(r, 60));
const ev = (dom, code) => dom.window.eval(code);
const main = dom => dom.window.document.querySelector('#main').textContent;
async function openPage(idb, active) {
  const dom = new JSDOM(pageHtml(), { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    w.indexedDB = idb; w.confirm = () => true; w.alert = () => { }; if (active) w.sessionStorage.setItem('cq-active-profile', active);
    w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() { }, beginPath() { }, moveTo() { }, lineTo() { }, stroke() { }, drawImage() { }, set lineWidth(v) { }, set lineCap(v) { }, set lineJoin(v) { }, set strokeStyle(v) { }, set fillStyle(v) { } });
    w.HTMLCanvasElement.prototype.setPointerCapture = () => { }; w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,/9j/AAAA';
  } });
  await dom.window.__cqReady; await tick(); return dom;
}
async function seed(idb) {
  const mgr = await new P.ProfileManager(idb).init(), p = await mgr.create({ name: '小明', avatar: 'cat' });
  const st = await mgr.openStore(p.id), Core = require('../public/js/core.js'), q = new Core.Quiz(st); await q.init();
  await q.mutateLevels(ls => ls.push(level('L1', '一級', Array.from({ length: 22 }, (_, i) => CH('c' + i, String.fromCodePoint(0x4e00 + i))))));
  mgr.closeAll(); return p.id;
}


const doc = dom => dom.window.document;
const stroke = dom => { const el = doc(dom).querySelector('#cv'); el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 360 }); const p = { preventDefault() { }, pointerId: 1, clientX: 5, clientY: 5 }; el.onpointerdown(p); el.onpointerup(); };
const prog = dom => doc(dom).querySelector('.mkprog').textContent.trim();
const btn = (dom, cls) => doc(dom).querySelector('.mkrow .b.' + cls);
const marks = dom => JSON.parse(ev(dom, 'JSON.stringify(Q.cur.items.map(x => x.ok))'));
const state = dom => ({ r: btn(dom, 'r').disabled, p: btn(dom, 'p').disabled });
async function answer(dom, mode, n) {                         // answer n writing questions of a session (a real stroke each), leaving it in the marking phase
  ev(dom, `go('${mode === 'exam' ? 'exam' : 'practice'}')`); await tick(); ev(dom, `start('write','L1','${mode}')`); await tick();
  for (let i = 0; i < n; i++) { stroke(dom); ev(dom, 'done()'); await tick(); await tick(); }
}
const click = async (dom, el) => { el.click(); await tick(); await tick(); };            // a real tap on the real button, as a learner does

test('regression: after marking one writing answer the buttons of the NEXT question are enabled (exam, tapped like a learner)', async () => {
  const idb = newIdb(), id = await seed(idb), dom = await openPage(idb, id);
  await answer(dom, 'exam', 20); assert.equal(ev(dom, 'Q.cur.phase'), 'mark'); assert.equal(ev(dom, 'Q.cur.items.length'), 20);
  assert.equal(prog(dom), '1 / 20'); assert.deepEqual(state(dom), { r: false, p: false });
  await click(dom, btn(dom, 'p'));                                                    // 1: correct
  assert.equal(prog(dom), '2 / 20'); assert.deepEqual(state(dom), { r: false, p: false }, 'question 2: both buttons enabled');
  assert.deepEqual(marks(dom).slice(0, 3), [true, null, null]);
  await click(dom, btn(dom, 'r'));                                                    // 2: incorrect
  assert.equal(prog(dom), '3 / 20'); assert.deepEqual(state(dom), { r: false, p: false }, 'question 3: both buttons enabled again');
  assert.deepEqual(marks(dom).slice(0, 4), [true, false, null, null]);                // the first two marks are kept, independently
  for (let k = 3; k <= 20; k++) { assert.equal(prog(dom), k + ' / 20'); assert.deepEqual(state(dom), { r: false, p: false }, 'question ' + k); await click(dom, btn(dom, 'p')); }
  assert.match(doc(dom).querySelector('#main').textContent, /20 \/ 20 題已評分/); assert.equal(ev(dom, 'mkBusy'), false);
  await click(dom, doc(dom).querySelector('.mkone .row:last-child .b.p'));            // 完成評分
  const rec = ev(dom, 'Q.records.at(-1)'); assert.equal(rec.mode, 'exam'); assert.equal(rec.items.length, 20);
  assert.equal(rec.items.filter(x => x.ok).length, 19); assert.equal(rec.items[1].ok, false); assert.equal(rec.items[0].ok, true);     // the score reflects every mark
  assert.match(doc(dom).querySelector('#main').textContent, /寫字考試結果/); assert.equal(ev(dom, 'Q.corrections.length'), 1);
  dom.window.close();
});

test('regression: navigating back and forth between marked and unmarked answers keeps every mark, keeps the buttons usable and updates the result', async () => {
  const idb = newIdb(), id = await seed(idb), dom = await openPage(idb, id);
  await answer(dom, 'exam', 20);
  const next = doc => [...doc.querySelectorAll('.mkone .row:last-child .b')].find(b => b.textContent.trim() === '下一題');
  const prev = doc => [...doc.querySelectorAll('.mkone .row:last-child .b')].find(b => b.textContent.trim() === '上一題');
  await click(dom, btn(dom, 'p')); await click(dom, btn(dom, 'r')); await click(dom, btn(dom, 'p'));            // 1 ✓  2 ✗  3 ✓  → on 4
  assert.equal(prog(dom), '4 / 20'); assert.deepEqual(state(dom), { r: false, p: false }); assert.equal(next(doc(dom)).disabled, true, 'next only after this one is marked');
  await click(dom, prev(doc(dom))); assert.equal(prog(dom), '3 / 20'); assert.match(btn(dom, 'p').className, /\bon\b/); assert.deepEqual(state(dom), { r: false, p: false });
  await click(dom, prev(doc(dom))); assert.equal(prog(dom), '2 / 20'); assert.match(btn(dom, 'r').className, /\bon\b/); assert.deepEqual(state(dom), { r: false, p: false });
  assert.equal(next(doc(dom)).disabled, false, 'a marked question can go forward');
  await click(dom, next(doc(dom))); assert.equal(prog(dom), '3 / 20'); await click(dom, next(doc(dom))); assert.equal(prog(dom), '4 / 20');   // forward to the unmarked one
  assert.deepEqual(state(dom), { r: false, p: false }); assert.deepEqual(marks(dom).slice(0, 5), [true, false, true, null, null]);
  await click(dom, btn(dom, 'r')); assert.equal(prog(dom), '5 / 20'); assert.deepEqual(state(dom), { r: false, p: false });                // 4 ✗
  await click(dom, prev(doc(dom))); await click(dom, prev(doc(dom))); await click(dom, prev(doc(dom))); await click(dom, prev(doc(dom)));    // back to question 1
  assert.equal(prog(dom), '1 / 20'); assert.equal(prev(doc(dom)).disabled, true); assert.deepEqual(state(dom), { r: false, p: false });
  await click(dom, btn(dom, 'r'));                                                                              // change 1: ✓ → ✗, advances to 2 (already marked ✗): buttons still enabled
  assert.equal(prog(dom), '2 / 20'); assert.deepEqual(state(dom), { r: false, p: false }); assert.deepEqual(marks(dom).slice(0, 5), [false, false, true, false, null]);
  doc(dom).defaultView.eval('goMk(4)'); await tick(); assert.equal(prog(dom), '5 / 20'); assert.deepEqual(state(dom), { r: false, p: false });
  for (let k = 5; k <= 20; k++) await click(dom, btn(dom, 'p'));
  assert.match(doc(dom).querySelector('#main').textContent, /全部評分完成/);
  await click(dom, doc(dom).querySelector('.mkone .row:last-child .b.p'));
  const rec = ev(dom, 'Q.records.at(-1)'); assert.deepEqual(JSON.parse(JSON.stringify(rec.items.slice(0, 5).map(x => x.ok))), [false, false, true, false, true]); assert.equal(rec.items.filter(x => !x.ok).length, 3);
  assert.equal(ev(dom, 'Q.correction("corr-" + res.id).items.length'), 3);
  dom.window.close();
});

test('regression: an exam ended early marks its answered questions with working buttons, and a suspend/resume in the middle keeps them usable', async () => {
  const idb = newIdb(), id = await seed(idb); let dom = await openPage(idb, id);
  await answer(dom, 'exam', 5); doc(dom).querySelector('.endb').click(); await tick(); doc(dom).querySelector('#endyes').click(); await tick(); await tick();
  assert.equal(ev(dom, 'Q.cur.phase'), 'mark'); assert.equal(prog(dom), '1 / 5'); assert.deepEqual(state(dom), { r: false, p: false });
  await click(dom, btn(dom, 'p')); await click(dom, btn(dom, 'r')); assert.equal(prog(dom), '3 / 5'); assert.deepEqual(state(dom), { r: false, p: false });
  ev(dom, 'leave()'); await tick(); dom.window.close();
  dom = await openPage(idb, id); ev(dom, "go('exam')"); await tick(); ev(dom, 'resume()'); await tick();
  assert.equal(prog(dom), '3 / 5'); assert.deepEqual(state(dom), { r: false, p: false }); assert.deepEqual(marks(dom), [true, false, null, null, null]);
  for (let k = 3; k <= 5; k++) { assert.deepEqual(state(dom), { r: false, p: false }); await click(dom, btn(dom, 'p')); }
  await click(dom, doc(dom).querySelector('.mkone .row:last-child .b.p'));
  const rec = ev(dom, 'Q.records.at(-1)'); assert.equal(rec.items.length, 5); assert.equal(rec.planned, 20); assert.equal(rec.items.filter(x => x.ok).length, 4);
  dom.window.close();
});
