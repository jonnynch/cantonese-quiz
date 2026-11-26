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
    w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,/9j/AAAA';
  } });
  await dom.window.__cqReady; await tick(); return dom;
}
const doc = dom => dom.window.document;
const lv = (id, name, k, from = 0) => ({ id, name, desc: '', created: 1, modified: 1, chars: Array.from({ length: k }, (_, i) => ({ id: id + '-' + i, c: String.fromCodePoint(0x4e00 + from + i), jp: '', w: 'w' + i, wjp: '', m: '' })) });
async function seed(idb) {                       // shared content (3 levels) and two learners
  const mgr = await new P.ProfileManager(idb).init();
  await mgr.content.saveLevels([lv('L1', '一級', 22), lv('L2', '二級', 22, 30), lv('L3', '三級', 5, 60)]);
  const a = await mgr.create({ name: '小明', avatar: 'cat' }), b = await mgr.create({ name: '小美', avatar: 'dog' }); mgr.closeAll(); mgr.db.close(); return { a: a.id, b: b.id };
}
const cards = dom => [...doc(dom).querySelectorAll('#main .card.lvl')];
const badge = (dom, i) => cards(dom)[i].querySelector('.mst').textContent.trim();
const seg = (dom, i, label) => [...cards(dom)[i].querySelectorAll('.seg-b')].find(b => b.textContent.includes(label));
const pressed = (dom, i) => [...cards(dom)[i].querySelectorAll('.seg-b')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent.trim());
const statuses = dom => cards(dom).map((c, i) => badge(dom, i));

test('page: each level shows its status; a learner sets it with one tap; it survives a reload; another learner has their own; mastered levels still start', async () => {
  const idb = newIdb(), id = await seed(idb); let dom = await openPage(idb, id.a);
  ev(dom, "go('practice')"); await tick();
  assert.equal(cards(dom).length, 3); assert.deepEqual(statuses(dom), ['⚪ 未開始', '⚪ 未開始', '⚪ 未開始']); assert.deepEqual(pressed(dom, 0), ['⚪ 未開始']);
  assert.equal(cards(dom)[0].querySelectorAll('.seg-b').length, 3); assert.equal(cards(dom)[0].querySelector('.seg').getAttribute('role'), 'group');
  seg(dom, 0, '已掌握').click(); await tick(); await tick();                                                         // one tap, no dialog
  assert.deepEqual(statuses(dom), ['⭐ 已掌握', '⚪ 未開始', '⚪ 未開始']); assert.deepEqual(pressed(dom, 0), ['⭐ 已掌握']); assert.ok(cards(dom)[0].classList.contains('mastered')); assert.equal(doc(dom).querySelector('.modal'), null);
  seg(dom, 1, '學習中').click(); await tick(); await tick(); assert.deepEqual(statuses(dom), ['⭐ 已掌握', '📖 學習中', '⚪ 未開始']);
  assert.equal(ev(dom, 'Q.records.length'), 0); assert.equal(ev(dom, 'Q.stats.size'), 0);                              // marking a status creates no result
  // a mastered level can still be practised and examined; the status is unchanged by it
  const startBtn = i => cards(dom)[i].querySelector('.row .b.p'); assert.equal(startBtn(0).disabled, false);
  startBtn(0).click(); await tick(); await tick(); assert.equal(ev(dom, 'inS'), true); assert.equal(ev(dom, 'Q.cur.levelId'), 'L1'); ev(dom, 'leave()'); await tick();
  ev(dom, "go('exam')"); await tick(); assert.deepEqual(statuses(dom), ['⭐ 已掌握', '📖 學習中', '⚪ 未開始']); assert.equal(startBtn(0).disabled, false); assert.equal(startBtn(2).disabled, true, 'a 5-character level is still too small for an exam, as before');
  ev(dom, "go('practice')"); await tick(); dom.window.close();
  dom = await openPage(idb, id.a); ev(dom, "go('practice')"); await tick();                                          // close and reopen the app
  assert.deepEqual(statuses(dom), ['⭐ 已掌握', '📖 學習中', '⚪ 未開始']); assert.equal(ev(dom, 'Q.sessions.length'), 1, 'the unfinished practice is untouched'); assert.equal(ev(dom, 'Q.sessions[0].levelId'), 'L1');
  // switch to the other learner: their own (empty) mastery; then back
  ev(dom, 'switchLearner()'); await tick(); await ev(dom, `selectProfile('${id.b}')`); await tick(); await tick(); ev(dom, "go('practice')"); await tick();
  assert.deepEqual(statuses(dom), ['⚪ 未開始', '⚪ 未開始', '⚪ 未開始'], 'nothing of the other learner');
  seg(dom, 2, '已掌握').click(); await tick(); await tick(); assert.deepEqual(statuses(dom), ['⚪ 未開始', '⚪ 未開始', '⭐ 已掌握']);
  ev(dom, 'switchLearner()'); await tick(); await ev(dom, `selectProfile('${id.a}')`); await tick(); await tick(); ev(dom, "go('practice')"); await tick();
  assert.deepEqual(statuses(dom), ['⭐ 已掌握', '📖 學習中', '⚪ 未開始']);
  seg(dom, 0, '學習中').click(); await tick(); await tick(); assert.deepEqual(statuses(dom), ['📖 學習中', '📖 學習中', '⚪ 未開始']);   // mastery removed; history and the session are kept
  assert.equal(ev(dom, 'Q.sessions.length'), 1); dom.window.close();
  dom = await openPage(idb, id.b); ev(dom, "go('practice')"); await tick(); assert.deepEqual(statuses(dom), ['⚪ 未開始', '⚪ 未開始', '⭐ 已掌握']); dom.window.close();
});

test('page: a learner whose data has no mastery yet works as before and shows learning for levels with history', async () => {
  const idb = newIdb(), id = await seed(idb), dom = await openPage(idb, id.a);
  ev(dom, "go('practice')"); await tick(); cards(dom)[1].querySelector('.row .b.p').click(); await tick(); await tick();
  for (let i = 0; i < 22; i++) { ev(dom, 'mark(true)'); await tick(); }
  assert.match(doc(dom).querySelector('#main').textContent, /讀字練習結果/); ev(dom, "go('practice')"); await tick();
  assert.deepEqual(statuses(dom), ['⚪ 未開始', '📖 學習中', '⚪ 未開始']); assert.deepEqual(pressed(dom, 1), ['📖 學習中']); assert.equal(ev(dom, 'Q.mastery.size'), 0, 'automatic: nothing was written');
  seg(dom, 1, '已掌握').click(); await tick(); await tick(); assert.equal(ev(dom, 'Q.records.length'), 1); assert.equal(ev(dom, 'Q.records[0].items.length'), 22);
  dom.window.close();
});
