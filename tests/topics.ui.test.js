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
async function seed(idb) {                       // curriculum (22 characters starting at 一, so some are also in the Numbers topic) and two learners
  const mgr = await new P.ProfileManager(idb).init();
  await mgr.content.saveLevels([lv('L1', '一級', 22), lv('L2', '二級', 22, 300)]);
  const a = await mgr.create({ name: '小明', avatar: 'cat' }), b = await mgr.create({ name: '小美', avatar: 'dog' }); mgr.closeAll(); mgr.db.close(); return { a: a.id, b: b.id };
}
const cards = dom => [...doc(dom).querySelectorAll('#main .card.topic')];
const said = dom => ev(dom, 'JSON.stringify(window.__said || [])');
const withSpeech = dom => ev(dom, "window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } }; window.speechSynthesis = { getVoices: () => [], cancel() { }, speak(u) { (window.__said = window.__said || []).push(u.text); } };");
async function round(dom, wrongFirst = 0) {             // one topic practice (read): every question marked, the first `wrongFirst` wrong
  const n = ev(dom, 'Q.cur.items.length'); for (let i = 0; i < n; i++) { ev(dom, `mark(${i >= wrongFirst})`); await tick(); }
}

test('page: Explore lists the topics with progress, opens a topic, practises it with the ordinary engine, shares progress with the curriculum, and keeps learners apart', async () => {
  const idb = newIdb(), id = await seed(idb); let dom = await openPage(idb, id.a); withSpeech(dom);
  ev(dom, "go('practice')"); await tick(); assert.equal(doc(dom).querySelectorAll('#main .card.lvl').length, 2);
  // ---- the topic list
  ev(dom, "go('topics')"); await tick(); await tick(); await tick();
  assert.match(doc(dom).querySelector('#nav').textContent, /探索/); assert.equal(cards(dom).length, 14);
  assert.deepEqual(cards(dom).map(c => c.querySelector('h3').childNodes[0].textContent.trim()), ['動物', '天氣', '食物', '家庭', '身體', '顏色', '數字', '交通', '學校', '自然', '屋企', '動作', '情緒', '時間']);
  const c0 = cards(dom)[0]; assert.match(c0.textContent, /Animals/); assert.match(c0.textContent, /12 個字/); assert.match(c0.textContent, /0 \/ 12 學會/); assert.match(c0.querySelector('.ticon').textContent, /🐾/); assert.equal(c0.querySelectorAll('.tbar i').length, 1);
  assert.match(c0.getAttribute('aria-label'), /動物 Animals，12 個字，已學會 0 \/ 12/); assert.match(cards(dom)[2].textContent, /Food/); assert.match(cards(dom)[2].textContent, /10 個字/);
  assert.match(main(dom), /不需要先完成任何級別/);
  // the shared content: topics reference the curriculum's own records, and the library is hidden from the curriculum lists
  assert.equal(ev(dom, "CT.topic('numbers').charIds.includes('L1-0')"), true, '一 is the curriculum record'); assert.equal(ev(dom, "CT.level('topic-library').chars.some(c => c.c === '一')"), false);
  ev(dom, "go('practice')"); await tick(); assert.equal(doc(dom).querySelectorAll('#main .card.lvl').length, 2, 'no topic library in the practice level list');
  ev(dom, "go('exam')"); await tick(); assert.equal(doc(dom).querySelectorAll('#main .card.lvl').length, 2);
  // ---- one topic
  ev(dom, "go('topics')"); await tick(); cards(dom)[0].click(); await tick();
  assert.match(main(dom), /動物/); assert.match(main(dom), /0 \/ 12 學會/); assert.equal(doc(dom).querySelectorAll('.tchar').length, 12); assert.match(doc(dom).querySelector('.tchar').textContent, /貓/); assert.match(doc(dom).querySelector('.tchar').textContent, /小貓/);
  doc(dom).querySelector('.tchar').click(); await tick(); assert.match(said(dom), /貓。小貓嘅貓/);                                          // tap a character: its pronunciation (the same phrase as in writing)
  assert.equal(doc(dom).querySelector('#main .row .b.p').disabled, false); assert.match(main(dom), /讀字練習/); assert.match(main(dom), /聽音寫字/);
  ev(dom, "startTopic('read')"); await tick(); await tick();
  assert.equal(ev(dom, 'Q.cur.levelId'), 'topic:animals'); assert.equal(ev(dom, 'Q.cur.levelName'), '主題：動物'); assert.equal(ev(dom, 'Q.cur.mode'), 'practice'); assert.equal(ev(dom, 'Q.cur.items.length'), 12);
  await round(dom); assert.match(main(dom), /讀字練習結果/); assert.match(main(dom), /主題：動物/);
  doc(dom).querySelector('#main .row .b:last-child').click(); await tick();                                                                  // 返回 -> back in the topic, not the curriculum
  assert.match(main(dom), /返回主題/); assert.match(main(dom), /0 \/ 12 學會/, 'one correct answer is not "learned" yet');
  ev(dom, "startTopic('read')"); await tick(); await tick(); await round(dom, 3);                                                                // second round: the first three wrong
  doc(dom).querySelector('#main .row .b:last-child').click(); await tick(); assert.match(main(dom), /9 \/ 12 學會/); assert.equal(doc(dom).querySelectorAll('.tchar.learned').length, 9);
  const only = doc(dom).querySelector('input[type=checkbox]'); assert.ok(only); assert.match(only.parentElement.textContent, /只練未學會的字（3 個）/);
  only.checked = true; only.dispatchEvent(new dom.window.Event('change')); await tick(); ev(dom, "startTopic('write')"); await tick(); await tick(); assert.equal(ev(dom, 'Q.cur.items.length'), 3, 'only the unlearned characters'); assert.equal(ev(dom, 'Q.cur.kind'), 'write');
  ev(dom, 'leave()'); await tick(); ev(dom, 'discard()'); await tick(); ev(dom, "tid = null; go('topics')"); await tick();                   // the nav button: back to the list
  // ---- the list, the curriculum and the history after learning
  assert.match(cards(dom)[0].textContent, /9 \/ 12 學會/);
  const fishLearned = ev(dom, 'Q.topicProgress(CT.topic("animals")).chars.find(c => c.c === "魚").learned'); assert.match(cards(dom)[2].textContent, new RegExp((fishLearned ? 1 : 0) + ' \\/ 10 學會'), '魚 is shared: learned in Animals counts in Food');
  assert.equal(ev(dom, 'Q.records.length'), 2); assert.equal(ev(dom, 'Q.records.every(r => r.levelId === "topic:animals")'), true);
  ev(dom, "go('practice')"); await tick(); const st = [...doc(dom).querySelectorAll('#main .card.lvl .mst')].map(x => x.textContent.trim()); assert.deepEqual(st, ['⚪ 未開始', '⚪ 未開始'], 'topic learning is not level mastery, nor level history');
  ev(dom, "go('hist')"); await tick(); assert.match(main(dom), /主題：動物/);
  dom.window.close();
  // ---- another learner has their own progress; reload keeps everything
  dom = await openPage(idb, id.b); withSpeech(dom); ev(dom, "go('topics')"); await tick(); await tick(); await tick(); assert.equal(cards(dom).length, 14); assert.match(cards(dom)[0].textContent, /0 \/ 12 學會/); assert.equal(ev(dom, 'Q.records.length'), 0); dom.window.close();
  dom = await openPage(idb, id.a); ev(dom, "go('topics')"); await tick(); await tick(); await tick(); assert.match(cards(dom)[0].textContent, /9 \/ 12 學會/); assert.equal(ev(dom, 'CT.topics.length'), 14); assert.equal(ev(dom, "CT.level('topic-library').chars.length"), 109 - 3, '一, 三 and 七 come from the curriculum level, so the library holds the other 106');
  dom.window.close();
});

test('page: a completed topic stays open for practice; topics are reachable whatever the level mastery is, and finishing one does not touch it', async () => {
  const idb = newIdb(), id = await seed(idb), dom = await openPage(idb, id.a); withSpeech(dom);
  ev(dom, "go('practice')"); await tick(); [...doc(dom).querySelectorAll('#main .card.lvl')][0].querySelectorAll('.seg-b')[2].click(); await tick(); await tick();   // level 1: mastered
  assert.match(doc(dom).querySelector('#main .card.lvl .mst').textContent, /已掌握/);
  ev(dom, "go('topics')"); await tick(); await tick(); await tick(); assert.equal(cards(dom).length, 14); cards(dom)[6].click(); await tick();                      // 數字 Numbers
  assert.match(main(dom), /數字/); assert.equal(doc(dom).querySelectorAll('.tchar').length, 11);
  for (let r = 0; r < 2; r++) { ev(dom, "startTopic('read')"); await tick(); await tick(); await round(dom); doc(dom).querySelector('#main .row .b:last-child').click(); await tick(); }
  assert.match(main(dom), /11 \/ 11 學會/); assert.match(main(dom), /全部學會了/); assert.match(main(dom), /再練習・讀字/); assert.match(main(dom), /再練習・寫字/); assert.equal(doc(dom).querySelector('input[type=checkbox]'), null);
  ev(dom, "startTopic('write')"); await tick(); await tick(); assert.equal(ev(dom, 'Q.cur.items.length'), 11); ev(dom, 'leave()'); await tick();                                       // a completed topic can be practised again
  ev(dom, "tid = null; go('topics')"); await tick(); assert.match(cards(dom)[6].textContent, /🎉/); assert.match(cards(dom)[6].textContent, /11 \/ 11/);
  ev(dom, "go('practice')"); await tick(); const mst = [...doc(dom).querySelectorAll('#main .card.lvl .mst')].map(x => x.textContent.trim()); assert.deepEqual(mst, ['⭐ 已掌握', '⚪ 未開始'], 'the manual mastery is unchanged and level 2 was not marked');
  assert.equal(ev(dom, 'Q.mastery.size'), 1);
  dom.window.close();
});
