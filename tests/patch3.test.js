const test = require('node:test'), assert = require('node:assert/strict');
const P = require('../public/js/profiles.js');
const { S, C, IMG, newIdb, newStore, memLS, CH, level, counterUid, newQuiz } = require('./helpers');

/* a quiz whose clock is controlled by the test */
async function clockQuiz(store, clock, chars = 3) {
  const q = new C.Quiz(store, { uid: counterUid(), shuffle: a => a.slice(), now: () => clock.t }); await q.init();
  if (!q.levels.length) await q.mutateLevels(ls => ls.push(level('L1', '一級', Array.from({ length: chars }, (_, i) => CH('c' + (i + 1), '字日月火水木土金'[i % 8])))));
  return q;
}
async function runSession(q, clock, { kind, mode, marks, parentId, chars, startAt, endAt }) {
  clock.t = startAt;
  await q.startSession({ kind, levelId: 'L1', mode, parentId, chars, confirm: () => true });
  const n = q.cur.items.length;
  if (kind === 'read') { for (let i = 0; i < n; i++) { clock.t = startAt + (i + 1 === n ? endAt - startAt : 1000); await q.answerRead(marks ? marks[i] : true); } return q.result; }
  for (let i = 0; i < n; i++) await q.answerWrite(IMG + i);
  for (let i = 0; i < n; i++) await q.setOk(i, marks ? marks[i] : true);
  clock.t = endAt; await q.finishMarking(); return q.result;
}

/* ---------------- 3. duration ---------------- */
test('duration: formatting of seconds, minutes and whole minutes', () => {
  const f = ms => C.formatDuration(1000, 1000 + ms);
  assert.equal(f(45000), '45 秒'); assert.equal(f(85000), '1 分 25 秒'); assert.equal(f(180000), '3 分 0 秒'); assert.equal(f(728000), '12 分 8 秒');
  assert.equal(f(0), '0 秒'); assert.equal(f(999), '0 秒'); assert.equal(f(59999), '59 秒'); assert.equal(f(60000), '1 分 0 秒'); assert.equal(f(4500000), '75 分 0 秒');
});

test('duration: missing, invalid or reversed timestamps give "unavailable", never a negative or invented value', () => {
  for (const [a, b] of [[undefined, 5000], [null, 5000], [1000, undefined], ['1000', 5000], [NaN, 5000], [1000, Infinity], [5000, 1000], [1000, -1], [undefined, undefined]])
    assert.equal(C.formatDuration(a, b), null, String([a, b]));
  assert.equal(C.durationOf({ date: 5000 }), null);                                  // legacy record: no start time
  assert.equal(C.durationOf({ started: 9000, date: 5000 }), null);
  assert.equal(C.durationOf(null), null);
  assert.equal(C.durationOf({ started: 1000, date: 2000 }), '1 秒');
});

test('duration: correct for all six session types, from the stored start and completion timestamps', async () => {
  const st = await newStore(), clock = { t: 0 }; const q = await clockQuiz(st, clock, 20);
  const T = 1700000000000;
  const wrong = [false, true, true];
  const cases = [
    [{ kind: 'read', mode: 'practice' }, 45000, '45 秒'], [{ kind: 'write', mode: 'practice' }, 85000, '1 分 25 秒'],
    [{ kind: 'read', mode: 'exam' }, 180000, '3 分 0 秒'], [{ kind: 'write', mode: 'exam' }, 728000, '12 分 8 秒'],
  ];
  let at = T; const recs = [];
  for (const [o, ms, text] of cases) { const r = await runSession(q, clock, { ...o, startAt: at, endAt: at + ms }); assert.equal(r.started, at); assert.equal(r.date, at + ms); assert.equal(C.durationOf(r), text); recs.push(r); at += 10 * 60000; }
  for (const [kind, ms, text] of [['read', 61000, '1 分 1 秒'], ['write', 9000, '9 秒']]) {            // revision sessions
    const src = recs.find(r => r.kind === kind && r.mode === 'practice');
    const r = await runSession(q, clock, { kind, mode: 'revision', parentId: src.id, chars: src.items.slice(0, 2).map(x => ({ id: x.cid, c: x.c })), startAt: at, endAt: at + ms });
    assert.equal(r.mode, 'revision'); assert.equal(C.durationOf(r), text); at += 600000;
  }
  const reloaded = await clockQuiz(st, clock); assert.equal(reloaded.records.length, 6);
  assert.ok(reloaded.records.every(r => Number.isFinite(r.started) && Number.isFinite(r.date) && r.date >= r.started));        // both timestamps kept in the stored records
});

test('duration: elapsed wall-clock time includes breaks, and the original start survives refresh and resume', async () => {
  const st = await newStore(), clock = { t: 100000 }; let q = await clockQuiz(st, clock);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); await q.answerWrite(IMG);
  const started = q.cur.started; assert.equal(started, 100000);
  clock.t = 100000 + 20 * 60000;                                                                   // 20 minutes away from the screen
  q = await clockQuiz(st, clock);                                                                  // refresh
  assert.equal(q.cur.started, started);                                                            // not reset
  await q.answerWrite(IMG); await q.answerWrite(IMG); for (let i = 0; i < 3; i++) await q.setOk(i, true);
  clock.t = 100000 + 21 * 60000 + 5000; await q.finishMarking();
  assert.equal(q.result.started, started); assert.equal(C.durationOf(q.result), '21 分 5 秒');
});

test('duration: start time is kept through backup export and import; a differing start time is a merge conflict', async () => {
  const st = await newStore(), clock = { t: 0 }; const q = await clockQuiz(st, clock);
  await runSession(q, clock, { kind: 'read', mode: 'practice', startAt: 5000, endAt: 65000 });
  const { json } = await q.exportBackup(); assert.equal(json.data.records[0].started, 5000);
  const st2 = await newStore(), q2 = await clockQuiz(st2, clock); await q2.importBackup(JSON.parse(JSON.stringify(json)), 'replace', () => true);
  assert.equal(q2.records[0].started, 5000); assert.equal(C.durationOf(q2.records[0]), '1 分 0 秒');
  const j = JSON.parse(JSON.stringify(json)); j.data.records[0].started = 6000;
  const r = await q.importBackup(j, 'merge'); assert.equal(r.aborted, true); assert.match(r.conflicts[0], /開始時間不同/);
  const old = JSON.parse(JSON.stringify(json)); delete old.data.records[0].started;                  // older backup without start time: not a conflict
  assert.equal((await q.importBackup(old, 'merge')).conflicts.length, 0);
});

/* ---------------- 4. writing correction ---------------- */
async function finishedWrite(q, clock, marks, mode = 'practice') { return runSession(q, clock, { kind: 'write', mode, marks, startAt: 1000, endAt: 9000 }); }
const attemptsOf = (q, id, ci) => q.correction(id).items[ci].attempts;
async function fill(q, id, ci, tag, slots = [0, 1, 2, 3, 4]) { for (const k of slots) assert.equal((await q.saveAttempt(id, ci, k, IMG + tag + k)).ok, true); }

test('correction: none when every answer is correct, and never for reading practice or reading exams', async () => {
  const st = await newStore(), clock = { t: 0 }; const q = await clockQuiz(st, clock, 20);
  await finishedWrite(q, clock, [true, true, true]); assert.equal(q.corrections.length, 0); assert.equal(q.correctionFor(q.result.id), null);
  await runSession(q, clock, { kind: 'read', mode: 'practice', marks: [false, false, true], startAt: 1, endAt: 5 });
  await runSession(q, clock, { kind: 'read', mode: 'exam', marks: new Array(20).fill(false), startAt: 10, endAt: 50 });
  assert.equal(q.corrections.length, 0); assert.equal((await (await clockQuiz(st, clock)).corrections).length, 0);
});

test('correction: contains exactly the incorrectly marked characters, with a reference to the source record', async () => {
  const st = await newStore(), clock = { t: 0 }; const q = await clockQuiz(st, clock, 20);
  for (const mode of ['practice', 'exam']) {
    const n = mode === 'exam' ? 20 : 3, marks = Array.from({ length: n }, (_, i) => i % 3 !== 0);      // items 0,3,6,... wrong
    const rec = await runSession(q, clock, { kind: 'write', mode, marks, startAt: 1000, endAt: 9000 });
    const c = q.correctionFor(rec.id);
    assert.deepEqual(c.items.map(x => x.cid), rec.items.filter(x => x.ok === false).map(x => x.cid));
    assert.equal(c.sourceId, rec.id); assert.equal(c.sourceKind, 'write'); assert.equal(c.sourceMode, mode); assert.equal(c.levelId, 'L1'); assert.equal(c.state, 'open');
    assert.ok(c.items.every(x => x.attempts.length === 5 && x.attempts.every(a => a === null) && x.c && 'w' in x && 'wjp' in x));
  }
  const rev = await runSession(q, clock, { kind: 'write', mode: 'revision', marks: [false, true], parentId: q.records[0].id, chars: [{ id: 'c1', c: '字' }, { id: 'c2', c: '日' }], startAt: 1, endAt: 2 });
  assert.equal(q.correctionFor(rev.id).sourceMode, 'revision'); assert.equal(q.correctionFor(rev.id).items.length, 1);
});

test('correction: exactly five independent attempts per character; blank/invalid attempts never count', async () => {
  const st = await newStore(), clock = { t: 0 }; const q = await clockQuiz(st, clock);
  const rec = await finishedWrite(q, clock, [false, true, true]); const id = q.correctionFor(rec.id).id;
  assert.equal((await q.completeCorrection(id)).ok, false);                                       // nothing written yet
  await fill(q, id, 0, 'a', [0, 1, 2, 3]); assert.equal(C.attemptsDone(q.correction(id).items[0]), false);
  assert.equal((await q.completeCorrection(id)).ok, false); assert.equal(q.correction(id).state, 'open');
  assert.equal((await q.saveAttempt(id, 0, 4, null)).ok, true); assert.equal(attemptsOf(q, id, 0)[4], null);        // an empty canvas is "no attempt"
  assert.equal((await q.completeCorrection(id)).ok, false);
  for (const bad of ['', 'not-an-image', 42, {}, 'javascript:alert(1)']) assert.equal((await q.saveAttempt(id, 0, 4, bad)).ok, false, String(bad));
  for (const [ci, ai] of [[5, 0], [0, 5], [0, -1], [0, 1.5]]) assert.equal((await q.saveAttempt(id, ci, ai, IMG)).ok, false);
  assert.equal(attemptsOf(q, id, 0)[4], null);
  await fill(q, id, 0, 'a', [4]);
  const ids = attemptsOf(q, id, 0); assert.equal(new Set(ids).size, 5);                          // five different saved images
  const imgs = (await st.exportAll()).images.filter(i => i.sid === id); assert.equal(imgs.length, 5); assert.equal(new Set(imgs.map(i => i.data)).size, 5);
  assert.equal(C.attemptsDone({ attempts: ['x', 'x', 'x', 'x', 'x'] }), false);                  // one image can never count as five
  assert.equal(C.attemptsDone({ attempts: ['a', 'b', 'c', 'd'] }), false);
  assert.equal((await q.completeCorrection(id)).ok, true); assert.equal(q.correction(id).state, 'done'); assert.ok(q.correction(id).completedAt);
  assert.equal((await q.saveAttempt(id, 0, 0, IMG)).ok, false);                                  // finished activities are closed
});

test('correction: clearing or rewriting one attempt leaves the other four untouched', async () => {
  const st = await newStore(), clock = { t: 0 }; const q = await clockQuiz(st, clock);
  const id = q.correctionFor((await finishedWrite(q, clock, [false, true, true])).id).id; await fill(q, id, 0, 'x');
  const before = attemptsOf(q, id, 0).slice(), dataOf = async i => (await st.getImage(i)).data;
  assert.equal((await q.saveAttempt(id, 0, 2, null)).ok, true);
  const after = attemptsOf(q, id, 0); assert.equal(after[2], null); [0, 1, 3, 4].forEach(k => assert.equal(after[k], before[k]));
  assert.equal(await st.getImage(before[2]), null, 'the cleared image is removed from storage');
  assert.equal(await dataOf(before[3]), IMG + 'x3');
  await q.saveAttempt(id, 0, 2, IMG + 'rewritten'); assert.equal(await dataOf(attemptsOf(q, id, 0)[2]), IMG + 'rewritten');
  await q.saveAttempt(id, 0, 1, IMG + 'again');                                                  // rewrite replaces, never adds a sixth image
  assert.equal((await st.exportAll()).images.filter(i => i.sid === id).length, 5);
  assert.equal(attemptsOf(q, id, 0)[0], before[0]); assert.equal(attemptsOf(q, id, 0)[4], before[4]);
});

test('correction: several incorrect characters each need their own five attempts', async () => {
  const st = await newStore(), clock = { t: 0 }; const q = await clockQuiz(st, clock, 4);
  const id = q.correctionFor((await finishedWrite(q, clock, [false, true, false, false])).id).id;
  const c = q.correction(id); assert.equal(c.items.length, 3);
  await fill(q, id, 0, 'p'); await fill(q, id, 1, 'q'); await fill(q, id, 2, 'r', [0, 1, 2, 3]);
  assert.equal((await q.completeCorrection(id)).ok, false);                                       // 14 / 15
  await fill(q, id, 2, 'r', [4]);
  const all = q.correction(id).items.flatMap(x => x.attempts); assert.equal(all.length, 15); assert.equal(new Set(all).size, 15);
  assert.equal((await q.completeCorrection(id)).ok, true);
});

test('correction: progress and handwriting survive refresh and resume', async () => {
  const st = await newStore(), clock = { t: 0 }; let q = await clockQuiz(st, clock, 4);
  const id = q.correctionFor((await finishedWrite(q, clock, [false, true, false, true])).id).id;
  await fill(q, id, 0, 'k'); await fill(q, id, 1, 'm', [0, 1]);
  q = await clockQuiz(st, clock);                                                                  // refresh
  assert.equal(q.openCorrections().length, 1);
  const c = q.correction(id); assert.equal(c.state, 'open'); assert.equal(c.items[0].attempts.filter(Boolean).length, 5); assert.equal(c.items[1].attempts.filter(Boolean).length, 2);
  assert.equal(c.items.findIndex(x => !C.attemptsDone(x)), 1);                                      // resumes at the first unfinished character
  assert.equal((await st.getImage(c.items[1].attempts[1])).data, IMG + 'm1');
  await fill(q, id, 1, 'm', [2, 3, 4]); assert.equal((await q.completeCorrection(id)).ok, true);
  q = await clockQuiz(st, clock); assert.equal(q.openCorrections().length, 0); assert.equal(q.correction(id).state, 'done'); assert.equal(q.correction(id).items.flatMap(x => x.attempts).filter(Boolean).length, 10);
});

test('correction: saves from several canvases at once never lose an update, and a failed save changes nothing', async () => {
  const st = await newStore(), clock = { t: 0 }; const q = await clockQuiz(st, clock);
  const id = q.correctionFor((await finishedWrite(q, clock, [false, true, true])).id).id;
  const rs = await Promise.all([0, 1, 2, 3, 4].map(k => q.saveAttempt(id, 0, k, IMG + 'c' + k))); assert.ok(rs.every(r => r.ok));
  assert.equal(attemptsOf(q, id, 0).filter(Boolean).length, 5);
  assert.equal((await (await clockQuiz(st, clock)).correction(id).items[0].attempts.filter(Boolean).length), 5);
  let fail = true; const real = st.saveCorrection; q.store = { ...st, saveCorrection: async (...a) => { if (fail) throw new S.StorageError('write', 'full'); return real(...a); } };
  const before = JSON.stringify(q.correction(id)); const r = await q.saveAttempt(id, 0, 0, IMG + 'new');
  assert.equal(r.ok, false); assert.equal(JSON.stringify(q.correction(id)), before); assert.equal((await st.exportAll()).images.filter(i => i.sid === id).length, 5);
  fail = false; assert.equal((await q.saveAttempt(id, 0, 0, IMG + 'new')).ok, true);
});

test('correction: it never changes the original record, score or statistics', async () => {
  const st = await newStore(), clock = { t: 0 }; const q = await clockQuiz(st, clock);
  const rec = await finishedWrite(q, clock, [false, true, false]); const recJson = JSON.stringify(q.records), stored = JSON.stringify((await st.exportAll()).records);
  const id = q.correctionFor(rec.id).id; await fill(q, id, 0, 'a'); await fill(q, id, 1, 'b'); await q.completeCorrection(id);
  assert.equal(JSON.stringify(q.records), recJson); assert.equal(JSON.stringify((await st.exportAll()).records), stored);
  assert.deepEqual(q.records[0].items.map(x => x.ok), [false, true, false]); assert.equal(q.records.length, 1);
  assert.ok(q.records[0].items.every(x => !('attempts' in x)));
  assert.ok((await st.exportAll()).images.some(i => i.sid === id) && (await st.exportAll()).images.filter(i => i.sid === rec.id).length === 3);
});

test('correction: revisiting the completion screen or finishing again never creates a second activity', async () => {
  const st = await newStore(), clock = { t: 0 }; const q = await clockQuiz(st, clock);
  const rec = await finishedWrite(q, clock, [false, true, true]); const id = q.correctionFor(rec.id).id;
  assert.equal(q.correctionFor(rec.id).id, id); assert.equal(q.correctionFor(rec.id).id, id);       // revisiting just looks it up
  await fill(q, id, 0, 'z', [0, 1]);
  const corr = C.buildCorrection(rec, 5);                                                          // same record completed/saved again (e.g. retry after a crash)
  await st.completeSession(rec, corr); await st.completeSession(rec, corr);
  const all = (await st.loadAll()).corrections; assert.equal(all.length, 1);
  assert.equal(all[0].items[0].attempts.filter(Boolean).length, 2, 'existing progress is not reset');
  assert.equal((await (await clockQuiz(st, clock)).corrections).length, 1);
});

test('correction: data stays with its learner profile', async () => {
  const idb = newIdb(), m = new P.ProfileManager(idb); await m.init(); const clock = { t: 0 };
  const a = await m.create({ name: '甲', avatar: 'cat' }), b = await m.create({ name: '乙', avatar: 'dog' });
  const qa = await clockQuiz(await m.openStore(a.id), clock), qb = await clockQuiz(await m.openStore(b.id), clock);
  const idA = qa.correctionFor((await finishedWrite(qa, clock, [false, false, true])).id).id; await fill(qa, idA, 0, 'A');
  const idB = qb.correctionFor((await finishedWrite(qb, clock, [true, false, true])).id).id; await fill(qb, idB, 0, 'B');
  const ra = await clockQuiz(await m.openStore(a.id), clock), rb = await clockQuiz(await m.openStore(b.id), clock);
  assert.equal(ra.corrections.length, 1); assert.equal(rb.corrections.length, 1);
  assert.equal(ra.corrections[0].items.length, 2); assert.equal(rb.corrections[0].items.length, 1);
  assert.equal((await (await m.openStore(a.id)).getImage(ra.corrections[0].items[0].attempts[0])).data, IMG + 'A0');
  assert.equal((await (await m.openStore(b.id)).getImage(rb.corrections[0].items[0].attempts[0])).data, IMG + 'B0');
  await m.remove(b.id, () => true); const ra2 = await clockQuiz(await m.openStore(a.id), clock); assert.equal(ra2.corrections[0].items[0].attempts.filter(Boolean).length, 5);   // deleting B leaves A
});

test('correction: a "replace all" import keeps correction activities and their handwriting', async () => {
  const st = await newStore(), clock = { t: 0 }; const q = await clockQuiz(st, clock);
  const rec = await finishedWrite(q, clock, [false, true, true]); const id = q.correctionFor(rec.id).id; await fill(q, id, 0, 'k');
  const { json } = await q.exportBackup();
  await q.importBackup(JSON.parse(JSON.stringify(json)), 'replace', () => true);
  assert.equal(q.corrections.length, 1); assert.equal((await st.getImage(q.corrections[0].items[0].attempts[2])).data, IMG + 'k2');
  assert.equal((await st.exportAll()).images.filter(i => i.sid === id).length, 5);
  assert.equal((await st.exportAll()).images.filter(i => i.sid === rec.id).length, 3);              // the backup's own images were restored
});

test('database upgrade: an existing version-1 database gets the corrections store and keeps every row', async () => {
  const idb = newIdb();
  await new Promise((res, rej) => {                                                                // a database exactly as Patch 1/2 created it
    const rq = idb.open(S.DB_NAME, 1);
    rq.onupgradeneeded = () => { const db = rq.result; db.createObjectStore('levels', { keyPath: 'id' }); db.createObjectStore('records', { keyPath: 'id' }).createIndex('levelId', 'levelId');
      db.createObjectStore('images', { keyPath: 'id' }).createIndex('sid', 'sid'); db.createObjectStore('sessions'); db.createObjectStore('meta'); };
    rq.onsuccess = () => { const db = rq.result, tx = db.transaction(['levels', 'records', 'images', 'sessions'], 'readwrite');
      tx.objectStore('levels').put({ id: 'L1', name: '舊', chars: [], ord: 0 }); tx.objectStore('records').put({ id: 'r1', levelId: 'L1', items: [{ cid: 'c', imgId: 'i1' }], date: 1 });
      tx.objectStore('images').put({ id: 'i1', sid: 'r1', data: IMG }); tx.objectStore('sessions').put({ id: 's' }, 'current'); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
  });
  const st = S.createStore(await S.openDb(idb, S.DB_NAME));
  assert.ok([...st.db.objectStoreNames].includes('corrections')); assert.equal(st.db.version, 3);
  const d = await st.loadAll(); assert.equal(d.levels.length, 1); assert.equal(d.records.length, 1); assert.equal(d.session.id, 's'); assert.deepEqual(d.sessions.map(x => x.id), ['s']); assert.deepEqual(d.corrections, []);   // the v1 session row was moved into the v3 'unfinished' store
  assert.equal((await st.getImage('i1')).data, IMG);
  const q = new C.Quiz(st); await q.init(); assert.equal(q.records[0].started, undefined); assert.equal(C.durationOf(q.records[0]), null);   // legacy record: duration unavailable
});
