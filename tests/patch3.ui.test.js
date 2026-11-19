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
test('automatic speech: the character, then its compound word, once per question, no duplicates on rerender or resume', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb); let dom = await openPage(idb, e, { active: id }); ev(dom, 'speechGap = 20');
  ev(dom, "start('write','L1','practice')"); await tick();
  const first = ev(dom, 'Q.cur.items[0].c'), second = ev(dom, 'Q.cur.items[1].c'), ph = i => ev(dom, `Q.cur.items[${i}].w + '嘅' + Q.cur.items[${i}].c`);
  await wait(80); assert.deepEqual(texts(e), [first, ph(0)]);                                                  // character, then the compound word in context
  assert.equal(e.spoken[e.spoken.indexOf(first) - 1], '<cancel>');                                             // cancels earlier speech first: no overlap
  for (let i = 0; i < 3; i++) { ev(dom, 'render()'); ev(dom, "autoSpeak()"); }
  ev(dom, "go('levels')"); await tick(); ev(dom, "go('practice')"); await tick(); ev(dom, 'resume()'); await tick(); ev(dom, 'toast("x")');
  await wait(80); assert.deepEqual(texts(e), [first, ph(0)], 'rerenders, tab changes and state updates must not repeat it');
  assert.equal(dom.window.document.querySelector('#ans').textContent, ''); assert.ok([...dom.window.document.querySelectorAll('.han')].every(x => x.textContent === ''));   // speech never reveals the target
  stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await tick(); await tick();
  await wait(80); assert.deepEqual(texts(e), [first, ph(0), second, ph(1)]);                                   // next question: its character then word, once
  ev(dom, 'render()'); ev(dom, 'render()'); await wait(60); assert.equal(texts(e).length, 4);
  ev(dom, "say('w')"); assert.equal(texts(e).at(-1), ev(dom, 'Q.cur.items[1].w'));                             // manual buttons still read only the word / only the character
  ev(dom, "say('c')"); assert.equal(texts(e).at(-1), second);
  dom.window.close();
  // browser reload while resuming the unfinished session: nothing is spoken again
  const e2 = env(); dom = await openPage(idb, e2, { active: id }); ev(dom, 'speechGap = 20');
  assert.equal(ev(dom, 'Q.cur.i'), 1); ev(dom, 'resume()'); await tick(); ev(dom, 'render()'); await tick();
  assert.deepEqual(texts(e2), [], 'resuming must not replay the current character');
  stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await tick(); await tick();
  await wait(80); assert.deepEqual(texts(e2), [ev(dom, 'Q.cur.items[2].c'), ev(dom, "Q.cur.items[2].w + '嘅' + Q.cur.items[2].c")]);   // but advancing speaks the next one
  dom.window.close();
});

test('automatic speech also applies to writing exams and revisions, but not to reading', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb); const dom = await openPage(idb, e, { active: id });
  ev(dom, "start('read','L1','practice')"); await tick(); ev(dom, 'mark(true)'); await tick(); assert.deepEqual(texts(e), []);
  ev(dom, 'leave()'); await tick(); ev(dom, "go('exam')"); await tick();
  ev(dom, 'speechGap = 20'); ev(dom, "start('write','L1','exam')"); await wait(100); assert.deepEqual(texts(e), [ev(dom, 'Q.cur.items[0].c'), ev(dom, "Q.cur.items[0].w + '嘅' + Q.cur.items[0].c")]);
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
const prog = dom => dom.window.document.querySelector('#cprog').textContent;
const slotsInk = async dom => (await ev(dom, 'Q.correction(corrId)')).items[ev(dom, 'corrIdx')].attempts.filter(Boolean).length;

test('writing correction: offered only when something was marked wrong, with five numbered canvases, progress and completion', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb, 3); const dom = await openPage(idb, e, { active: id });
  await finishWriting(dom, []);                                                                                // everything correct
  assert.match(main(dom), /全部正確/); assert.doesNotMatch(main(dom), /寫五次/); assert.equal(ev(dom, 'Q.corrections.length'), 0);
  ev(dom, "go('practice')"); await tick();
  await finishWriting(dom, [0, 2]);                                                                            // two wrong characters
  assert.match(main(dom), /寫五次練習（2 個字）/); assert.equal(ev(dom, 'Q.corrections.length'), 1);
  const rid = ev(dom, 'res.id'), before = JSON.stringify(ev(dom, 'Q.records'));
  ev(dom, `openCorrection('corr-${rid}')`); await tick();
  assert.match(main(dom), /呢個字未寫正確，請連續寫五次/);
  const cvs = [...dom.window.document.querySelectorAll('.five canvas')]; assert.equal(cvs.length, 5);
  assert.deepEqual([...dom.window.document.querySelectorAll('.slot .no')].map(x => x.textContent), ['1', '2', '3', '4', '5']);
  const target = ev(dom, 'Q.correction(corrId).items[corrIdx]'); assert.match(main(dom), new RegExp(target.c)); assert.match(main(dom), new RegExp(target.w));
  assert.match(prog(dom), /第 1 \/ 2 個字/); assert.match(prog(dom), /這個字 0 \/ 5/); assert.match(prog(dom), /總進度 0 \/ 10/);
  assert.equal(dom.window.document.querySelector('#cnext').disabled, true);
  stroke(cvs[0]); await wait(550); assert.match(prog(dom), /這個字 1 \/ 5/); assert.equal(await slotsInk(dom), 1);
  stroke(cvs[1]); await wait(550); assert.match(prog(dom), /這個字 2 \/ 5/);
  ev(dom, 'clrSlot(0)'); await wait(60); assert.match(prog(dom), /這個字 1 \/ 5/);                                // clearing one attempt leaves the others
  const att = ev(dom, 'Q.correction(corrId).items[corrIdx].attempts'); assert.equal(att[0], null); assert.ok(att[1]);
  stroke(cvs[0]); stroke(cvs[2]); stroke(cvs[3]); await wait(550); assert.equal(dom.window.document.querySelector('#cnext').disabled, true); assert.match(prog(dom), /4 \/ 5/);
  stroke(cvs[4]); await wait(550); assert.match(prog(dom), /這個字 5 \/ 5/); assert.equal(dom.window.document.querySelector('#cnext').disabled, false);
  ev(dom, 'nextChar()'); await tick(); await tick();                                                           // second character
  assert.match(prog(dom), /第 2 \/ 2 個字/); assert.match(prog(dom), /這個字 0 \/ 5/); assert.match(prog(dom), /總進度 5 \/ 10/);
  assert.match(btns(dom).join('|'), /完成/);
  for (const c of [...dom.window.document.querySelectorAll('.five canvas')]) stroke(c);
  await wait(550); ev(dom, 'nextChar()'); await tick(); await tick(); await tick();
  assert.match(main(dom), /寫五次練習完成/); assert.match(main(dom), /10 \/ 10/);
  assert.equal(ev(dom, 'Q.correction(corrId).state'), 'done'); assert.equal(JSON.stringify(ev(dom, 'Q.records')), before);   // original results unchanged
  ev(dom, 'leaveCorr()'); await tick(); ev(dom, "go('practice')"); await tick(); assert.doesNotMatch(main(dom), /有未完成的寫五次/);
  assert.equal(ev(dom, 'Q.corrections.length'), 1);                                                            // no duplicates after revisiting
  dom.window.close();
});

test('writing correction: completed attempts survive a refresh and the activity can be resumed', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb, 3); let dom = await openPage(idb, e, { active: id });
  await finishWriting(dom, [1]); const cid = 'corr-' + ev(dom, 'res.id');
  ev(dom, `openCorrection('${cid}')`); await tick();
  const cvs = [...dom.window.document.querySelectorAll('.five canvas')]; stroke(cvs[0]); stroke(cvs[2]); stroke(cvs[4]); await wait(550);
  assert.match(prog(dom), /這個字 3 \/ 5/);
  stroke(cvs[1]);                                                                                              // a stroke still waiting for its autosave when the tab goes away
  await ev(dom, 'flushCorr()'); assert.match(prog(dom), /這個字 4 \/ 5/);
  dom.window.close();
  const e2 = env(); dom = await openPage(idb, e2, { active: id });                                             // refresh
  assert.equal(ev(dom, 'Q.corrections.length'), 1); ev(dom, "go('practice')"); await tick();
  assert.match(main(dom), /有未完成的寫五次練習/); assert.match(main(dom), /4 \/ 5/);
  ev(dom, `openCorrection('${cid}')`); await tick(); await tick();
  assert.match(prog(dom), /這個字 4 \/ 5/); assert.equal(e2.drawn.length, 4);                                   // the four saved handwritings are drawn back
  assert.equal(dom.window.document.querySelector('#cnext').disabled, true);
  stroke([...dom.window.document.querySelectorAll('.five canvas')][3]); await wait(550);
  assert.match(prog(dom), /這個字 5 \/ 5/); ev(dom, 'nextChar()'); await tick(); await tick(); await tick(); assert.match(main(dom), /寫五次練習完成/);
  dom.window.close();
});

test('writing correction: a failed save keeps the drawing, warns in Traditional Chinese and can be retried', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb, 3); const dom = await openPage(idb, e, { active: id });
  await finishWriting(dom, [0]); ev(dom, `openCorrection('corr-${ev(dom, 'res.id')}')`); await tick();
  ev(dom, 'Q.store = { ...Q.store, saveCorrection: () => Promise.reject(Object.assign(new Error("x"), { code: "quota" })) }');
  const cvs = [...dom.window.document.querySelectorAll('.five canvas')]; stroke(cvs[0]); await wait(550);
  const bar = dom.window.document.querySelector('#errbar'); assert.ok(bar && !bar.hidden); assert.match(bar.textContent, /沒有儲存成功/); assert.match(bar.textContent, /筆跡仍然保留/);
  assert.equal(ev(dom, 'cs[0].dirty'), true); assert.match(prog(dom), /這個字 0 \/ 5/);                          // not counted as completed
  ev(dom, 'Q.store = store'); ev(dom, 'retryCorr()'); await tick(); await tick();
  assert.match(prog(dom), /這個字 1 \/ 5/); assert.ok(dom.window.document.querySelector('#errbar').hidden);
  dom.window.close();
});
