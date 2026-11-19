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

test('page: unfinished activities are listed with level/type/progress, resumed individually, kept across reload, and starting again resumes instead of duplicating', async () => {
  const idb = newIdb(), id = await seed(idb); let dom = await openPage(idb, id);
  ev(dom, "go('practice')"); await tick();
  ev(dom, "start('read','L1','practice')"); await tick(); ev(dom, 'mark(true)'); await tick(); ev(dom, 'mark(true)'); await tick();
  ev(dom, 'leave()'); await tick();
  assert.match(main(dom), /有未完成的讀字練習/); assert.match(main(dom), /一級/); assert.match(main(dom), /第 3 \/ 22 題/); assert.match(main(dom), /上次作答/);
  ev(dom, "start('write','L1','practice')"); await tick(); ev(dom, 'leave()'); await tick();                       // a second activity does not replace the first
  assert.match(main(dom), /有未完成的聽音寫字/); assert.match(main(dom), /有未完成的讀字練習/); assert.equal(ev(dom, 'Q.sessions.length'), 2);
  ev(dom, "start('read','L1','practice')"); await tick();                                                          // duplicate: resumes where it stopped
  assert.equal(ev(dom, 'Q.sessions.length'), 2); assert.equal(ev(dom, 'Q.cur.kind'), 'read'); assert.equal(ev(dom, 'Q.cur.i'), 2); assert.equal(ev(dom, 'inS'), true);
  ev(dom, 'leave()'); await tick(); dom.window.close();

  dom = await openPage(idb, id);                                                                                   // reload
  assert.equal(ev(dom, 'Q.sessions.length'), 2); ev(dom, "go('practice')"); await tick();
  assert.match(main(dom), /第 3 \/ 22 题|第 3 \/ 22 題/); assert.equal(dom.window.document.querySelectorAll('#main button[onclick^="resume"]').length, 2);
  const wid = ev(dom, "Q.sessions.find(s => s.kind === 'write').id");
  ev(dom, `resume('${wid}')`); await tick(); assert.equal(ev(dom, 'Q.cur.id'), wid); assert.ok(dom.window.document.querySelector('#cv'));
  ev(dom, 'leave()'); await tick();
  ev(dom, `discard('${wid}')`); await tick();                                                                      // discarding one leaves the other
  assert.equal(ev(dom, 'Q.sessions.length'), 1); assert.equal(ev(dom, 'Q.sessions[0].kind'), 'read'); assert.match(main(dom), /有未完成的讀字練習/);
  dom.window.close();
});
