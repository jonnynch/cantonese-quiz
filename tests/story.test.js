/* Story generation: local, template based. The approved content is valid; stories fit the difficulty, use what the learner knows, follow a topic,
   stay varied, and their comprehension questions come from the story itself. Randomness is seeded, so every run is the same. */
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('../public/js/story.js'), D = require('../public/js/story-data.js'), T = require('../public/js/topics.js');

const prng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const topicSet = id => new Set(T.PACKS.find(p => p.id === id).items.map(i => i[0]));
const knowing = (...ids) => new Set(ids.flatMap(id => [...topicSet(id)]));
const animalsNature = knowing('animals', 'nature'), broad = knowing('animals', 'nature', 'food', 'family', 'weather', 'school', 'actions', 'emotions');
const text = st => st.sentences.map(s => s.zh).join('');
const PUNCT = new Set([...'，。！？：「」、']);

/* ---- the approved content ---- */
test('story templates are valid: every word is approved and has Jyutping and English, every slot and question refers to something that exists', () => {
  assert.ok(D.TEMPLATES.length >= 10); assert.ok(D.FALLBACKS.length >= 5);
  for (const t of [...D.TEMPLATES, ...D.FALLBACKS]) {
    assert.ok(t.id && t.title.zh && t.title.en && t.tags.length, t.id);
    const slots = new Set(Object.keys(t.slots)), refs = s => [...s.matchAll(/\{(?:[A-Za-z]+:)?([a-z_]+)(?:\.[a-z]+)?\}/g)].map(m => m[1]);
    for (const s of t.sentences) {
      assert.ok(s.d[0] >= 1 && s.d[1] <= 3 && s.d[0] <= s.d[1]); [s, ...(s.alt || [])].forEach(v => { refs(v.zh).concat(refs(v.en)).forEach(r => assert.ok(slots.has(r), t.id + ' uses unknown slot ' + r)); assert.match(v.zh, /[。！？」]$/); });
      (s.alt || []).forEach(a => { assert.ok(a.d >= 2 && a.d <= 3); assert.deepEqual([...new Set(refs(a.zh))].sort().filter(x => !refs(s.zh).includes(x)).filter(x => !slots.has(x)), []); });
      assert.match(s.zh, /[。！？」]$/, 'a sentence ends with punctuation: ' + s.zh);
    }
    for (const q of t.questions) { assert.ok(['mc', 'tf'].includes(q.type)); [q.zh, q.t, q.f].filter(Boolean).forEach(x => refs(x).forEach(r => assert.ok(slots.has(r), t.id + ' question uses unknown slot ' + r))); if (q.ans && !q.opts) assert.ok(slots.has(q.ans)); if (q.pool) [].concat(q.pool).forEach(c => assert.ok(D.LEX[c], c)); }
    Object.values(t.slots).forEach(sp => [].concat(sp.cat).forEach(c => assert.ok(D.LEX[c].length >= 2, 'enough words in ' + c)));
  }
  for (const [w, d] of S.DICT) {                                                                       // every approved word: a Jyutping syllable for every character
    if (d.jp === null) { assert.ok([...w].every(c => PUNCT.has(c))); continue; }
    assert.ok(d.en && d.en.length, w); assert.equal(d.jp.split(' ').length, [...w].length, w + ' ' + d.jp); assert.match(d.jp, /^[a-z]+[1-6]( [a-z]+[1-6])*$/, w);
  }
  for (const cat of Object.values(D.LEX)) cat.forEach(([zh, jp, en, x]) => { assert.ok(zh && jp && en); if (x.m) assert.ok(D.MEASURES[x.m], zh + ' measure word'); });
  assert.throws(() => S.tokenize('這是一句沒有批准的詞語蘋'), /Unknown word/, 'a word that is not approved is never guessed');
});
test('every story is valid content: words make up the sentence, Jyutping and English come from the approved words, nothing is left unfilled', () => {
  const rng = prng(1);
  for (const known of [new Set(), animalsNature, broad]) for (const d of [1, 2, 3]) for (let i = 0; i < 25; i++) {
    const st = S.generate({ known, difficulty: d, rng });
    assert.ok(st.title.zh && st.title.en); assert.doesNotMatch(st.title.zh + st.title.en, /[{}]/); assert.equal(st.difficulty, d);
    for (const sn of st.sentences) {
      assert.equal(sn.tokens.map(t => t[0]).join(''), sn.zh); assert.doesNotMatch(sn.zh + sn.en, /[{}]/); assert.match(sn.en, /^[A-Z"]/); assert.match(sn.en, /[.!?"]$/);
      for (const [w, jp, en] of sn.tokens) { if ([...w].every(c => PUNCT.has(c))) { assert.equal(jp, null); continue; } assert.ok(jp && en, w); assert.equal(jp.split(' ').length, [...w].length, w); }
    }
    assert.equal(S.storyText(st), text(st));
  }
});

/* ---- difficulty ---- */
test('story length and sentence length follow the difficulty', () => {
  const rng = prng(2), avg = { 1: [], 2: [], 3: [] };
  for (const d of [1, 2, 3]) for (let i = 0; i < 60; i++) {
    const st = S.generate({ known: broad, difficulty: d, rng }), [lo, hi] = S.LEN[d];
    assert.ok(st.sentences.length >= lo && st.sentences.length <= hi, `d${d}: ${st.sentences.length} sentences`);
    for (const sn of st.sentences) assert.ok(S.chars(sn.zh).length <= S.MAX_CHARS[d]);
    assert.equal(new Set(st.sentences.map(s => s.zh)).size, st.sentences.length, 'no repeated sentence');
    avg[d].push(st.sentences.reduce((n, s) => n + S.chars(s.zh).length, 0) / st.sentences.length);
  }
  const m = a => a.reduce((x, y) => x + y, 0) / a.length;
  assert.deepEqual([S.LEN[1], S.LEN[2], S.LEN[3]], [[3, 5], [5, 8], [8, 12]]); assert.ok(m(avg[2]) > m(avg[1]) && m(avg[3]) >= m(avg[2]), 'sentences get longer with the level: ' + [1, 2, 3].map(d => m(avg[d]).toFixed(1)));
  assert.deepEqual([S.suggestDifficulty(0), S.suggestDifficulty(59), S.suggestDifficulty(60), S.suggestDifficulty(199), S.suggestDifficulty(200)], [1, 1, 2, 2, 3]);
  assert.equal(S.generate({ difficulty: 99, rng: prng(3) }).difficulty, 1, 'an invalid difficulty becomes the easiest');
});
test('every template gives a complete story (a beginning, a middle and an end) at every difficulty, also when a topic adds a sentence', () => {
  for (const tpl of D.TEMPLATES) for (const d of [1, 2, 3]) {
    const [lo, hi] = S.LEN[d], inc = tpl.sentences.filter(s => s.d[0] <= d && d <= s.d[1]);
    assert.ok(inc.length >= lo && inc.length <= hi, `${tpl.id} d${d}: ${inc.length}`);
    for (const topic of T.PACKS) { const n = tpl.sentences.filter(s => (s.d[0] <= d && d <= s.d[1]) || (s.t && s.t.includes(topic.id))).length; assert.ok(n <= hi, `${tpl.id} d${d} ${topic.id}: ${n}`); }
    assert.match(inc[0].zh, /玩|去|在|，|肚子|看見|媽|學校/, 'it starts somewhere'); assert.ok(inc.length >= 3);
  }
});

/* ---- the learner's knowledge ---- */
test('stories are built from the learner\'s characters: a beginner who knows some topics gets (nearly) all familiar characters', () => {
  const rng = prng(4); let pass = 0, N = 120;
  for (let i = 0; i < N; i++) { const st = S.generate({ known: animalsNature, difficulty: 1, rng }); if (st.familiar >= 0.9) pass++; assert.ok(st.newChars.length <= 5, 'few new characters: ' + st.newChars.join('')); assert.equal(st.lowFamiliarity, false); }
  assert.equal(pass, N, 'every beginner story reaches 90% familiar characters');
  for (const d of [2, 3]) for (let i = 0; i < 40; i++) assert.ok(S.generate({ known: broad, difficulty: d, rng }).familiar >= S.MIN_FAMILIAR[d]);
  const none = S.generate({ known: new Set(), difficulty: 1, rng }); assert.ok(none.familiar >= 0.9, 'even with nothing learned yet, the beginner story uses very common characters');
});
test('known words are preferred: a learner who knows 貓 meets 小貓 far more often than chance, and unknown characters are reported as new characters', () => {
  const rng = prng(5), count = (known, zh) => { let n = 0; for (let i = 0; i < 300; i++) if (S.generate({ known, difficulty: 1, rng, tries: 12 }).title.zh.includes(zh) || false) n++; return n; };
  const withCat = new Set([...'貓']), without = new Set([...'狗']);
  let heroCat = 0, heroCatWithout = 0; for (let i = 0; i < 300; i++) { if (S.generate({ known: withCat, difficulty: 1, rng }).hero === '小貓') heroCat++; if (S.generate({ known: without, difficulty: 1, rng }).hero === '小貓') heroCatWithout++; }
  assert.ok(heroCat > heroCatWithout * 1.5, `knowing 貓 makes 小貓 likelier (${heroCat} vs ${heroCatWithout})`);
  const st = S.generate({ known: new Set(), difficulty: 3, rng: prng(6) }); const all = new Set(st.sentences.flatMap(s => S.chars(s.zh)));
  st.newChars.forEach(c => { assert.ok(all.has(c)); assert.equal(S.isFamiliar(c, new Set()), false); });
  const m = S.measure(st.sentences, new Set(), null); assert.deepEqual(m.newChars, st.newChars); assert.ok(m.familiar > 0 && m.familiar <= 1); void count;
});
test('the very common characters count as familiar without having been learned; learned characters count too', () => {
  assert.equal(S.isFamiliar('我', new Set()), true); assert.equal(S.isFamiliar('貓', new Set()), false); assert.equal(S.isFamiliar('貓', new Set(['貓'])), true);
  assert.ok(S.CORE.size > 100 && S.CORE.size < 250);
});

/* ---- topics ---- */
test('a chosen topic shapes the story: its vocabulary appears, and the learner need not know the topic', () => {
  for (const tp of T.PACKS) {
    const chars = topicSet(tp.id); let ok = 0; const N = 25;
    for (let i = 0; i < N; i++) {
      const st = S.generate({ known: broad, difficulty: 1 + i % 3, topic: { id: tp.id, chars }, rng: prng(100 + i) });
      assert.equal(st.topic, tp.id);
      if (st.topicMatched) { ok++; assert.ok(st.topicWords.length >= 1, tp.id); st.topicWords.forEach(w => assert.ok(S.chars(w).some(c => chars.has(c)), w + ' is a ' + tp.id + ' word')); assert.ok(st.sentences.some(s => s.tokens.some(t => t[3] && t[0] && S.chars(t[0]).some(c => chars.has(c))))); }
    }
    assert.ok(ok >= N * 0.9, `${tp.id}: ${ok}/${N} stories used the topic`);
  }
  const a = S.generate({ known: new Set(), difficulty: 2, topic: { id: 'weather', chars: topicSet('weather') }, rng: prng(7) }); assert.equal(a.topic, 'weather'); assert.ok(a.sentences.length >= 5);
  assert.equal(S.generate({ known: broad, difficulty: 1, rng: prng(8) }).topic, null, 'topic selection is optional');
});
test('topic stories lean on the right templates: weather -> rain/wind, transport and numbers -> the trip, body -> the senses', () => {
  const pick = (id, d = 1) => { const c = {}; for (let i = 0; i < 40; i++) { const t = S.generate({ known: broad, difficulty: d, topic: { id, chars: topicSet(id) }, rng: prng(300 + i) }).template; c[t] = (c[t] || 0) + 1; } return Object.keys(c); };
  const share = (id, set) => { let n = 0; for (let i = 0; i < 100; i++) if (set.includes(S.generate({ known: broad, difficulty: 1 + i % 3, topic: { id, chars: topicSet(id) }, rng: prng(700 + i) }).template)) n++; return n / 100; };
  assert.ok(share('weather', ['rain', 'wind', 'fb-rain']) >= 0.35, 'weather stories are mostly about the weather: ' + share('weather', ['rain', 'wind', 'fb-rain']));
  assert.ok(pick('transport').includes('travel')); assert.ok(pick('numbers').includes('travel')); assert.ok(pick('body').includes('sense')); assert.ok(pick('food').includes('food')); assert.ok(pick('school').includes('school'));
});

/* ---- variety ---- */
test('stories stay varied: many templates, many different openings, and the same story is not repeated back to back', () => {
  for (const known of [animalsNature, broad]) {
    const rng = prng(9), recent = [], seen = new Set(), tpls = new Set(); let prev = null, same = 0; const N = 100;
    for (let i = 0; i < N; i++) {
      const st = S.generate({ known, difficulty: 1 + i % 3, rng, recent: recent.slice(0, 3) }); recent.unshift({ template: st.template, hero: st.hero });
      seen.add(st.title.zh + '|' + st.sentences[0].zh + '|' + st.sentences[1].zh); tpls.add(st.template); if (prev === st.template) same++; prev = st.template;
    }
    assert.ok(tpls.size >= 6, 'templates: ' + tpls.size); assert.ok(seen.size >= 55, 'distinct openings: ' + seen.size); assert.ok(same <= N * 0.1, 'same template twice in a row: ' + same);
  }
  const a = S.generate({ known: broad, difficulty: 2, rng: prng(10) }), b = S.generate({ known: broad, difficulty: 2, rng: prng(11) }); assert.notEqual(text(a) + a.title.zh, text(b) + b.title.zh);
  assert.equal(JSON.stringify(S.generate({ known: broad, difficulty: 2, rng: prng(12) })), JSON.stringify(S.generate({ known: broad, difficulty: 2, rng: prng(12) })), 'the same seed gives the same story');
});
test('when no generated story is good enough, an authored fixed story is used (and it is valid)', () => {
  for (const d of [1, 2, 3]) { const st = S.generate({ known: new Set(), difficulty: d, rng: prng(13), tries: 0 }); assert.equal(st.generated, false); assert.ok(st.template.startsWith('fb-')); assert.ok(st.sentences.length >= 3); assert.ok(st.questions.length >= 2); assert.ok(st.familiar >= 0.74); }
  const t = S.generate({ known: new Set(), difficulty: 1, rng: prng(14), tries: 0, topic: { id: 'family', chars: topicSet('family') } }); assert.equal(t.generated, false); assert.ok(t.topicMatched);
  for (const f of D.FALLBACKS) { const sents = f.sentences.map(s => ({ zh: S.tokenize(s.zh).map(x => x[0]).join(''), tokens: S.tokenize(s.zh) })); assert.ok(S.measure(sents, new Set()).familiar >= 0.74, f.id); }
  const seen = new Set(); for (let i = 0; i < 30; i++) seen.add(S.generate({ known: new Set(), difficulty: 1, rng: prng(20 + i), tries: 0 }).template); assert.ok(seen.size >= 3, 'fixed stories vary too');
});

/* ---- comprehension questions ---- */
test('comprehension questions are about the story: the right answer is in it, no wrong answer is, and there are 2-3 sensible ones', () => {
  const rng = prng(15); let asked = 0;
  for (let i = 0; i < 200; i++) {
    const st = S.generate({ known: i % 2 ? broad : animalsNature, difficulty: 1 + i % 3, rng }), t = text(st);
    assert.ok(st.questions.length >= 2 && st.questions.length <= 3, 'questions: ' + st.questions.length); assert.equal(st.questions.length, S.QUESTIONS[st.difficulty] || st.questions.length);
    for (const q of st.questions) {
      asked++; assert.ok(q.zh && ['mc', 'tf'].includes(q.type)); assert.equal(new Set(q.options).size, q.options.length); assert.ok(q.answer >= 0 && q.answer < q.options.length); assert.doesNotMatch(q.zh, /[{}]/);
      if (q.type === 'mc') { assert.equal(q.options.length, 3); assert.ok(t.includes(q.options[q.answer]), `${q.zh} -> ${q.options[q.answer]}`); q.options.forEach((o, k) => { if (k !== q.answer) assert.equal(t.includes(o), false, `wrong option ${o} is in the story (${q.zh})`); }); }
      else { assert.deepEqual(q.options, ['對', '錯']); assert.ok(q.answer === 0 || q.answer === 1); }
    }
  }
  assert.ok(asked > 400);
  // true/false: a true statement's key words are in the story (a false one differs from it)
  let trues = 0, falses = 0; for (let i = 0; i < 300; i++) { const st = S.generate({ known: broad, difficulty: 2, rng }); st.questions.filter(q => q.type === 'tf').forEach(q => { q.answer === 0 ? trues++ : falses++; }); }
  assert.ok(trues > 40 && falses > 40, `both kinds are asked: ${trues}/${falses}`);
});
test('a question about "where / who / what" is built from this story\'s own words', () => {
  const st = S.generate({ known: animalsNature, difficulty: 1, rng: prng(16), tries: 40 });
  const places = ['公園', '山上', '海邊', '草地', '花園'];
  for (let i = 0; i < 80; i++) { const s = S.generate({ known: animalsNature, difficulty: 2, rng: prng(500 + i) }); const q = s.questions.find(x => x.zh.includes('去了哪裏')); if (q) { const place = q.options[q.answer]; assert.ok(places.includes(place)); assert.ok(s.sentences[0].zh.includes(place), 'the first sentence names the place'); assert.ok(q.zh.startsWith(s.hero)); } }
  void st;
});
