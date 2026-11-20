/* Patch 3 in the real page (public/index.html + js/*) under jsdom with a fake IndexedDB, a recording canvas and a recording speechSynthesis. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const P = require('../public/js/profiles.js'), Core = require('../public/js/core.js');
const { S, IMG, newIdb, CH, level, legacyBlob } = require('./helpers');

const PUB = path.join(__dirname, '../public');
const pageHtml = () => fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/<script src="([^"]+)"><\/script>/g, (_, f) => '<script>' + fs.readFileSync(path.join(PUB, f), 'utf8') + '</script>');
const wait = ms => new Promise(r => setTimeout(r, ms)), tick = () => wait(25);

function env() { return { drawn: [], spoken: [], speechFails: false }; }
function install(e) {
  return w => {
    const ctx = { fillRect() { }, beginPath() { }, moveTo() { }, lineTo() { }, stroke() { }, drawImage(img) { e.drawn.push(img.src); } };
    const P = w.HTMLCanvasElement.prototype;
    P.getContext = () => ctx; P.setPointerCapture = () => { }; let n = 0; P.toDataURL = () => 'data:image/jpeg;base64,INK' + (++n);
    w.Image = class { set src(v) { this._s = v; setTimeout(() => this.onload && this.onload(), 0); } get src() { return this._s; } };
    w.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    w.speechSynthesis = { getVoices: () => [], cancel() { e.spoken.push('<cancel>'); }, speak(u) { if (e.speechFails) throw new Error('blocked'); e.spoken.push(u.text); e.log && e.log.push('start:' + u.text + ':' + u.lang); setTimeout(() => { e.log && e.log.push('end:' + u.text); u.onend && u.onend(); }, 5); } };
  };
}
async function openPage(idb, e, { legacy, active } = {}) {
  const dom = new JSDOM(pageHtml(), { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    w.indexedDB = idb; w.confirm = () => true; w.alert = () => { }; install(e)(w);
    if (active) w.sessionStorage.setItem('cq-active-profile', active); if (legacy) w.localStorage.setItem(S.LEGACY_KEY, legacy); } });
  await dom.window.__cqReady; await wait(30); return dom;
}
async function seed(idb, n = 20) {
  const m = new P.ProfileManager(idb); await m.init(); const p = await m.create({ name: '小明', avatar: 'cat' });
  const q = new Core.Quiz(await m.openStore(p.id)); await q.init();
  await q.mutateLevels(ls => ls.push(level('L1', '甲組', Array.from({ length: n }, (_, i) => CH('c' + i, '字日月火水木土金山川口手足耳目'.split('')[i % 15] + (i >= 15 ? '' : ''))))));
  m.closeAll(); return p.id;
}
const ev = (dom, code) => dom.window.eval(code);
const main = dom => dom.window.document.querySelector('#main').textContent;
const ptr = { preventDefault() { }, pointerId: 1, clientX: 5, clientY: 5 };
const stroke = el => { el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 360 }); el.onpointerdown(ptr); el.onpointerup(); };
const btns = dom => [...dom.window.document.querySelectorAll('#main button')].map(b => b.textContent.trim());
const texts = e => e.spoken.filter(x => x !== '<cancel>' && x !== '');

/* ---------------- 1. one clear button ---------------- */
test('writing practice and writing exam each show exactly one clear button, which only clears the current canvas', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb); const dom = await openPage(idb, e, { active: id });
  ev(dom, "start('write','L1','practice')"); await tick();
  assert.equal(btns(dom).filter(t => t === '清除').length, 1); assert.equal(btns(dom).filter(t => t === '重寫').length, 0);
  stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await tick(); await tick();             // answer 1 saved
  assert.equal((await ev(dom, 'store.exportAll()')).images.length, 1);
  stroke(dom.window.document.querySelector('#cv')); assert.equal(ev(dom, 'dirty'), true);
  ev(dom, 'clr()'); await wait(60);                                                                           // the one clear button's handler
  assert.equal(ev(dom, 'dirty'), false);
  assert.equal((await ev(dom, 'store.exportAll()')).images.length, 1);                                         // previous answer untouched
  assert.equal(ev(dom, 'Q.cur.i'), 1); assert.ok(ev(dom, 'Q.cur.items[0].imgId')); assert.equal((await ev(dom, 'store.getDraft()')).data, null);   // draft of THIS question is empty
  dom.window.document.querySelector('#clrbtn').click(); await wait(30);                                        // the real button works too
  ev(dom, 'leave()'); await tick(); ev(dom, "go('exam')"); await tick();
  ev(dom, "start('write','L1','exam')"); await tick();                                                         // exam (confirms replacing nothing: session was kept, confirm=true)
  assert.equal(ev(dom, 'Q.cur.mode'), 'exam'); assert.equal(btns(dom).filter(t => t === '清除').length, 1); assert.equal(btns(dom).filter(t => t === '重寫').length, 0);
  dom.window.close();
});

/* ---------------- 2. automatic pronunciation ---------------- */
test('automatic speech: one utterance (character。word嘅character), once per question, no duplicates on rerender or resume', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb); let dom = await openPage(idb, e, { active: id });
  ev(dom, "start('write','L1','practice')"); await tick();
  const first = ev(dom, 'Q.cur.items[0].c'), second = ev(dom, 'Q.cur.items[1].c'), ph = i => ev(dom, `Q.cur.items[${i}].c + '。' + Q.cur.items[${i}].w + '嘅' + Q.cur.items[${i}].c`);
  await wait(80); assert.deepEqual(texts(e), [ph(0)]);                                                  // ONE utterance: character, full stop, compound word in context
  assert.equal(e.spoken[e.spoken.indexOf(ph(0)) - 1], '<cancel>');                                             // cancels earlier speech first: no overlap
  for (let i = 0; i < 3; i++) { ev(dom, 'render()'); ev(dom, "autoSpeak()"); }
  ev(dom, "go('levels')"); await tick(); ev(dom, "go('practice')"); await tick(); ev(dom, 'resume()'); await tick(); ev(dom, 'toast("x")');
  await wait(80); assert.deepEqual(texts(e), [ph(0)], 'rerenders, tab changes and state updates must not repeat it');
  assert.equal(dom.window.document.querySelector('#ans').textContent, ''); assert.ok([...dom.window.document.querySelectorAll('.han')].every(x => x.textContent === ''));   // speech never reveals the target
  stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await tick(); await tick();
  await wait(80); assert.deepEqual(texts(e), [ph(0), ph(1)]);                                   // next question: its own single utterance, once
  ev(dom, 'render()'); ev(dom, 'render()'); await wait(60); assert.equal(texts(e).length, 2);
  ev(dom, "say('w')"); assert.equal(texts(e).at(-1), ev(dom, 'Q.cur.items[1].w'));                             // manual buttons still read only the word / only the character
  ev(dom, "say('c')"); assert.equal(texts(e).at(-1), second);
  dom.window.close();
  // browser reload while resuming the unfinished session: nothing is spoken again
  const e2 = env(); dom = await openPage(idb, e2, { active: id });
  assert.equal(ev(dom, 'Q.cur.i'), 1); ev(dom, 'resume()'); await tick(); ev(dom, 'render()'); await tick();
  assert.deepEqual(texts(e2), [], 'resuming must not replay the current character');
  stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await tick(); await tick();
  await wait(80); assert.deepEqual(texts(e2), [ev(dom, "Q.cur.items[2].c + '。' + Q.cur.items[2].w + '嘅' + Q.cur.items[2].c")]);   // but advancing speaks the next one
  dom.window.close();
});

test('automatic speech also applies to writing exams and revisions, but not to reading', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb); const dom = await openPage(idb, e, { active: id });
  ev(dom, "start('read','L1','practice')"); await tick(); ev(dom, 'mark(true)'); await tick(); assert.deepEqual(texts(e), []);
  ev(dom, 'leave()'); await tick(); ev(dom, "go('exam')"); await tick();
  ev(dom, "start('write','L1','exam')"); await wait(100); assert.deepEqual(texts(e), [ev(dom, "Q.cur.items[0].c + '。' + Q.cur.items[0].w + '嘅' + Q.cur.items[0].c")]);
  dom.window.close();
});

test('automatic speech failures never break the question flow', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb); e.speechFails = true; const dom = await openPage(idb, e, { active: id });
  ev(dom, "start('write','L1','practice')"); await tick(); assert.equal(ev(dom, 'Q.cur.i'), 0); assert.ok(dom.window.document.querySelector('#cv'));
  stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await tick(); await tick();
  assert.equal(ev(dom, 'Q.cur.i'), 1); assert.ok(dom.window.document.querySelector('.spk'));                   // manual audio button still there
  const bare = env(); const d2 = await openPage(idb, bare, { active: id });                                    // no speech support at all
  d2.window.speechSynthesis = undefined; d2.window.SpeechSynthesisUtterance = undefined;
  ev(d2, 'resume()'); await tick(); stroke(d2.window.document.querySelector('#cv')); ev(d2, 'done()'); await tick(); await tick(); assert.equal(ev(d2, 'Q.cur.i'), 2);
  dom.window.close(); d2.window.close();
});

/* ---------------- 3. duration on the completion screen ---------------- */
test('completion screens show the elapsed duration instead of a timestamp; legacy records say it is unavailable', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb, 3); let dom = await openPage(idb, e, { active: id });
  ev(dom, "start('read','L1','practice')"); await tick(); for (let i = 0; i < 3; i++) { ev(dom, 'mark(true)'); await tick(); }
  const t = main(dom); assert.match(t, /用時\d+ 秒|用時\d+ 分 \d+ 秒/); assert.doesNotMatch(t, /日期/); assert.doesNotMatch(t, /\d{4}[\/-]\d/);
  assert.ok(ev(dom, 'res.started') > 0 && ev(dom, 'res.date') >= ev(dom, 'res.started'));                      // both timestamps still stored
  dom.window.close();
  const idb2 = newIdb(), e2 = env(); dom = await openPage(idb2, e2, { legacy: legacyBlob() });
  ev(dom, "selectProfile('p-legacy')"); await tick(); ev(dom, "go('hist')"); await tick(); ev(dom, "rid='r1';render()"); await tick();
  assert.match(main(dom), /用時\s*未有資料/); assert.doesNotMatch(main(dom), /NaN|-\d+ 秒/);
  dom.window.close();
});

/* ---------------- 4. five-times correction ---------------- */
async function finishWriting(dom, wrongIdx) {      // answer every question with a stroke, then mark
  ev(dom, "start('write','L1','practice')"); await tick();
  const n = ev(dom, 'Q.cur.items.length');
  for (let i = 0; i < n; i++) { stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await tick(); await tick(); }
  for (let i = 0; i < n; i++) { ev(dom, `setOk(${i}, ${!wrongIdx.includes(i)})`); await tick(); }
  ev(dom, 'finish()'); await tick(); await tick();
}
const streak = dom => dom.window.document.querySelector('#cstreak').textContent;
const feedback = dom => dom.window.document.querySelector('#cfb').textContent;
const canvasCount = dom => dom.window.document.querySelectorAll('#main canvas').length;
async function attempt(dom, ok) {                    // write one attempt, submit it, then mark it (the parent's check)
  stroke(dom.window.document.querySelector('#cc')); await ev(dom, 'submitAttempt()'); await tick();
  assert.ok(dom.window.document.querySelector('#cc').classList.contains('lock'), 'a submitted attempt is locked until it is marked');
  await ev(dom, `markAttempt(${ok})`); await tick();
}

test('writing correction: ONE large canvas, five consecutive correct attempts, a wrong attempt restarts at 0, original score untouched', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb, 3); const dom = await openPage(idb, e, { active: id });
  await finishWriting(dom, []);                                                                                // everything correct
  assert.match(main(dom), /全部正確/); assert.doesNotMatch(main(dom), /寫五次/); assert.equal(ev(dom, 'Q.corrections.length'), 0);
  ev(dom, "go('practice')"); await tick();
  await finishWriting(dom, [0, 2]);                                                                            // two wrong characters
  assert.match(main(dom), /寫五次練習（2 個字）/); assert.equal(ev(dom, 'Q.corrections.length'), 1);
  const rid = ev(dom, 'res.id'), before = JSON.stringify(ev(dom, 'Q.records')), recCount = ev(dom, 'Q.records.length');
  ev(dom, `openCorrection('corr-${rid}')`); await tick();
  assert.match(main(dom), /呢個字未寫正確，請連續寫五次/); assert.equal(canvasCount(dom), 1); assert.equal(dom.window.document.querySelectorAll('.five, .slot').length, 0);
  const target = ev(dom, 'Q.correction(corrId).items[corrIdx]'); assert.match(main(dom), new RegExp(target.c)); assert.match(main(dom), new RegExp(target.w));
  assert.match(dom.window.document.querySelector('#cprog').textContent, /第 1 \/ 2 個字/); assert.match(streak(dom), /連續寫正確：0 \/ 5/);
  assert.equal(dom.window.document.querySelector('#csub').disabled, true, 'nothing to submit on an empty canvas');
  await ev(dom, 'submitAttempt()'); assert.equal(ev(dom, 'Q.correction(corrId).items[corrIdx].checking'), false);   // blank canvas cannot be submitted
  await attempt(dom, true); assert.match(streak(dom), /連續寫正確：1 \/ 5/); assert.match(feedback(dom), /正確/);
  assert.equal(ev(dom, 'ccv.dirty'), false, 'the canvas is cleared for the next attempt'); assert.equal(ev(dom, 'Q.correction(corrId).items[corrIdx].pending'), null); assert.equal(canvasCount(dom), 1);
  await attempt(dom, true); assert.match(streak(dom), /2 \/ 5/);
  stroke(dom.window.document.querySelector('#cc')); await ev(dom, 'submitAttempt()'); await tick();           // submitted but not marked yet: does not count
  assert.match(streak(dom), /2 \/ 5/); assert.equal(ev(dom, 'Q.correction(corrId).items[corrIdx].attempts.filter(Boolean).length'), 2);
  const oldIds = ev(dom, 'Q.correction(corrId).items[corrIdx].attempts.filter(Boolean)');
  await ev(dom, 'markAttempt(false)'); await tick();                                                           // wrong: back to zero
  assert.match(streak(dom), /連續寫正確：0 \/ 5/); assert.match(feedback(dom), /重新計算/); assert.equal(ev(dom, 'Q.correction(corrId).items[corrIdx].attempts.filter(Boolean).length'), 0);
  assert.equal(await ev(dom, `store.getImage('${oldIds[0]}')`), null, 'discarded streak images are removed');
  assert.equal(ev(dom, 'corrIdx'), 0, 'the same character again: no advance without five in a row');
  for (let k = 0; k < 4; k++) await attempt(dom, true); assert.match(streak(dom), /4 \/ 5/); assert.equal(ev(dom, 'corrIdx'), 0);
  await attempt(dom, false); assert.match(streak(dom), /0 \/ 5/); assert.equal(ev(dom, 'corrIdx'), 0);          // 4 in a row, then a mistake: restart
  for (let k = 0; k < 5; k++) { assert.equal(canvasCount(dom), 1); await attempt(dom, true); }                  // five in a row: second character
  assert.match(dom.window.document.querySelector('#cprog').textContent, /第 2 \/ 2 個字/); assert.match(dom.window.document.querySelector('#cprog').textContent, /總進度 5 \/ 10/);
  assert.match(streak(dom), /0 \/ 5/); assert.match(feedback(dom), /完成了/);
  for (let k = 0; k < 5; k++) await attempt(dom, true);
  assert.match(main(dom), /寫五次練習完成/); assert.match(main(dom), /10 \/ 10/);
  assert.equal(ev(dom, 'Q.correction(corrId).state'), 'done'); assert.equal(JSON.stringify(ev(dom, 'Q.records')), before); assert.equal(ev(dom, 'Q.records.length'), recCount);   // original results unchanged; no new exam questions
  ev(dom, 'leaveCorr()'); await tick(); ev(dom, "go('practice')"); await tick(); assert.doesNotMatch(main(dom), /有未完成的寫五次/);
  assert.equal(ev(dom, 'Q.corrections.length'), 1);                                                            // no duplicates after revisiting
  dom.window.close();
});

test('writing correction: progress, the drawing and a submitted-but-unmarked attempt survive a refresh; leaving does not corrupt the result', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb, 3); let dom = await openPage(idb, e, { active: id });
  await finishWriting(dom, [1]); const cid = 'corr-' + ev(dom, 'res.id'), rec = JSON.stringify(ev(dom, 'Q.records'));
  ev(dom, `openCorrection('${cid}')`); await tick();
  for (let k = 0; k < 3; k++) await attempt(dom, true);
  stroke(dom.window.document.querySelector('#cc'));                                                            // a stroke still waiting for its autosave when the tab goes away
  await ev(dom, 'flushCorr()'); assert.ok(ev(dom, 'Q.correction(corrId).items[0].pending'));
  ev(dom, 'leaveCorr()'); await tick(); assert.equal(JSON.stringify(ev(dom, 'Q.records')), rec); dom.window.close();
  let e2 = env(); dom = await openPage(idb, e2, { active: id });                                               // refresh
  assert.equal(ev(dom, 'Q.corrections.length'), 1); ev(dom, "go('practice')"); await tick();
  assert.match(main(dom), /有未完成的寫五次練習/); assert.match(main(dom), /3 \/ 5/);
  ev(dom, `openCorrection('${cid}')`); await tick(); await tick();
  assert.match(streak(dom), /3 \/ 5/); assert.equal(e2.drawn.length, 1); assert.equal(dom.window.document.querySelector('#csub').disabled, false);   // the unfinished drawing is back
  await ev(dom, 'submitAttempt()'); await tick(); dom.window.close();                                          // submitted, then the app is closed before marking
  e2 = env(); dom = await openPage(idb, e2, { active: id }); ev(dom, `openCorrection('${cid}')`); await tick(); await tick();
  assert.match(streak(dom), /3 \/ 5/, 'an unmarked attempt does not count'); assert.ok(dom.window.document.querySelector('#cc').classList.contains('lock')); assert.match(main(dom), /請家長評分/);
  await ev(dom, 'markAttempt(true)'); await tick(); assert.match(streak(dom), /4 \/ 5/);
  await attempt(dom, true); assert.match(main(dom), /寫五次練習完成/); assert.equal(JSON.stringify(ev(dom, 'Q.records')), rec);
  dom.window.close();
});

test('writing correction: a failed save keeps the drawing, warns in Traditional Chinese and can be retried', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb, 3); const dom = await openPage(idb, e, { active: id });
  await finishWriting(dom, [0]); ev(dom, `openCorrection('corr-${ev(dom, 'res.id')}')`); await tick();
  ev(dom, 'Q.store = { ...Q.store, saveCorrection: () => Promise.reject(Object.assign(new Error(\"x\"), { code: \"quota\" })) }');
  stroke(dom.window.document.querySelector('#cc')); await wait(550);
  const bar = dom.window.document.querySelector('#errbar'); assert.ok(bar && !bar.hidden); assert.match(bar.textContent, /沒有儲存成功/); assert.match(bar.textContent, /筆跡仍然保留/);
  assert.equal(ev(dom, 'ccv.dirty'), true); assert.match(streak(dom), /0 \/ 5/);                               // not counted
  ev(dom, 'Q.store = store'); ev(dom, 'retryCorr()'); await tick(); await tick();
  assert.ok(ev(dom, 'Q.correction(corrId).items[0].pending')); assert.ok(dom.window.document.querySelector('#errbar').hidden);
  dom.window.close();
});

/* ---------------- 5. parent marking: one writing answer at a time ---------------- */
async function answerAll(dom, mode) {                // answer every question of a writing session (each with a stroke), leaving it in the marking phase
  ev(dom, `start('write','L1','${mode}')`); await tick();
  const n = ev(dom, 'Q.cur.items.length');
  for (let i = 0; i < n; i++) { stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await tick(); await tick(); }
  return n;
}
const mkProg = dom => dom.window.document.querySelector('.mkprog').textContent.trim();
const marks = dom => JSON.parse(ev(dom, 'JSON.stringify(Q.cur.items.map(x => x.ok))'));   // (plain array: jsdom arrays are another realm)

test('exam writing marking: one answer at a time with progress; each mark is independent and advances; going back keeps marks; changing one updates the result', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb, 22); const dom = await openPage(idb, e, { active: id });
  ev(dom, "go('exam')"); await tick(); const n = await answerAll(dom, 'exam'); assert.equal(n, 20); assert.equal(ev(dom, 'Q.cur.phase'), 'mark');
  assert.equal(mkProg(dom), '1 / 20'); assert.equal(dom.window.document.querySelectorAll('.mkimg').length, 1, 'one answer on screen');
  assert.equal(dom.window.document.querySelectorAll('.card.mk').length, 0, 'no grid of all answers');
  assert.match(main(dom), new RegExp(ev(dom, 'Q.cur.items[0].c'))); assert.equal(dom.window.document.querySelector('.mkrow .b.r').textContent, '錯誤');
  assert.equal(dom.window.document.querySelector('.mkrow .b.p').textContent, '正確');
  await ev(dom, 'markOne(true)'); await tick(); assert.equal(mkProg(dom), '2 / 20');                          // marking advances to the next
  assert.deepEqual(marks(dom).slice(0, 3), [true, null, null]);                                               // and marked nothing else
  await ev(dom, 'markOne(false)'); await tick(); assert.equal(mkProg(dom), '3 / 20'); assert.deepEqual(marks(dom).slice(0, 4), [true, false, null, null]);
  ev(dom, 'goMk(0)'); await tick(); assert.equal(mkProg(dom), '1 / 20'); assert.deepEqual(marks(dom).slice(0, 3), [true, false, null]);   // back: marks preserved
  assert.match(dom.window.document.querySelector('.mkrow .b.p').className, /\bon\b/);                          // the existing mark is shown
  assert.equal(dom.window.document.querySelector('.bar + .stage .row:last-child .b').disabled, true, 'no previous question before the first');
  ev(dom, 'goMk(2)'); await tick();
  for (let i = 2; i < 20; i++) { await ev(dom, 'markOne(true)'); await tick(); }                              // the rest correct
  assert.match(main(dom), /20 \/ 20 題已評分/); assert.match(main(dom), /全部評分完成/); assert.equal(ev(dom, 'Q.cur.items.filter(x => x.ok === false).length'), 1);
  assert.equal(dom.window.document.querySelector('.mkone .row:last-child .b.p').disabled, false);
  ev(dom, 'goMk(0)'); await tick(); await ev(dom, 'markOne(false)'); await tick();                            // change an earlier mark
  assert.deepEqual(marks(dom).slice(0, 2), [false, false]); assert.equal(mkProg(dom), '2 / 20');
  ev(dom, 'goMk(20)'); await tick(); assert.match(main(dom), /全部評分完成/);
  ev(dom, 'finish()'); await tick(); await tick();
  const rec = ev(dom, 'Q.records.at(-1)'); assert.equal(rec.mode, 'exam'); assert.equal(rec.items.filter(x => x.ok).length, 18); assert.equal(rec.items.filter(x => !x.ok).length, 2);   // the final result reflects the changed mark
  assert.match(main(dom), /寫五次練習（2 個字）/); assert.equal(ev(dom, 'Q.correction("corr-" + res.id).items.length'), 2);
  dom.window.close();
});

test('marking: every answer must be marked before the assessment can be completed; no double marking; resumes at the first unmarked answer', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb, 3); let dom = await openPage(idb, e, { active: id });
  const n = await answerAll(dom, 'practice'); assert.equal(n, 3);
  ev(dom, 'markOne(true); markOne(true)'); await tick(); await tick();                                       // a double tap marks ONE answer only
  assert.deepEqual(marks(dom), [true, null, null]); assert.equal(mkProg(dom), '2 / 3');
  ev(dom, 'goMk(3)'); await tick(); assert.match(main(dom), /還有 2 題未評分/);                                // review with unmarked answers
  assert.equal(dom.window.document.querySelector('.mkone .row:last-child .b.p').disabled, true);
  await ev(dom, 'finish()'); await tick(); assert.equal(ev(dom, 'Q.records.length'), 0); assert.equal(ev(dom, 'Q.cur.phase'), 'mark');   // refused: nothing completed
  ev(dom, 'leave()'); await tick(); dom.window.close();
  dom = await openPage(idb, env(), { active: id }); ev(dom, "go('practice')"); await tick(); ev(dom, 'resume()'); await tick();
  assert.equal(mkProg(dom), '2 / 3'); assert.deepEqual(marks(dom), [true, null, null]);                       // the saved mark is kept; continues where it stopped
  await ev(dom, 'markOne(false)'); await tick(); await ev(dom, 'markOne(true)'); await tick(); assert.match(main(dom), /全部評分完成/);
  ev(dom, 'finish()'); await tick(); await tick();
  assert.equal(ev(dom, 'Q.records.length'), 1); assert.deepEqual(JSON.parse(ev(dom, 'JSON.stringify(Q.records[0].items.map(x => x.ok))')), [true, false, true]);
  dom.window.close();
});
