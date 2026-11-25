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
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 4000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await wait(20); };
async function seed(idb) {
  const mgr = await new P.ProfileManager(idb).init();
  await mgr.content.saveLevels([{ id: 'L1', name: '一級', desc: '', created: 1, modified: 1, chars: Array.from({ length: 22 }, (_, i) => ({ id: 'L1-' + i, c: String.fromCodePoint(0x4e00 + i), jp: '', w: 'w' + i, wjp: '', m: '' })) }]);
  const a = await mgr.create({ name: '小明', avatar: 'cat' }), b = await mgr.create({ name: '小美', avatar: 'dog' }); mgr.closeAll(); mgr.db.close(); return { a: a.id, b: b.id };
}
/* a speech service that queues utterances like a real one: plays them in order (onstart, then onend), cancel() empties the queue */
const withSpeech = dom => ev(dom, `
  window.__said = []; window.__cancel = 0; window.__timers = 0; const realST = window.setTimeout.bind(window);
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  window.speechSynthesis = { getVoices: () => [{ lang: 'zh-HK', name: 'Sinji' }], q: [], busy: false,
    cancel() { this.q.length = 0; window.__cancel++; this.gen = (this.gen || 0) + 1; this.busy = false; },
    speak(u) { window.__said.push(u.text); this.q.push(u); if (!this.busy) this.next(); },
    next() { const u = this.q.shift(); if (!u) { this.busy = false; return; } this.busy = true; const g = this.gen || 0;
      realST(() => { if ((this.gen || 0) !== g) return; u.onstart && u.onstart(); realST(() => { if ((this.gen || 0) !== g) return; u.onend && u.onend(); this.next(); }, 25); }, 0); } };`);
const said = dom => JSON.parse(ev(dom, 'JSON.stringify(window.__said)')).filter(t => t !== '');   // '' = the silent speech-unlock utterance for iOS
const story = dom => JSON.parse(ev(dom, 'JSON.stringify(Q.story(sid))'));
const chip = (dom, label) => [...doc(dom).querySelectorAll('.chips .chip')].find(b => b.textContent.includes(label));
const diffBtn = (dom, label) => [...doc(dom).querySelectorAll('.seg .seg-b')].find(b => b.textContent.trim() === label);
const sents = dom => [...doc(dom).querySelectorAll('.story .sent')];
const btn = (dom, label) => [...doc(dom).querySelectorAll('#main button')].find(b => b.textContent.includes(label));
async function generate(dom, diff, topicLabel) {
  ev(dom, "go('stories')"); await tick(); diffBtn(dom, diff).click(); await tick(); if (topicLabel) { chip(dom, topicLabel).click(); await tick(); }
  doc(dom).querySelector('#sgen').click(); await until(() => ev(dom, 'sid') !== null && sents(dom).length > 0); await tick();
}

test('page: Story Reading has its own tab with difficulty and optional topic; a new story opens in the reader and is saved as the learner\'s history, writing nothing else', async () => {
  const idb = newIdb(), id = await seed(idb), dom = await openPage(idb, id.a); withSpeech(dom);
  assert.match(doc(dom).querySelector('#nav').textContent, /故事/); assert.equal([...doc(dom).querySelectorAll('#nav button')].filter(b => b.className !== 'who').length, 7);
  ev(dom, "go('stories')"); await tick(); const t0 = doc(dom).querySelector('#main').textContent;
  assert.match(t0, /故事閱讀/); assert.match(t0, /新故事/); assert.doesNotMatch(t0, /我的故事/); assert.equal(doc(dom).querySelectorAll('.seg .seg-b').length, 3); assert.equal(doc(dom).querySelectorAll('.chips .chip').length, 15);
  assert.equal(diffBtn(dom, '初級').getAttribute('aria-pressed'), 'true', 'the suggested difficulty for a learner who knows little'); assert.equal(chip(dom, '不指定').getAttribute('aria-pressed'), 'true');
  for (const z of ['動物', '天氣', '食物', '家庭', '身體', '顏色', '數字', '交通', '學校', '自然', '屋企', '動作', '情緒', '時間']) assert.ok(chip(dom, z), z);
  diffBtn(dom, '中級').click(); await tick(); assert.equal(diffBtn(dom, '中級').getAttribute('aria-pressed'), 'true'); chip(dom, '動物').click(); await tick(); assert.equal(chip(dom, '動物').getAttribute('aria-pressed'), 'true'); assert.equal(chip(dom, '不指定').getAttribute('aria-pressed'), 'false');
  doc(dom).querySelector('#sgen').click(); await until(() => ev(dom, 'sid') !== null && sents(dom).length > 0); await tick();
  const st = story(dom); assert.equal(st.difficulty, 2); assert.equal(st.topic, 'animals'); assert.ok(st.sentences.length >= 5 && st.sentences.length <= 8); assert.ok(st.startedAt > 0); assert.equal(st.completedAt, null);
  assert.equal(doc(dom).querySelector('.stitle').textContent.includes(st.title.zh), true); assert.equal(sents(dom).length, 4, 'a page of four sentences'); assert.match(doc(dom).querySelector('.pg').textContent, /第 1 \/ 2 頁/);
  assert.equal(ev(dom, 'Q.records.length'), 0); assert.equal(ev(dom, 'Q.stats.size'), 0); assert.equal(ev(dom, 'Q.mastery.size'), 0); assert.equal(ev(dom, 'Q.sessions.length'), 0); assert.equal(ev(dom, 'Q.storyList().length'), 1);
  assert.equal(doc(dom).querySelector('#main .row .b.p') !== null, true); dom.window.close();
});

test('page: the reader is a reading page, not an exam; Jyutping and English are hidden until asked for; pages and progress; the place is kept after a reload', async () => {
  const idb = newIdb(), id = await seed(idb); let dom = await openPage(idb, id.a); withSpeech(dom);
  await generate(dom, '高級'); const st = story(dom), P = Math.ceil(st.sentences.length / 4);
  assert.ok(P >= 2 && P <= 3); const html = doc(dom).querySelector('#main').innerHTML;
  assert.doesNotMatch(html, /exam|考試/); assert.equal(doc(dom).querySelectorAll('.qopt').length, 0, 'no questions while reading');
  assert.equal(doc(dom).querySelector('.story').classList.contains('showjp'), false); assert.equal(doc(dom).querySelector('.story').classList.contains('showen'), false);
  const boxes = [...doc(dom).querySelectorAll('.sopt input[type=checkbox]')]; assert.equal(boxes.length, 2); assert.ok(boxes.every(b => !b.checked), 'both hidden by default');
  const first = st.sentences[0], w0 = first.tokens.find(t => t[1]);
  assert.ok(doc(dom).querySelector('.tk .jp').textContent.length > 0, 'the Jyutping is in the page (shown only when asked)'); assert.ok(/\.showjp \.tk \.jp\{display:block\}/.test(require('fs').readFileSync(require('path').join(__dirname, '../public/index.html'), 'utf8')));
  boxes[0].checked = true; boxes[0].dispatchEvent(new dom.window.Event('change')); await tick(); assert.equal(doc(dom).querySelector('.story').classList.contains('showjp'), true);
  assert.equal(doc(dom).querySelector('.tk .jp').textContent, w0[1]); assert.match(w0[1], /^[a-z]+[1-6]( [a-z]+[1-6])*$/);                   // the approved Jyutping of the first word, not a guess
  assert.equal([...doc(dom).querySelectorAll('.tk')].every(t => t.querySelector('.jp').textContent.split(' ').length === [...t.querySelector('.cj').textContent].length), true, 'one syllable per character');
  assert.equal(doc(dom).querySelectorAll('.pn .jp, .pn').length >= 1, true);
  const en = [...doc(dom).querySelectorAll('.sopt input[type=checkbox]')][1]; en.checked = true; en.dispatchEvent(new dom.window.Event('change')); await tick();
  assert.equal(doc(dom).querySelector('.story').classList.contains('showen'), true); assert.equal(doc(dom).querySelector('.sent .en').textContent, first.en); assert.match(doc(dom).querySelector('.stitle').textContent, new RegExp(st.title.en.split(' ')[0]));
  // pages and progress
  assert.equal(btn(dom, '上一頁').disabled, true); assert.equal(btn(dom, '我讀完了'), undefined); assert.equal(doc(dom).querySelector('.tbar i').style.width, Math.round(100 / P) + '%');
  btn(dom, '下一頁').click(); await tick(); assert.match(doc(dom).querySelector('.pg').textContent, new RegExp('第 2 / ' + P + ' 頁')); assert.equal(sents(dom)[0].dataset.i, '4'); assert.equal(btn(dom, '上一頁').disabled, false);
  assert.equal(story(dom).page, 1, 'progress is saved'); dom.window.close();
  dom = await openPage(idb, id.a); withSpeech(dom); ev(dom, "go('stories')"); await tick(); assert.match(doc(dom).querySelector('#main').textContent, /讀到第 2 \/ \d 頁/); assert.match(doc(dom).querySelector('#main').textContent, /繼續閱讀/);
  btn(dom, '繼續閱讀').click(); await tick(); await tick(); assert.match(doc(dom).querySelector('.pg').textContent, /第 2 \//); assert.equal(sents(dom)[0].dataset.i, '4', 'back on the page where the learner stopped');
  for (let k = 0; k < P - 2; k++) { btn(dom, '下一頁').click(); await tick(); } assert.ok(btn(dom, '我讀完了')); assert.equal(btn(dom, '下一頁'), undefined); dom.window.close();
});

test('page: tap a character to hear it, tap a sentence to hear it all, play the whole story back to back, stop and replay', async () => {
  const idb = newIdb(), id = await seed(idb), dom = await openPage(idb, id.a); withSpeech(dom);
  await generate(dom, '中級'); const st = story(dom); assert.equal(st.audioUsed, false);
  // a character: only that character is spoken, it is highlighted, and its word and meaning are shown
  const ch = doc(dom).querySelector('.sent .tk .ch'); const word = st.sentences[0].tokens.find(t => t[1]); const c0 = [...word[0]][0];
  const chr = [...doc(dom).querySelectorAll('.sent:first-child .ch')][0]; assert.equal(chr.textContent, c0); chr.click(); await until(() => said(dom).length >= 1);
  assert.deepEqual(said(dom), [c0]); assert.equal(chr.classList.contains('sel') || doc(dom).querySelector('.ch.sel').textContent === c0, true); assert.equal(doc(dom).querySelectorAll('.ch.sel').length, 1);
  const info = doc(dom).querySelector('#sinfo').textContent; assert.ok(info.includes(c0)); if ([...word[0]].length > 1) { assert.ok(info.includes(word[0]) && info.includes(word[1])); } assert.ok(info.includes(word[1].split(' ')[0]));
  await until(() => story(dom).audioUsed); assert.equal(story(dom).audioUsed, true, 'audio use is recorded');
  await until(() => !ev(dom, 'speechSynthesis.busy'));
  // a sentence: the whole sentence, highlighted while it is read
  const s1 = sents(dom)[1]; s1.click(); await until(() => said(dom).length >= 2); assert.equal(said(dom)[1], st.sentences[1].zh); await until(() => s1.classList.contains('playing')); assert.equal(doc(dom).querySelectorAll('.sent.playing').length, 1);
  await until(() => doc(dom).querySelectorAll('.sent.playing').length === 0); assert.equal(said(dom).length, 2, 'tapping a character did not also play the sentence');
  // replay the last sentence
  btn(dom, '重播').click(); await until(() => said(dom).length >= 3); assert.equal(said(dom)[2], st.sentences[1].zh); await until(() => !ev(dom, 'speechSynthesis.busy'));
  // the whole story: every sentence is queued at once (no timers of our own, no gaps), highlighted one after another across the pages
  ev(dom, 'window.__said.length = 0; window.__cancel = 0; window.__timers = 0; window.setTimeout = (f, ms, ...a) => { window.__timers++; return setTimeout.call(window, f, ms, ...a); };');
  const seen = []; const mo = new dom.window.MutationObserver(() => { const p = doc(dom).querySelector('.sent.playing'); if (p && seen[seen.length - 1] !== p.dataset.i) seen.push(p.dataset.i); }); mo.observe(doc(dom).querySelector('#main'), { subtree: true, attributes: true, childList: true });
  btn(dom, '播放全文').click();
  assert.equal(said(dom).length, st.sentences.length, 'all sentences were handed to the speech service in the same moment'); assert.deepEqual(said(dom), st.sentences.map(s => s.zh)); assert.equal(ev(dom, 'window.__cancel'), 1, 'one cancel at the start, none between sentences');
  assert.ok(ev(dom, 'window.__timers') <= 1, 'no timers between sentences (the only one is the test\'s own speech mock): ' + ev(dom, 'window.__timers'));
  await until(() => seen.length >= st.sentences.length && doc(dom).querySelectorAll('.sent.playing').length === 0, 6000); mo.disconnect();
  assert.deepEqual(seen, st.sentences.map((_, i) => String(i)), 'the highlight moves through every sentence in order'); assert.equal(ev(dom, 'sPage'), Math.floor((st.sentences.length - 1) / 4), 'the reader followed the story to the last page');
  // stop
  btn(dom, '播放全文').click(); await until(() => doc(dom).querySelectorAll('.sent.playing').length === 1); btn(dom, '停止').click(); await wait(150); assert.equal(doc(dom).querySelectorAll('.sent.playing').length, 0); const n = said(dom).length;
  await wait(200); assert.equal(said(dom).length, n, 'nothing more is spoken after stop'); dom.window.close();
});

test('page: without speech support or a Cantonese voice the reader still works', async () => {
  const idb = newIdb(), id = await seed(idb); let dom = await openPage(idb, id.a);                                                                     // no speechSynthesis at all
  await generate(dom, '初級'); const s = sents(dom)[0]; s.click(); await tick(); assert.match(doc(dom).querySelector('#toast').textContent, /不支援語音/); doc(dom).querySelector('.ch').click(); await tick(); btn(dom, '播放全文').click(); await tick(); btn(dom, '停止').click();
  assert.equal(ev(dom, 'sid') !== null, true); assert.equal(sents(dom).length, ev(dom, 'Q.story(sid).sentences.length')); dom.window.close();
  dom = await openPage(idb, id.a); ev(dom, "window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } }; window.__said = []; window.speechSynthesis = { getVoices: () => [], cancel() { }, speak(u) { window.__said.push(u.text); u.onstart && u.onstart(); u.onend && u.onend(); } };");
  ev(dom, "go('stories')"); await tick(); btn(dom, '繼續閱讀') ? btn(dom, '繼續閱讀').click() : btn(dom, '開始閱讀').click(); await tick(); await tick(); sents(dom)[0].click(); await tick(); assert.equal(said(dom).length, 1); assert.match(doc(dom).querySelector('#toast').textContent, /找不到廣東話語音/); dom.window.close();
});

test('page: finishing a story records the completion, the reading time and whether audio was used; comprehension questions come only afterwards, with feedback and a score', async () => {
  const idb = newIdb(), id = await seed(idb), dom = await openPage(idb, id.a); withSpeech(dom);
  await generate(dom, '初級'); const st0 = story(dom); assert.equal(st0.sentences.length <= 5, true); assert.equal(sents(dom).length, st0.sentences.length, 'a short story fits on one page');
  assert.doesNotMatch(doc(dom).querySelector('#main').textContent, /理解題/); assert.equal(doc(dom).querySelectorAll('.qopt').length, 0);
  await wait(250); btn(dom, '我讀完了').click(); await until(() => ev(dom, 'sPhase') === 'done'); await tick();
  const st = story(dom); assert.ok(st.completedAt > 0); assert.ok(st.readMs >= 150 && st.readMs < 20000, 'reading time: ' + st.readMs); assert.equal(st.audioUsed, false, 'no audio was used'); assert.equal(ev(dom, 'Q.records.length'), 0); assert.equal(ev(dom, 'Q.stats.size'), 0);
  const t = doc(dom).querySelector('#main').textContent; assert.match(t, /讀完了/); assert.match(t, /用了 \d+ (秒|分鐘)/); assert.match(t, /故事裏的新字|你都認識/); assert.ok(btn(dom, '試試理解題'));
  const completed = st.completedAt; btn(dom, '試試理解題').click(); await tick();
  const n = st.questions.length; assert.ok(n >= 2 && n <= 3); assert.match(doc(dom).querySelector('.pg').textContent, new RegExp('理解題 1 / ' + n)); assert.equal(doc(dom).querySelectorAll('.qopt').length, st.questions[0].options.length);
  btn(dom, '🔊').click(); await until(() => said(dom).length >= 1); assert.equal(said(dom)[0], st.questions[0].zh);
  let correct = 0;
  for (let i = 0; i < n; i++) {
    const q = st.questions[i], wrong = i === 0, pick = wrong ? (q.answer + 1) % q.options.length : q.answer; if (!wrong) correct++;
    assert.equal(doc(dom).querySelector('.qtext').textContent, q.zh); [...doc(dom).querySelectorAll('.qopt')][pick].click(); await tick();
    const opts = [...doc(dom).querySelectorAll('.qopt')]; assert.ok(opts.every(o => o.disabled), 'one answer per question'); assert.equal(opts[q.answer].classList.contains('right'), true);
    assert.match(doc(dom).querySelector('#main').textContent, wrong ? /再想想/ : /答對了/); if (wrong) assert.equal(opts[pick].classList.contains('wrong'), true);
    btn(dom, i + 1 < n ? '下一題' : '看分數').click(); await tick(); await tick();
  }
  assert.match(doc(dom).querySelector('#main').textContent, new RegExp(correct + ' / ' + n)); assert.deepEqual(story(dom).comprehension, { score: correct, total: n }); assert.equal(story(dom).completedAt, completed);
  assert.equal(ev(dom, 'Q.records.length'), 0, 'the comprehension quiz is not an exam'); assert.equal(ev(dom, 'Q.stats.size'), 0);
  btn(dom, '返回故事').click(); await tick(); assert.match(doc(dom).querySelector('#main').textContent, new RegExp('已讀完'));  assert.match(doc(dom).querySelector('#main').textContent, new RegExp('理解題 ' + correct + ' / ' + n)); assert.match(doc(dom).querySelector('#main').textContent, /已讀完 1 個故事/);
  btn(dom, '再讀一次').click(); await tick(); await tick(); assert.equal(ev(dom, 'sPhase'), 'read'); assert.match(doc(dom).querySelector('.pg').textContent, /第 1 \//); assert.equal(story(dom).completedAt, completed, 'reading again keeps the first completion');
  dom.window.close();
});

test('page: each learner has their own story history; it survives a reload; topic stories use the topic; other tabs are unaffected', async () => {
  const idb = newIdb(), id = await seed(idb); let dom = await openPage(idb, id.a); withSpeech(dom);
  await generate(dom, '初級', '動物'); const a1 = story(dom); assert.equal(a1.topic, 'animals'); assert.ok(a1.sentences.some(s => s.tokens.some(t => t[3] && [...'貓狗牛羊馬鳥魚兔熊雞豬蛇'].some(c => t[0].includes(c)))));
  btn(dom, '返回故事').click(); await tick(); doc(dom).querySelectorAll('.chips .chip')[0].click(); await tick(); ev(dom, 'sSel.topic = null; render()'); await tick(); doc(dom).querySelector('#sgen').click(); await until(() => ev(dom, 'sid') !== null && ev(dom, 'sid') !== a1.id); await tick();
  const a2 = story(dom); assert.equal(a2.topic, null); assert.notEqual(a2.id, a1.id); assert.ok(a2.template !== a1.template || a2.title.zh !== a1.title.zh || JSON.stringify(a2.sentences) !== JSON.stringify(a1.sentences), 'the next story is different');
  btn(dom, '返回故事').click(); await tick(); assert.equal(doc(dom).querySelectorAll('.story.card').length || doc(dom).querySelectorAll('.card.story').length, 2); dom.window.close();
  dom = await openPage(idb, id.a); ev(dom, "go('stories')"); await tick(); assert.equal(doc(dom).querySelectorAll('.card.story').length, 2, 'both stories survive a reload');
  ev(dom, 'switchLearner()'); await tick(); await ev(dom, `selectProfile('${id.b}')`); await tick(); await tick(); ev(dom, "go('stories')"); await tick();
  assert.equal(doc(dom).querySelectorAll('.card.story').length, 0, 'the other learner has none'); assert.doesNotMatch(doc(dom).querySelector('#main').textContent, /我的故事/);
  doc(dom).querySelector('#sgen').click(); await until(() => ev(dom, 'sid') !== null && sents(dom).length > 0); await tick(); const b1 = story(dom); assert.equal(ev(dom, 'Q.storyList().length'), 1); btn(dom, '返回故事').click(); await tick();
  ev(dom, 'switchLearner()'); await tick(); await ev(dom, `selectProfile('${id.a}')`); await tick(); await tick(); ev(dom, "go('stories')"); await tick(); assert.equal(doc(dom).querySelectorAll('.card.story').length, 2); assert.equal(ev(dom, `Q.story('${b1.id}')`), undefined);
  // the rest of the app is unaffected
  ev(dom, "tid = null; go('topics')"); await tick(); await tick(); await tick(); assert.equal(doc(dom).querySelectorAll('#main .card.topic').length, 14); ev(dom, "go('practice')"); await tick(); assert.equal(doc(dom).querySelectorAll('#main .card.lvl').length, 1);
  assert.equal(ev(dom, 'Q.records.length'), 0); assert.equal(ev(dom, 'Q.stats.size'), 0); dom.window.close();
});
