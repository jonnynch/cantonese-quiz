/* The real page under jsdom: several unfinished activities are listed, resumed independently, and survive a page reload. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const P = require('../public/js/profiles.js');
const { newIdb, CH, level } = require('./helpers');

const PUB = path.join(__dirname, '../public');
const pageHtml = () => fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/<script src="([^"]+)"><\/script>/g, (_, f) => '<script>' + fs.readFileSync(path.join(PUB, f), 'utf8') + '</script>');
const tick = () => new Promise(r => setTimeout(r, 30));
const ev = (dom, code) => dom.window.eval(code);
const main = dom => dom.window.document.querySelector('#main').textContent;
async function openPage(idb, active) {
  const dom = new JSDOM(pageHtml(), { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    w.indexedDB = idb; w.confirm = () => true; w.alert = () => { }; if (active) w.sessionStorage.setItem('cq-active-profile', active);
    w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() { }, beginPath() { }, moveTo() { }, lineTo() { }, stroke() { }, drawImage() { }, set lineWidth(v) { }, set lineCap(v) { }, set lineJoin(v) { }, set strokeStyle(v) { }, set fillStyle(v) { } });
    w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,/9j/AAAA';
  } });
  await dom.window.__cqReady; await tick(); return dom;
}
async function seed(idb) {
  const mgr = await new P.ProfileManager(idb).init(), p = await mgr.create({ name: '小明', avatar: 'cat' });
  const st = await mgr.openStore(p.id), Core = require('../public/js/core.js'), q = new Core.Quiz(st); await q.init();
  await q.mutateLevels(ls => ls.push(level('L1', '一級', Array.from({ length: 22 }, (_, i) => CH('c' + i, String.fromCodePoint(0x4e00 + i))))));
  mgr.closeAll(); return p.id;
}


test('page: exam results show a compact learning summary, and response time only counts while the page is visible', async () => {
  const idb = newIdb(), id = await seed(idb), dom = await openPage(idb, id);
  ev(dom, "go('exam')"); await tick(); ev(dom, "start('read','L1','exam')"); await tick();
  assert.equal(ev(dom, 'Q._q.key'), ev(dom, "Q.cur.id + ':0'")); assert.equal(ev(dom, 'Q._q.since !== null'), true);
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => 'hidden' }); dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(ev(dom, 'Q._q.since'), null, 'paused while hidden');
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => 'visible' }); dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.notEqual(ev(dom, 'Q._q.since'), null, 'resumed on the same question when visible again');
  for (let i = 0; i < 20; i++) { ev(dom, `mark(${i % 4 !== 0})`); await tick(); }
  const t = dom.window.document.querySelector('#main').textContent;
  assert.match(t, /學習進度/); assert.match(t, /需要多練習/); assert.match(t, /進步中/); assert.equal(ev(dom, 'Q.stats.size'), 20);
  ev(dom, "go('exam')"); await tick(); ev(dom, "start('read','L1','practice')"); await tick(); ev(dom, 'leave()'); await tick(); assert.equal(ev(dom, 'Q._q.since'), null, 'paused when leaving');
  dom.window.close();
});
