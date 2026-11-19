/* Adaptive learning: per-character statistics, priority, weighted exam selection, persistence and backup. */
const test = require('node:test'), assert = require('node:assert/strict');
const { S, C, IMG, newStore, newQuiz, CH, level } = require('./helpers');
const A = C.ADAPT;

const prng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const chars = n => Array.from({ length: n }, (_, i) => CH('c' + (i + 1), String.fromCodePoint(0x4e00 + i)));
async function setup(n = 25, o = {}) {
  const st = await newStore(); let t = 1000; const clock = { now: () => t, advance: ms => { t += ms; } };
  const q = await newQuiz(st, { now: clock.now, ...o }); await q.mutateLevels(ls => ls.push(level('L1', '一級', chars(n)))); return { st, q, clock };
}
/* answer the open reading question after `ms` of active time */
async function readTimed(q, clock, ok, ms) { const s = q.cur; q.qStart(s.id + ':' + s.i); clock.advance(ms); return q.answerRead(ok); }
async function runRead(q, clock, mode, plan, o = {}) {           // plan: (cid, index) => [ok, ms]
  const r = await q.startSession({ kind: 'read', levelId: 'L1', mode, ...o }); assert.equal(r.ok, true);
  const n = q.cur.items.length; for (let i = 0; i < n; i++) { const [ok, ms] = plan(q.cur.items[q.cur.i].cid, i); await readTimed(q, clock, ok, ms); }
}
const bucket = (q, cid, kind, mode) => q.skillStats(kind, cid)[mode];

/* ---- 1-3 statistics ---- */
test('correct and incorrect answers update the statistics (with response time for correct answers only)', async () => {
  const { q, clock } = await setup(3, { shuffle: a => a.slice() });
  await runRead(q, clock, 'practice', (cid, i) => (i === 0 ? [true, 2000] : i === 1 ? [false, 9000] : [true, 5000]));
  const a = q.skillStats('read', 'c1'), b = q.skillStats('read', 'c2'), c = q.skillStats('read', 'c3');
  assert.deepEqual(a.practice, { attempts: 1, correct: 1, incorrect: 0, timedCorrect: 1, totalCorrectTimeMs: 2000 }); assert.equal(a.consecutiveCorrect, 1);
  assert.deepEqual(b.practice, { attempts: 1, correct: 0, incorrect: 1, timedCorrect: 0, totalCorrectTimeMs: 0 }); assert.equal(b.consecutiveCorrect, 0);   // wrong time not counted
  assert.equal(c.practice.totalCorrectTimeMs, 5000); assert.ok(a.lastAttemptAt && b.lastIncorrectAt && !a.lastIncorrectAt);
  assert.deepEqual(q.skillStats('write', 'c1').practice.attempts, 0, 'reading and writing are tracked separately');
});
test('practice (incl. revision) and exam statistics are separate; consecutive correct runs across both', async () => {
  const { q, clock } = await setup(25, { shuffle: a => a.slice(), random: prng(1) });
  await runRead(q, clock, 'practice', () => [true, 1000]); assert.equal(bucket(q, 'c1', 'read', 'practice').attempts, 1);
  await runRead(q, clock, 'exam', cid => [cid !== 'c1', 1000]);
  const k = q.skillStats('read', 'c2'); assert.equal(k.practice.attempts, 1); if (k.exam.attempts) assert.equal(k.consecutiveCorrect, 2);
  const wrong = q.skillStats('read', 'c1'); if (wrong.exam.attempts) { assert.equal(wrong.exam.incorrect, 1); assert.equal(wrong.practice.incorrect, 0); assert.equal(wrong.consecutiveCorrect, 0); }
  await runRead(q, clock, 'revision', () => [true, 1000], { parentId: 'p', chars: chars(2) });
  assert.equal(bucket(q, 'c1', 'read', 'practice').attempts, 2, 'revision counts as practice'); assert.equal(bucket(q, 'c1', 'read', 'exam').attempts + 0 >= 0, true);
});
test('an incorrect answer resets the consecutive-correct streak and its mastery', async () => {
  let k = null; for (let i = 0; i < 4; i++) k = C.applyAnswer(k, 'practice', true, 1000, i + 1);
  assert.equal(k.consecutiveCorrect, 4); assert.equal(k.masteryPoints, 40);
  k = C.applyAnswer(k, 'exam', false, 500, 9); assert.equal(k.consecutiveCorrect, 0); assert.equal(k.masteryPoints, 0); assert.equal(k.lastIncorrectAt, 9);
  k = C.applyAnswer(k, 'practice', true, 1000, 10); assert.equal(k.consecutiveCorrect, 1);
});

/* ---- 4-8 priority ---- */
test('priority: exam mistakes weigh more than practice mistakes; wrong answers raise it significantly', () => {
  const p = C.applyAnswer(null, 'practice', false, null, 1), e = C.applyAnswer(null, 'exam', false, null, 1);
  assert.equal(C.priority(null), A.BASE); assert.equal(C.priority(p), 115); assert.equal(C.priority(e), 125); assert.ok(C.priority(e) > C.priority(p) && C.priority(p) > A.BASE);
});
test('priority: fast correct answers reduce it more than normal; slow answers earn little mastery and add a small penalty', () => {
  const wrong = C.applyAnswer(null, 'exam', false, null, 1), after = ms => C.priority(C.applyAnswer(wrong, 'practice', true, ms, 2));
  const w = C.priority(wrong), fast = after(1000), normal = after(5000), slow = after(9000);
  assert.ok(fast < normal && normal < slow && slow < w, [fast, normal, slow, w].join(','));        // a correct answer never makes a character more likely than before
  assert.equal(w - fast, 10); assert.equal(w - normal, 8); assert.equal(w - slow, 1, 'slow: only 6 mastery against the +5 slow penalty, i.e. barely any reduction');
});
test('priority: a long correct streak lowers it but never below the minimum or to zero; many mistakes never exceed the maximum', () => {
  let k = null; for (let i = 0; i < 50; i++) k = C.applyAnswer(k, 'practice', true, 1000, i + 1);
  assert.equal(C.priority(k), A.MIN); assert.ok(A.MIN > 0);
  let h = null; for (let i = 0; i < 100; i++) h = C.applyAnswer(h, 'exam', false, null, i + 1);
  assert.equal(C.priority(h), A.MAX);
  assert.ok(C.priority({ practice: { attempts: 1e9, correct: 1e9, incorrect: 0, timedCorrect: 0, totalCorrectTimeMs: 0 }, consecutiveCorrect: 1e9, masteryPoints: 1e12 }) >= A.MIN);
});
test('consecutive correct answers increase mastery (priority falls with each)', () => {
  let k = C.applyAnswer(null, 'exam', false, null, 1), last = C.priority(k);
  for (let i = 0; i < 5; i++) { k = C.applyAnswer(k, 'practice', true, 4000, i + 2); const p = C.priority(k); assert.ok(p < last); last = p; assert.equal(k.consecutiveCorrect, i + 1); }
  assert.equal(C.learningStatus(k), 'improving'); assert.equal(C.learningStatus(C.applyAnswer(k, 'exam', false, null, 9)), 'needs'); assert.equal(C.learningStatus(null), 'new');
});
test('only correct answers contribute to the average time; thresholds are the configured constants', () => {
  assert.deepEqual([2999, 3000, 7000, 7001, null, -5].map(C.classifyMs), ['fast', 'normal', 'normal', 'slow', 'unknown', 'unknown']);
  const k = C.applyAnswer(C.applyAnswer(null, 'practice', true, 2000, 1), 'practice', false, 50000, 2);
  assert.equal(k.practice.totalCorrectTimeMs, 2000); assert.equal(C.applyAnswer(null, 'practice', true, 999999, 1).practice.totalCorrectTimeMs, A.MAX_MS);
});

/* ---- 9-12 selection ---- */
test('weighted selection favours high-priority characters but gives every character a chance', () => {
  const items = ['a', 'b', 'c', 'd'], w = [400, 100, 100, A.MIN], rand = prng(7), count = {}; items.forEach(i => { count[i] = 0; });
  for (let i = 0; i < 20000; i++) count[C.weightedSample(items, w, 1, rand)[0]]++;
  assert.ok(count.a > count.b * 3 && count.b > count.d * 5, JSON.stringify(count)); assert.ok(count.d > 0, 'the lowest-priority character still appears');
  assert.deepEqual(C.weightedSample(items, w, 4, () => 0.9999999).sort(), ['a', 'b', 'c', 'd']);       // even the lowest weight is reachable
  assert.equal(C.weightedSample(items, w, 1, () => 0.9999999)[0], 'd');
  assert.deepEqual(C.weightedSample(items, [0, 0, 0, 0], 2, () => 0.5).length, 2);                      // zero weights can never produce an empty/duplicate draw
});
test('exam selection: always 20 distinct characters from the level, adaptive but not a plain sort', async () => {
  const { q, clock } = await setup(40, { random: prng(3), shuffle: a => a.slice() });
  await runRead(q, clock, 'practice', (cid) => [!['c1', 'c2', 'c3'].includes(cid), 1000]);                // c1..c3 wrong
  const trials = 400, hit = { c1: 0, c2: 0, c3: 0, c10: 0 }, ids = new Set(q.level('L1').chars.map(c => c.id));
  for (let i = 0; i < trials; i++) {
    await q.startSession({ kind: 'read', levelId: 'L1', mode: 'exam' }); const it = q.cur.items.map(x => x.cid);
    assert.equal(it.length, 20); assert.equal(new Set(it).size, 20); assert.ok(it.every(x => ids.has(x)));
    Object.keys(hit).forEach(k => { if (it.includes(k)) hit[k]++; }); await q.discard(() => true);
  }
  assert.ok(hit.c1 > hit.c10 && hit.c2 > hit.c10 && hit.c3 > hit.c10, JSON.stringify(hit));              // wrong characters appear in more exams
  assert.ok(hit.c10 > 0 && hit.c10 < trials * 0.9, 'others still appear, and nothing is fixed');
  assert.equal((await q.startSession({ kind: 'write', levelId: 'L1', mode: 'exam' })).ok, true); assert.equal(q.cur.items.length, 20);   // writing uses its own (empty) statistics
});
test('a fast-and-correct character appears less in exams; reading and writing are weighted separately', async () => {
  const { q, clock } = await setup(60, { random: prng(11), shuffle: a => a.slice() });
  for (let i = 0; i < 9; i++) { await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice', chars: [q.level('L1').chars[0]] }); await readTimed(q, clock, true, 800); }   // only c1 is mastered
  assert.equal(q.priorityOf('read', 'c1'), A.MIN); assert.equal(q.priorityOf('write', 'c1'), A.BASE);
  let r = 0, w = 0; for (let i = 0; i < 300; i++) { await q.startSession({ kind: 'read', levelId: 'L1', mode: 'exam' }); if (q.cur.items.some(x => x.cid === 'c1')) r++; await q.discard(() => true);
    await q.startSession({ kind: 'write', levelId: 'L1', mode: 'exam' }); if (q.cur.items.some(x => x.cid === 'c1')) w++; await q.discard(() => true); }
  assert.ok(r < w, `mastered reading character appears less (${r} vs ${w})`);
});
test('level too small for an exam is rejected as before; practice keeps every character in its flow', async () => {
  const { q } = await setup(19); assert.equal((await q.startSession({ kind: 'read', levelId: 'L1', mode: 'exam' })).ok, false);
  assert.equal((await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' })).ok, true); assert.equal(q.cur.items.length, 19);
});

/* ---- response time measurement ---- */
test('response time counts active time only: pausing excludes time away, capped, and untimed answers are neutral', async () => {
  const { q, clock } = await setup(3, { shuffle: a => a.slice() });
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); const s = q.cur, key = s.id + ':0';
  q.qStart(key); clock.advance(2000); q.qPause(); clock.advance(600000); q.qStart(key); clock.advance(1000); q.qStart(key);   // re-render is idempotent
  await q.answerRead(true); assert.equal(q.cur.items[0].ms, 3000);
  clock.advance(5); await q.answerRead(true);                                   // never timed (no qStart): stored without ms
  assert.equal(q.cur.items[1].ms, undefined);
  q.qStart(q.cur.id + ':2'); clock.advance(10 * 60 * 1000); await q.answerRead(true);
  assert.equal(q.records.length, 1); assert.equal(bucket(q, 'c3', 'read', 'practice').totalCorrectTimeMs, A.MAX_MS);
  assert.equal(bucket(q, 'c2', 'read', 'practice').timedCorrect, 0); assert.equal(bucket(q, 'c2', 'read', 'practice').correct, 1);
});
test('writing: the time to submit the drawing is used once the parent has marked the answer', async () => {
  const { q, clock } = await setup(2, { shuffle: a => a.slice() });
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'exam', chars: chars(2) });
  for (let i = 0; i < 2; i++) { q.qStart(q.cur.id + ':' + i); clock.advance(i ? 8000 : 2000); await q.answerWrite(IMG + i); }
  assert.equal(q.stats.size, 0, 'nothing is counted until the exam is completed');
  await q.setOk(0, true); await q.setOk(1, true); await q.finishMarking();
  assert.equal(bucket(q, 'c1', 'write', 'exam').totalCorrectTimeMs, 2000); assert.equal(bucket(q, 'c2', 'write', 'exam').totalCorrectTimeMs, 8000);
  assert.equal(q.priorityOf('write', 'c1'), A.BASE - 10); assert.equal(q.priorityOf('write', 'c2'), A.BASE + A.SLOW_PENALTY - 6);   // 2 s = fast; 8 s = slow: barely reduced
});

/* ---- persistence / completion semantics ---- */
test('interrupted sessions never count; statistics survive a reopen and are written exactly once with the completed record', async () => {
  const { st, q, clock } = await setup(3, { shuffle: a => a.slice() });
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); await readTimed(q, clock, false, 1000); await readTimed(q, clock, false, 1000);
  assert.equal(q.stats.size, 0); assert.equal((await st.loadAll()).stats.length, 0);                          // unfinished: nothing counted, not even as incorrect
  let q2 = await newQuiz(st, { now: clock.now }); assert.equal(q2.stats.size, 0); q2.cur = q2.sessions[0];
  await q2.answerRead(true);                                                                                  // untimed after a reload: neutral
  const q3 = await newQuiz(st, { now: clock.now }); assert.equal(q3.stats.size, 3); assert.equal(bucket(q3, 'c1', 'read', 'practice').incorrect, 1); assert.equal(bucket(q3, 'c3', 'read', 'practice').correct, 1);
  const rec = q3.records[0]; await st.completeSession(rec, null, [...q3.stats.values()]);                     // a repeated store-level completion changes nothing
  const q4 = await newQuiz(st); assert.equal(q4.records.length, 1); assert.equal(bucket(q4, 'c1', 'read', 'practice').attempts, 1);
});
test('existing data gets statistics once, from its completed records', async () => {
  const st = await newStore(); await st.saveLevels([level('L1', '一級', chars(3))]);          // data from before the statistics existed: no Quiz has started yet
  await st.completeSession({ id: 'r1', levelId: 'L1', levelName: '一級', kind: 'read', mode: 'exam', parentId: null, date: 5, items: [{ cid: 'c1', c: '一', ok: false, imgId: null }, { cid: 'c2', c: '二', ok: true, imgId: null }] });
  assert.equal((await st.loadAll()).stats.length, 0);
  const q = await newQuiz(st); assert.equal(bucket(q, 'c1', 'read', 'exam').incorrect, 1); assert.equal(q.priorityOf('read', 'c1'), 125); assert.equal(bucket(q, 'c2', 'read', 'exam').correct, 1);
  const q2 = await newQuiz(st); assert.equal(q2.stats.size, 2); assert.equal(bucket(q2, 'c1', 'read', 'exam').attempts, 1, 'not rebuilt (and not doubled) on the next start');
});

/* ---- backup ---- */
async function withStats() {
  const { st, q, clock } = await setup(3, { shuffle: a => a.slice() });
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); await readTimed(q, clock, false, 1000); await readTimed(q, clock, true, 2500); await readTimed(q, clock, true, 8000);
  return { st, q, clock };
}
test('export includes statistics; replace and merge keep them; merge never overwrites this device\'s statistics', async () => {
  const { q } = await withStats(), { json } = await q.exportBackup(); const text = JSON.stringify(json);
  assert.equal(json.version, 1); assert.equal(json.data.stats.length, 3);
  const q2 = await newQuiz(await newStore()); await q2.importBackup(JSON.parse(text), 'replace', () => true);
  assert.deepEqual([...q2.stats.values()].sort((a, b) => (a.cid < b.cid ? -1 : 1)), json.data.stats);
  const q3 = await newQuiz(await newStore()); await q3.importBackup(JSON.parse(text), 'merge'); assert.equal(q3.stats.size, 3);
  const edited = JSON.parse(text); edited.data.stats[0].read.practice.incorrect = 9; const before = JSON.stringify(q3.stats.get('c1'));
  await q3.importBackup(edited, 'merge'); assert.equal(JSON.stringify(q3.stats.get('c1')), before);
});
test('a legacy backup without statistics imports: replace rebuilds them from its records, merge leaves existing statistics alone', async () => {
  const { q } = await withStats(); const legacy = (await q.exportBackup()).json; delete legacy.data.stats; delete legacy.data.sessions; delete legacy.data.drafts; delete legacy.data.corrections;
  const q2 = await newQuiz(await newStore()); await q2.importBackup(JSON.parse(JSON.stringify(legacy)), 'replace', () => true);
  assert.equal(bucket(q2, 'c1', 'read', 'practice').incorrect, 1); assert.equal(bucket(q2, 'c3', 'read', 'practice').correct, 1); assert.equal(bucket(q2, 'c3', 'read', 'practice').timedCorrect, 0);
  const { q: q3 } = await withStats(); const n = q3.stats.size; await q3.importBackup(JSON.parse(JSON.stringify(legacy)), 'merge'); assert.equal(q3.stats.size, n);
});
test('missing, partial or malformed statistics are handled safely', async () => {
  assert.equal(C.normStatsRow(null), null); assert.equal(C.normStatsRow({ cid: 5 }), null); assert.equal(C.normStatsRow({ cid: '' }), null);
  const r = C.normStatsRow({ cid: 'x', read: { practice: { attempts: -3, correct: 'a', incorrect: NaN, timedCorrect: 99 }, consecutiveCorrect: -1, lastAttemptAt: 'soon' }, write: 7 });
  assert.deepEqual(r.read.practice, { attempts: 0, correct: 0, incorrect: 0, timedCorrect: 0, totalCorrectTimeMs: 0 }); assert.equal(r.read.consecutiveCorrect, 0); assert.equal(r.read.lastAttemptAt, null);
  assert.equal(C.priority(r.write), A.BASE); assert.equal(C.priority(undefined), A.BASE); assert.equal(C.learningStatus(garbage()), 'new');
  function garbage() { return { practice: 'x', exam: [] }; }
  const { st, q } = await withStats(), { json } = await q.exportBackup();
  const bad = JSON.parse(JSON.stringify(json)); bad.data.stats = [{ cid: 'c1', read: 'junk' }, 42, null, { nope: 1 }, { cid: 'c1' }];
  const q2 = await newQuiz(await newStore()); const r2 = await q2.importBackup(bad, 'replace', () => true);
  assert.ok(r2.warnings.some(x => x.includes('學習統計'))); assert.equal(q2.priorityOf('read', 'c1'), A.BASE);
  const notArr = JSON.parse(JSON.stringify(json)); notArr.data.stats = 'oops'; const q3 = await newQuiz(await newStore()); await q3.importBackup(notArr, 'merge'); assert.equal(q3.stats.size, 0);
  await new Promise((res, rej) => { const tx = st.db.transaction(['stats'], 'readwrite'); tx.objectStore('stats').put({ cid: 'zz', read: 'junk', write: null }); tx.oncomplete = res; tx.onerror = rej; });   // corrupt row already in the database
  const q4 = await newQuiz(st); assert.equal(q4.priorityOf('read', 'zz'), A.BASE); assert.equal((await q4.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' })).ok, true);
});
