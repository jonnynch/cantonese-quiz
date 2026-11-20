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
const modal = dom => doc(dom).querySelector('.modal');

test('page: Suspend and End are separate; End asks first; "繼續" keeps the session; "結束" finalises it and shows the results of the completed questions only', async () => {
  const idb = newIdb(), id = await seed(idb), dom = await openPage(idb, id);
  ev(dom, "go('practice')"); await tick(); ev(dom, "start('read','L1','practice')"); await tick(); ev(dom, 'mark(true)'); await tick(); ev(dom, 'mark(false)'); await tick();
  const bar = doc(dom).querySelector('.bar'), btns = [...bar.querySelectorAll('button')];
  assert.equal(btns.length, 2); assert.match(btns[1].textContent, /暫停/); assert.match(btns[0].textContent, /結束/); assert.match(btns[0].className, /endb/); assert.doesNotMatch(btns[0].className, /\bp\b/, 'End is not the prominent action');
  ev(dom, 'leave()'); await tick(); assert.match(doc(dom).querySelector('#main').textContent, /有未完成的讀字練習/); ev(dom, 'resume()'); await tick();   // suspend/resume as before
  assert.equal(ev(dom, 'Q.cur.i'), 2);
  doc(dom).querySelector('.endb').click(); await tick();
  const m = modal(dom); assert.ok(m, 'a confirmation dialog is shown'); assert.equal(m.getAttribute('role'), 'dialog');
  assert.match(m.textContent, /不能再繼續/); assert.match(m.textContent, /已完成 2 \/ 22 題/); assert.match(m.textContent, /不會計算，也不算錯/);
  assert.equal(doc(dom).activeElement.id, 'endno', 'the safe choice has the focus'); assert.equal(ev(dom, 'Q.records.length'), 0);
  m.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })); assert.equal(modal(dom), null); assert.equal(ev(dom, 'Q.cur.i'), 2);   // Escape = continue
  doc(dom).querySelector('.endb').click(); await tick(); doc(dom).querySelector('#endno').click(); await tick();
  assert.equal(modal(dom), null); assert.equal(ev(dom, 'inS'), true); assert.equal(ev(dom, 'Q.cur.i'), 2); assert.equal(ev(dom, 'Q.records.length'), 0); assert.equal(ev(dom, 'Q.sessions.length'), 1);   // "繼續": nothing happened
  doc(dom).querySelector('.endb').click(); await tick(); doc(dom).querySelector('#endyes').click(); await tick(); await tick();
  assert.equal(modal(dom), null); const t = doc(dom).querySelector('#main').textContent;
  assert.match(t, /讀字練習結果/); assert.match(t, /提早結束/); assert.match(t, /2 \/ 22 題/); assert.match(t, /50%|1 \/ 2|1\/2/);
  assert.equal(ev(dom, 'Q.records.length'), 1); assert.equal(ev(dom, 'Q.records[0].items.length'), 2); assert.equal(ev(dom, 'Q.sessions.length'), 0); assert.equal(ev(dom, 'Q.cur'), null);
  ev(dom, "go('practice')"); await tick(); assert.doesNotMatch(doc(dom).querySelector('#main').textContent, /有未完成/);
  ev(dom, "go('hist')"); await tick(); assert.match(doc(dom).querySelector('#main').textContent, /提早結束/);
  dom.window.close();
  const dom2 = await openPage(idb, id); assert.equal(ev(dom2, 'Q.sessions.length'), 0); assert.equal(ev(dom2, 'Q.records.length'), 1); dom2.window.close();     // cannot come back
});

test('page: ending a writing exam early leads to marking the answered questions one by one, then the normal results', async () => {
  const idb = newIdb(), id = await seed(idb), dom = await openPage(idb, id);
  ev(dom, "go('exam')"); await tick(); ev(dom, "start('write','L1','exam')"); await tick();
  for (let i = 0; i < 4; i++) { stroke(dom); ev(dom, 'done()'); await tick(); await tick(); }
  stroke(dom);                                                                                      // a started, unsubmitted drawing of question 5
  doc(dom).querySelector('.endb').click(); await tick(); doc(dom).querySelector('#endyes').click(); await tick(); await tick();
  assert.equal(ev(dom, 'Q.cur.phase'), 'mark'); assert.equal(ev(dom, 'Q.cur.items.length'), 4); let t = doc(dom).querySelector('#main').textContent;
  assert.match(t, /家長評分/); assert.match(t, /已提早結束/); assert.match(t, /4 \/ 20 題/); assert.equal(doc(dom).querySelector('.mkprog').textContent.trim(), '1 / 4'); assert.equal(doc(dom).querySelector('.endb'), null, 'nothing left to end while marking');
  for (const v of [true, false, true, true]) { await ev(dom, `markOne(${v})`); await tick(); }
  await ev(dom, 'finish()'); await tick(); await tick();
  t = doc(dom).querySelector('#main').textContent; assert.match(t, /寫字考試結果/); assert.match(t, /提早結束/); assert.match(t, /4 \/ 20 題/); assert.match(t, /寫五次練習（1 個字）/);
  assert.equal(ev(dom, 'Q.records.length'), 1); assert.equal(ev(dom, 'Q.records[0].planned'), 20); assert.equal(ev(dom, 'Q.corrections.length'), 1);
  dom.window.close();
});

test('page: ending with nothing answered leaves no record; a stray double tap or a correction screen cannot end anything', async () => {
  const idb = newIdb(), id = await seed(idb), dom = await openPage(idb, id);
  ev(dom, "go('practice')"); await tick(); ev(dom, "start('read','L1','practice')"); await tick();
  doc(dom).querySelector('.endb').click(); await tick(); assert.match(modal(dom).textContent, /還沒有完成任何一題/);
  const yes = doc(dom).querySelector('#endyes'); yes.click(); yes.click(); await tick(); await tick();                            // a double tap ends once
  assert.equal(ev(dom, 'Q.records.length'), 0); assert.equal(ev(dom, 'Q.sessions.length'), 0); assert.equal(ev(dom, 'inS'), false); assert.match(doc(dom).querySelector('#toast').textContent, /沒有完成任何一題/);
  ev(dom, 'askEnd()'); assert.equal(modal(dom), null, 'no session: nothing to end');
  // writing correction: it keeps its own suspend button and has no End button
  await ev(dom, `Q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice', chars: Q.level('L1').chars.slice(0, 2) })`); ev(dom, 'resume()'); await tick();
  for (let i = 0; i < 2; i++) { stroke(dom); ev(dom, 'done()'); await tick(); await tick(); }
  await ev(dom, 'setOk(0, false)'); await tick(); await ev(dom, 'setOk(1, true)'); await tick(); await ev(dom, 'finish()'); await tick(); await tick();
  ev(dom, `openCorrection('corr-' + Q.records[0].id)`); await tick();
  assert.equal(doc(dom).querySelector('.endb'), null); assert.match(doc(dom).querySelector('.bar').textContent, /暫停/); ev(dom, 'askEnd()'); assert.equal(modal(dom), null);
  dom.window.close();
});
