/* Writing audio: automatic character -> compound word sequence, and the order of the two manual audio buttons. Real page under jsdom. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const P = require('../public/js/profiles.js'), Core = require('../public/js/core.js');
const { newIdb, CH, level } = require('./helpers');

const PUB = path.join(__dirname, '../public');
const pageHtml = () => fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/<script src="([^"]+)"><\/script>/g, (_, f) => '<script>' + fs.readFileSync(path.join(PUB, f), 'utf8') + '</script>');
const wait = ms => new Promise(r => setTimeout(r, ms)), tick = () => wait(25);
const ev = (dom, code) => dom.window.eval(code);
const ptr = { preventDefault() { }, pointerId: 1, clientX: 5, clientY: 5 };
const stroke = el => { el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 360 }); el.onpointerdown(ptr); el.onpointerup(); };

/* e.log: every speech event with a timestamp. opts: voice (zh-HK voice present), tts (speechSynthesis present), failOn (text whose speak() throws), endMs */
function env(o = {}) { return { log: [], voice: true, tts: true, failOn: null, endMs: 10, ...o }; }
function install(e) {
  return w => {
    const ctx = { fillRect() { }, beginPath() { }, moveTo() { }, lineTo() { }, stroke() { }, drawImage() { } }, C = w.HTMLCanvasElement.prototype;
    C.getContext = () => ctx; C.setPointerCapture = () => { }; let n = 0; C.toDataURL = () => 'data:image/jpeg;base64,INK' + (++n);
    if (!e.tts) return;
    w.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    w.speechSynthesis = {
      getVoices: () => (e.voice ? [{ lang: 'zh-HK', name: 'Sinji' }] : []),
      cancel() { e.log.push({ t: Date.now(), ev: 'cancel' }); },
      speak(u) { if (u.text === e.failOn) throw new Error('blocked'); e.log.push({ t: Date.now(), ev: 'start', text: u.text, lang: u.lang, voice: !!u.voice });
        setTimeout(() => { e.log.push({ t: Date.now(), ev: 'end', text: u.text }); u.onend && u.onend(); }, e.endMs); },
    };
  };
}
async function openPage(idb, e, active) {
  const dom = new JSDOM(pageHtml(), { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    w.indexedDB = idb; w.confirm = () => true; w.alert = () => { }; install(e)(w); if (active) w.sessionStorage.setItem('cq-active-profile', active); } });
  await dom.window.__cqReady; await wait(30); ev(dom, 'speechGap = 60'); return dom;
}
async function seed(idb) {
  const m = await new P.ProfileManager(idb).init(), p = await m.create({ name: '小明', avatar: 'cat' });
  const q = new Core.Quiz(await m.openStore(p.id)); await q.init();
  const chars = '左右日月火水木土金山川口手足耳目大小上下'.split('').map((c, i) => ({ id: 'c' + i, c, jp: 'jp', w: c === '左' ? '左右' : 'W' + c + c, wjp: 'x', m: '' }));
  chars[5].w = '';                                                                           // one character without a compound word
  await q.mutateLevels(ls => ls.push(level('L1', '甲', chars))); m.closeAll(); return p.id;
}
const said = e => e.log.filter(x => x.ev === 'start' && x.text !== '').map(x => x.text);   // '' = the silent iOS speech-unlock utterance
const phrase = (dom, i) => ev(dom, `Q.cur.items[${i}].w + '嘅' + Q.cur.items[${i}].c`);

test('a new writing question speaks the character, then the compound word with the character in context, in zh-HK', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, "start('write','L1','practice')"); await wait(200);
  const c = ev(dom, 'Q.cur.items[0].c'), w = ev(dom, 'Q.cur.items[0].w');
  assert.deepEqual(said(e), w ? [c, w + '嘅' + c] : [c]);
  const starts = e.log.filter(x => x.ev === 'start' && x.text !== ''); assert.ok(starts.every(x => x.lang === 'zh-HK' && x.voice));
  dom.window.close();
});
test('the sample 左 is followed by 左右嘅左, using the existing compound word', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, "start('write','L1','practice')"); await tick();
  ev(dom, "Q.cur.items[0].c = '左'; Q.cur.items[0].w = '左右'; autoKey = null; autoSpeak()"); await wait(200);
  assert.deepEqual(said(e).slice(-2), ['左', '左右嘅左']);
  dom.window.close();
});
test('the two phrases never overlap and have a pause between them', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, "start('write','L1','practice')"); await wait(250);
  const L = e.log.filter(x => x.ev !== 'cancel' && x.text !== ''), s = L.filter(x => x.ev === 'start'); assert.equal(s.length, 2);
  const endFirst = L.find(x => x.ev === 'end'); assert.ok(L.indexOf(endFirst) < L.indexOf(s[1]), 'second starts only after the first ended');
  assert.ok(s[1].t - endFirst.t >= 40, 'a pause of about speechGap separates them: ' + (s[1].t - endFirst.t));
  assert.ok(e.log.some(x => x.ev === 'cancel'));                                             // earlier speech is cancelled before a new sequence
  dom.window.close();
});
test('nothing is shown on screen and answer reveal is unchanged', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, "start('write','L1','practice')"); await wait(200);
  const d = dom.window.document; assert.equal(d.querySelector('#ans').textContent, ''); assert.ok([...d.querySelectorAll('.han')].every(x => x.textContent === ''));
  const c = ev(dom, 'Q.cur.items[0].c'); ev(dom, 'rev()'); assert.equal(d.querySelector('#ans').textContent, c); ev(dom, 'rev()'); assert.equal(d.querySelector('#ans').textContent, '');
  dom.window.close();
});
test('once per new question: rerenders, tab changes and pause/resume in the same page do not replay it; the next question does', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, "start('write','L1','practice')"); await wait(200); const n1 = said(e).length;
  for (let i = 0; i < 3; i++) { ev(dom, 'render()'); ev(dom, 'autoSpeak()'); }
  ev(dom, 'leave()'); await tick(); ev(dom, "go('levels')"); await tick(); ev(dom, "go('practice')"); await tick();
  ev(dom, 'resume(Q.cur.id)'); await wait(200); assert.equal(said(e).length, n1);
  stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await wait(250);
  assert.equal(said(e).length > n1, true); assert.equal(said(e)[n1], ev(dom, 'Q.cur.items[1].c'));
  dom.window.close();
});
test('resuming an unfinished exercise after a page reload does not speak automatically', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb); let dom = await openPage(idb, e, id);
  ev(dom, "start('write','L1','practice')"); await wait(150); stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await wait(250); dom.window.close();
  const e2 = env(); dom = await openPage(idb, e2, id); assert.equal(ev(dom, 'Q.cur.i'), 1);
  ev(dom, "go('practice')"); await tick(); ev(dom, 'resume(Q.cur.id)'); await wait(250); ev(dom, 'render()'); await wait(150);
  assert.deepEqual(said(e2), []);
  dom.window.close();
});
test('the manual buttons read only the character / only the compound word, and are in swapped positions', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, "start('write','L1','practice')"); await wait(250);
  const d = dom.window.document, b = [...d.querySelectorAll('#main .spk')];
  assert.equal(b.length, 2);
  assert.equal(b[0].textContent.trim(), '🔊 單字'); assert.equal(b[0].getAttribute('aria-label'), '單字發音'); assert.equal(b[0].getAttribute('onclick'), "say('c')");
  assert.equal(b[1].textContent.trim(), '🔊 詞語'); assert.equal(b[1].getAttribute('aria-label'), '詞語發音'); assert.equal(b[1].getAttribute('onclick'), "say('w')");
  assert.equal(b[0].className, b[1].className); assert.equal(b[0].parentElement, b[1].parentElement);
  const c = ev(dom, 'Q.cur.items[0].c'), w = ev(dom, 'Q.cur.items[0].w'), before = said(e).length;
  b[0].click(); await tick(); assert.deepEqual(said(e).slice(before), [c]);                 // character button: the character only
  const m = said(e).length; b[1].click(); await wait(150);
  if (w) assert.deepEqual(said(e).slice(m), [w]); else assert.equal(b[1].disabled, true);   // word button: the word only
  dom.window.close();
});
test('manual speech and leaving cancel a pending automatic compound word', async () => {
  const idb = newIdb(), e = env({ endMs: 5 }), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, 'speechGap = 300'); ev(dom, "start('write','L1','practice')"); await wait(60);        // first phrase done, waiting in the pause
  const c = ev(dom, 'Q.cur.items[0].c'); ev(dom, "say('c')"); await wait(450);
  assert.equal(said(e).filter(t => t === c).length, 2); assert.equal(said(e).filter(t => t.includes('嘅')).length, 0, 'the stale compound word was cancelled');
  const e2 = env({ endMs: 5 }), dom2 = await openPage(idb, e2, id); ev(dom2, 'speechGap = 300'); ev(dom2, "go('practice')"); await tick(); ev(dom2, 'resume(Q.cur.id)'); await tick();
  stroke(dom2.window.document.querySelector('#cv')); ev(dom2, 'done()'); await wait(60); ev(dom2, 'leave()'); await wait(450);
  assert.equal(said(e2).filter(t => t.includes('嘅')).length, 0);
  dom.window.close(); dom2.window.close();
});
test('no Cantonese voice, no speech support, or a failing second utterance never breaks the exercise', async () => {
  const idb = newIdb(), id = await seed(idb);
  for (const o of [{ voice: false }, { tts: false }, { failOn: '__never__' }]) {
    const e = env(o), dom = await openPage(idb, e, id);
    ev(dom, "go('practice')"); await tick(); if (!ev(dom, 'Q.cur')) ev(dom, "start('write','L1','practice')"); else ev(dom, 'resume(Q.cur.id)'); await wait(150);
    const i0 = ev(dom, 'Q.cur.i'); stroke(dom.window.document.querySelector('#cv')); ev(dom, 'done()'); await wait(150);
    assert.equal(ev(dom, 'Q.cur.i'), i0 + 1); assert.ok(dom.window.document.querySelector('#cv'));
    dom.window.close();
  }
  const e = env(); const dom = await openPage(idb, e, id); ev(dom, "go('practice')"); await tick(); ev(dom, 'resume(Q.cur.id)'); await tick();
  const w = ev(dom, 'Q.cur.items[Q.cur.i].w'); e.failOn = ev(dom, 'Q.cur.items[Q.cur.i].w + "嘅" + Q.cur.items[Q.cur.i].c'); ev(dom, 'autoKey = null; autoSpeak()'); await wait(200);
  assert.ok(dom.window.document.querySelector('#cv')); dom.window.close();
});
test('a character without a compound word is pronounced alone; reading exercises and corrections keep their behaviour', async () => {
  const idb = newIdb(), e = env(), id = await seed(idb), dom = await openPage(idb, e, id);
  ev(dom, "start('read','L1','practice')"); await wait(150); assert.deepEqual(said(e), []);            // reading: nothing spoken
  ev(dom, 'leave()'); await tick(); ev(dom, "start('write','L1','practice')"); await tick();
  await wait(200); e.log.length = 0;                                                                   // let the question's own sequence finish, then re-run it without a word
  ev(dom, "Q.cur.items[0].w = ''; autoKey = null; autoSpeak()"); await wait(200);
  assert.deepEqual(said(e), [ev(dom, 'Q.cur.items[0].c')]);
  dom.window.close();
});
