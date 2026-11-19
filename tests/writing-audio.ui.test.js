/* Writing audio: ONE automatic utterance "character。word嘅character", and the order of the two manual audio buttons. Real page under jsdom. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const P = require('../public/js/profiles.js'), Core = require('../public/js/core.js');
const { newIdb, CH, level } = require('./helpers');

const PUB = path.join(__dirname, '../public');
const pageHtml = () => fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/<script src="([^"]+)"><\/script>/g, (_, f) => '<script>' + fs.readFileSync(path.join(PUB, f), 'utf8') + '</script>');
const wait = ms => new Promise(r => setTimeout(r, ms)), tick = () => wait(60);
const ev = (dom, code) => dom.window.eval(code);
const ptr = { preventDefault() { }, pointerId: 1, clientX: 5, clientY: 5 };
const stroke = el => { el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 360 }); el.onpointerdown(ptr); el.onpointerup(); };

/* e.log: every speak() call. opts: voice (zh-HK voice present), tts (speechSynthesis present), failOn (text whose speak() throws) */
function env(o = {}) { return { log: [], voice: true, tts: true, failOn: null, ...o }; }
function install(e) {
  return w => {
    const ctx = { fillRect() { }, beginPath() { }, moveTo() { }, lineTo() { }, stroke() { }, drawImage() { } }, C = w.HTMLCanvasElement.prototype;
    C.getContext = () => ctx; C.setPointerCapture = () => { }; let n = 0; C.toDataURL = () => 'data:image/jpeg;base64,INK' + (++n);
    if (!e.tts) return;
    w.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    w.speechSynthesis = {
      getVoices: () => (e.voice ? [{ lang: 'zh-HK', name: 'Sinji' }] : []),
      cancel() { e.log.push({ ev: 'cancel' }); },
      speak(u) { if (u.text === e.failOn) throw new Error('blocked'); e.log.push({ ev: 'start', text: u.text, lang: u.lang, rate: u.rate, voice: !!u.voice, hasEndHandler: !!u.onend }); },
    };
  };
}
async function openPage(idb, e, active) {
  const dom = new JSDOM(pageHtml(), { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    w.indexedDB = idb; w.confirm = () => true; w.alert = () => { }; install(e)(w); if (active) w.sessionStorage.setItem('cq-active-profile', active); } });
  await dom.window.__cqReady; await wait(30); return dom;
}
async function seed(idb) {
  const m = await new P.ProfileManager(idb).init(), p = await m.create({ name: '小明', avatar: 'cat' });
  const q = new Core.Quiz(await m.openStore(p.id)); await q.init();
  const chars = '左右日月火水木土金山川口手足耳目大小上下'.split('').map((c, i) => ({ id: 'c' + i, c, jp: 'jp', w: c === '左' ? '左右' : 'W' + c + c, wjp: 'x', m: '' }));
  await q.mutateLevels(ls => ls.push(level('L1', '甲', chars))); m.closeAll(); return p.id;
}
const starts = e => e.log.filter(x => x.ev === 'start' && x.text !== '');                   // '' = the silent iOS speech-unlock utterance
const said = e => starts(e).map(x => x.text);
const full = (dom, i) => ev(dom, `Q.cur.items[${i}].c + '。' + Q.cur.items[${i}].w + '嘅' + Q.cur.items[${i}].c`);

test('a normal writing question submits exactly ONE utterance: character。word嘅character, zh-HK, voice and rate kept', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, "start('write','L1','practice')"); await wait(150);
  assert.equal(starts(e).length, 1); assert.deepEqual(said(e), [full(dom, 0)]);
  const u = starts(e)[0]; assert.equal(u.lang, 'zh-HK'); assert.equal(u.voice, true); assert.equal(u.rate, 0.8); assert.equal(u.hasEndHandler, false, 'no onend chaining');
  assert.ok(said(e)[0].startsWith(ev(dom, 'Q.cur.items[0].c') + '。'));                       // order: the character first, then the word in context
  dom.window.close();
});
test('the sample 左 is spoken as 左。左右嘅左 using the existing compound word', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, "start('write','L1','practice')"); await tick();
  ev(dom, "Q.cur.items[0].c = '左'; Q.cur.items[0].w = '左右'; autoKey = null; autoSpeak()"); await tick();
  assert.equal(said(e).at(-1), '左。左右嘅左'); assert.equal(starts(e).filter(x => x.text === '左。左右嘅左').length, 1);
  dom.window.close();
});
test('without a valid compound word only the target character is spoken', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, "start('write','L1','practice')"); await tick(); e.log.length = 0;
  for (const w of ['', undefined, null, ev(dom, 'Q.cur.items[0].c')]) {                      // missing, or the character itself: not a compound word
    ev(dom, 'Q.cur.items[0].w = ' + JSON.stringify(w === undefined ? null : w) + '; autoKey = null; autoSpeak()'); await tick();
  }
  assert.deepEqual(said(e), Array(4).fill(ev(dom, 'Q.cur.items[0].c')));
  dom.window.close();
});
test('there is no second utterance and no timer in the automatic pronunciation', async () => {
  const src = fs.readFileSync(path.join(PUB, 'js/app.js'), 'utf8');
  assert.ok(!/speakSeq|speechGap|gapTimer|setTimeout\(go|\b4000\b/.test(src));
  const idb = newIdb(), e = env(), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, "start('write','L1','practice')"); await wait(600); assert.equal(starts(e).length, 1, 'nothing is spoken later');
  dom.window.close();
});
test('nothing is shown on screen and answer reveal is unchanged', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, "start('write','L1','practice')"); await tick();
  const d = dom.window.document; assert.equal(d.querySelector('#ans').textContent, ''); assert.ok([...d.querySelectorAll('.han')].every(x => x.textContent === ''));
  const c = ev(dom, 'Q.cur.items[0].c'); ev(dom, 'rev()'); assert.equal(d.querySelector('#ans').textContent, c); ev(dom, 'rev()'); assert.equal(d.querySelector('#ans').textContent, '');
  dom.window.close();
});
test('no repeat on rerender, tab change or pause/resume; a new question speaks again', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, "start('write','L1','practice')"); await tick(); assert.equal(starts(e).length, 1);
  for (let i = 0; i < 3; i++) { ev(dom, 'render()'); ev(dom, 'autoSpeak()'); }
  ev(dom, 'leave()'); await tick(); ev(dom, "go('levels')"); await tick(); ev(dom, "go('practice')"); await tick();
  ev(dom, 'resume(Q.cur.id)'); await tick(); ev(dom, 'render()'); await tick(); assert.equal(starts(e).length, 1);
  stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await wait(80);
  assert.equal(starts(e).length, 2); assert.equal(said(e)[1], full(dom, 1));                   // the next question speaks once, with its own data
  ev(dom, 'render()'); await tick(); assert.equal(starts(e).length, 2);
  dom.window.close();
});
test('resuming an unfinished exercise after a page reload does not speak automatically', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb); let dom = await openPage(idb, e, id);
  ev(dom, "start('write','L1','practice')"); await tick(); stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await wait(80); dom.window.close();
  const e2 = env(); dom = await openPage(idb, e2, id); assert.equal(ev(dom, 'Q.cur.i'), 1);
  ev(dom, "go('practice')"); await tick(); ev(dom, 'resume(Q.cur.id)'); await wait(80); ev(dom, 'render()'); await tick();
  assert.deepEqual(said(e2), []);
  dom.window.close();
});
test('writing exams and revisions use the same single utterance; reading stays silent', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, "start('read','L1','practice')"); await tick(); assert.deepEqual(said(e), []); ev(dom, 'leave()'); await tick();
  ev(dom, "go('exam')"); await tick(); ev(dom, "start('write','L1','exam')"); await tick();
  assert.equal(starts(e).length, 1); assert.deepEqual(said(e), [full(dom, 0)]); ev(dom, 'leave()'); await tick();
  ev(dom, "Q.startSession({ kind: 'write', levelId: 'L1', mode: 'revision', parentId: 'p1', chars: Q.level('L1').chars.slice(0, 3) }).then(() => { inS = true; render(); autoSpeak(); })"); await wait(80);
  assert.equal(starts(e).length, 2); assert.equal(said(e)[1], full(dom, 0)); assert.equal(ev(dom, 'Q.cur.mode'), 'revision');
  dom.window.close();
});
test('the manual buttons keep their actions and are in swapped positions: character first, word second', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, "start('write','L1','practice')"); await tick();
  const b = [...dom.window.document.querySelectorAll('#main .spk')]; assert.equal(b.length, 2);
  assert.equal(b[0].getAttribute('onclick'), "say('c')"); assert.equal(b[0].getAttribute('aria-label'), '單字發音'); assert.equal(b[1].getAttribute('onclick'), "say('w')"); assert.equal(b[1].getAttribute('aria-label'), '詞語發音');
  const c = ev(dom, 'Q.cur.items[0].c'), w = ev(dom, 'Q.cur.items[0].w');
  b[0].click(); assert.equal(said(e).at(-1), c); b[1].click(); assert.equal(said(e).at(-1), w);
  dom.window.close();
});
test('a missing Cantonese voice, missing speech support or a failing speak() never breaks the exercise', async () => {
  const idb = newIdb(), id = await seed(idb);
  for (const o of [{ voice: false }, { tts: false }, { failOn: 'ANY' }]) {
    const e = env(o), dom = await openPage(idb, e, id);
    if (o.failOn) e.failOn = null;
    ev(dom, "go('practice')"); await tick(); if (!ev(dom, 'Q.cur')) ev(dom, "start('write','L1','practice')"); else ev(dom, 'resume(Q.cur.id)'); await tick();
    if (o.failOn) { e.failOn = ev(dom, 'autoText(Q.cur.items[Q.cur.i])'); ev(dom, 'autoKey = null; autoSpeak()'); await tick(); }
    const i0 = ev(dom, 'Q.cur.i'); stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await wait(80);
    assert.equal(ev(dom, 'Q.cur.i'), i0 + 1); assert.ok(dom.window.document.querySelector('#cv'));
    if (o.voice === false) assert.equal(starts(e).every(x => x.voice === false && x.lang === 'zh-HK'), true);   // still speaks, with the default voice
    dom.window.close();
  }
});
