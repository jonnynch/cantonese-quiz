/* Pause / resume of all exercises and writing corrections: several unfinished activities, per-session drafts, backup round trip. */
const test = require('node:test'), assert = require('node:assert/strict');
const { S, C, IMG, newIdb, newStore, newQuiz, seed, CH, level } = require('./helpers');
const P = require('../public/js/profiles.js');

const reopen = st => newQuiz(st);                                   // "refresh / close and reopen": new controller, same database
async function setup(n = 4) { const st = await newStore(); const q = await seed(st, n); return { st, q }; }
async function writeAll(q, n, tag) { for (let i = 0; i < n; i++) await q.answerWrite(IMG + tag + i); }
async function markAll(q, marks) { for (let i = 0; i < marks.length; i++) await q.setOk(i, marks[i]); await q.finishMarking(); }

/* ---- 1-6: every exercise type stops and resumes at the exact question ---- */
for (const [kind, mode] of [['read', 'practice'], ['write', 'practice'], ['read', 'revision'], ['write', 'revision'], ['read', 'exam'], ['write', 'exam']]) {
  test(`stop and resume: ${kind} ${mode}`, async () => {
    const st = await newStore(); let q = await seed(st, 20);
    const rev = mode === 'revision' ? { parentId: 'parent-1', chars: [CH('c1', '日'), CH('c2', '月'), CH('c3', '火'), CH('c4', '水')] } : {};
    assert.equal((await q.startSession({ kind, levelId: 'L1', mode, ...rev })).ok, true);
    const first = q.cur, order = first.items.map(x => x.cid), started = first.started;
    for (let i = 0; i < 2; i++) await (kind === 'read' ? q.answerRead(i === 0) : q.answerWrite(IMG + 'a' + i));
    assert.equal(q.records.length, 0, 'leaving is not completing');
    q = await reopen(st);
    assert.equal(q.sessions.length, 1); assert.equal(q.cur.id, first.id); assert.equal(q.cur.i, 2);                 // exact position
    assert.deepEqual(q.cur.items.map(x => x.cid), order);                                                             // original order
    assert.equal(q.cur.started, started); assert.equal(q.cur.mode, mode); assert.equal(q.cur.levelId, 'L1');
    if (kind === 'read') { assert.deepEqual(q.cur.items.slice(0, 3).map(x => x.ok), [true, false, null]); }           // answers/scores so far
    else { assert.equal((await st.getImage(q.cur.items[1].imgId)).data, IMG + 'a1'); assert.equal(q.cur.items[2].imgId, null); }
    const n = q.cur.items.length;
    for (let i = 2; i < n; i++) await (kind === 'read' ? q.answerRead(true) : q.answerWrite(IMG + 'b' + i));          // no question repeats
    if (kind === 'write') await markAll(q, Array(n).fill(true));
    assert.equal(q.records.length, 1); assert.equal(q.records[0].id, first.id); assert.equal(q.records[0].started, started);
    assert.equal(q.sessions.length, 0);
  });
}

/* ---- 9: unfinished drawing ---- */
test('an unsubmitted handwriting drawing is restored after reopening, and only for its own question', async () => {
  const { st, q } = await setup(3);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); await q.answerWrite(IMG + 'done0');
  q.scheduleDraft(() => IMG + 'HALF', { immediate: true }); await q.flushDraft();
  const q2 = await reopen(st);
  assert.equal(q2.cur.i, 1); assert.equal((await q2.loadDraft()).data, IMG + 'HALF'); assert.equal(q2.records.length, 0);
});

/* ---- 13: several unfinished activities ---- */
test('several unfinished activities are kept independently, each with its own position and drawing', async () => {
  const st = await newStore(); const q = await seed(st, 20);
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); const a = q.cur.id; await q.answerRead(true);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); const b = q.cur.id; await q.answerWrite(IMG + 'w0');
  q.scheduleDraft(() => IMG + 'DRAW-B'); // pending (not yet flushed)
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'exam' }); const c = q.cur.id;      // switching flushes B's drawing first
  assert.equal(q.sessions.length, 3); assert.equal(new Set([a, b, c]).size, 3);
  assert.equal((await st.getDraft(b)).data, IMG + 'DRAW-B');
  const q2 = await reopen(st);
  assert.deepEqual(q2.unfinished().map(x => x.id).sort(), [a, b, c].sort());
  const by = id => q2.sessions.find(x => x.id === id);
  assert.equal(by(a).i, 1); assert.equal(by(b).i, 1); assert.equal(by(c).i, 0);
  assert.equal((await q2.open(b)).ok, true); assert.equal(q2.cur.id, b); assert.equal((await q2.loadDraft()).data, IMG + 'DRAW-B');
  assert.equal((await q2.open(a)).ok, true); assert.equal(await q2.loadDraft(), null);          // A never shows B's drawing
  await q2.answerRead(true); assert.equal(by(a).i, 2); assert.equal(by(b).i, 1); assert.equal(by(c).i, 0);   // answering A leaves B and C alone
  assert.equal((await q2.discard(() => true, c)).ok, true);                                      // discarding C leaves A and B
  assert.deepEqual(q2.sessions.map(x => x.id).sort(), [a, b].sort()); assert.equal((await st.getDraft(b)).data, IMG + 'DRAW-B');
  assert.equal((await q2.open('nope')).ok, false);
});
test('duplicates are prevented: the same exercise is resumed, never created twice, and nothing is silently discarded', async () => {
  const { st, q } = await setup(3);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); await q.answerWrite(IMG + 'x'); const id = q.cur.id;
  for (let k = 0; k < 2; k++) { const r = await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); assert.equal(r.duplicate, true); assert.equal(r.existing, id); }
  const [r1, r2] = await Promise.all([q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }), q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' })]);
  assert.equal([r1, r2].filter(r => r.ok).length, 1);                                            // double tap
  assert.equal((await (await reopen(st)).sessions.length), 2); assert.equal(q.sessions.find(x => x.id === id).i, 1);
});

/* ---- 10-12: correction activities ---- */
async function correction(st, q) {
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); const n = q.cur.items.length;
  await writeAll(q, n, 'o'); await markAll(q, Array.from({ length: n }, (_, i) => i % 2 === 1));
  return q.correctionFor(q.records[0].id);
}
test('a correction resumes at the exact character and attempt; finished attempts are kept; empty canvases never count', async () => {
  const { st, q } = await setup(4); const c = await correction(st, q), id = c.id, rec = JSON.stringify(q.records[0]);
  assert.equal(c.items.length, 2);
  for (let k = 0; k < 5; k++) await q.saveAttempt(id, 0, k, IMG + 'p' + k);
  for (let k = 0; k < 5; k++) await q.markAttempt(id, 0, k, true); await q.finishSet(id, 0);                                  // first character: written, marked, finished
  await q.saveAttempt(id, 1, 0, IMG + 'q0'); await q.saveAttempt(id, 1, 1, IMG + 'q1'); await q.saveAttempt(id, 1, 2, null);   // blank canvas
  assert.deepEqual(C.correctionPosition(q.correction(id)), { ci: 1, ai: 2, phase: 'write', saved: 7, total: 10 });
  const q2 = await reopen(st), c2 = q2.correction(id);
  assert.equal(c2.state, 'open'); assert.equal(q2.openCorrections().length, 1);
  assert.deepEqual(C.correctionPosition(c2), { ci: 1, ai: 2, phase: 'write', saved: 7, total: 10 });
  assert.deepEqual(c2.items.map(x => x.c), c.items.map(x => x.c));                               // order preserved
  assert.equal((await st.getImage(c2.items[0].attempts[3])).data, IMG + 'p3');
  assert.equal((await q2.completeCorrection(id)).ok, false);                                     // five attempts still required
  for (let k = 2; k < 5; k++) await q2.saveAttempt(id, 1, k, IMG + 'q' + k);
  assert.equal((await q2.completeCorrection(id)).ok, false, 'written but not marked and finished');
  for (let k = 0; k < 5; k++) await q2.markAttempt(id, 1, k, true); await q2.finishSet(id, 1);
  assert.equal((await q2.completeCorrection(id)).ok, true);
  assert.equal(JSON.stringify(q2.records[0]), rec, 'the original record/score never changes');
  assert.equal(q2.openCorrections().length, 0); assert.equal((await (await reopen(st)).corrections.length), 1);
});

/* ---- 14: profile isolation ---- */
test('unfinished activities and corrections are isolated per learner profile', async () => {
  const idb = newIdb(), mgr = await new P.ProfileManager(idb).init();
  const pa = await mgr.create({ name: 'A', avatar: 'cat' }), pb = await mgr.create({ name: 'B', avatar: 'dog' });
  const sa = await mgr.openStore(pa.id), sb = await mgr.openStore(pb.id);
  const qa = await seed(sa, 3); await qa.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); await qa.answerWrite(IMG + 'a');
  const qb = await seed(sb, 3);
  await qb.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' });
  const a2 = await newQuiz(await mgr.openStore(pa.id)), b2 = await newQuiz(await mgr.openStore(pb.id));
  assert.deepEqual(a2.sessions.map(x => x.kind), ['write']); assert.deepEqual(b2.sessions.map(x => x.kind), ['read']);
  assert.equal((await sb.exportAll()).images.length, 0); assert.equal((await sb.exportAll()).drafts.length, 0);
});

/* ---- 15-16: completion ---- */
test('a completed activity never reappears as unfinished and returning to it creates no second record', async () => {
  const { st, q } = await setup(3);
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); const id = q.cur.id;
  await q.answerRead(true); await q.answerRead(false); await q.answerRead(true);
  assert.equal(q.sessions.length, 0); assert.equal(q.records.length, 1);
  const again = await q.finishMarking(); assert.equal(again.ok, false);                          // nothing to finish
  const q2 = await reopen(st); assert.equal(q2.sessions.length, 0); assert.equal(q2.cur, null); assert.equal(q2.records.length, 1);
  await st.completeSession({ ...q2.records[0], items: [] });                                      // even a repeated store-level completion cannot overwrite
  const rs = (await st.loadAll()).records; assert.equal(rs.length, 1); assert.equal(rs[0].items.length, 3); assert.equal(rs[0].id, id);
});
test('elapsed time uses the original start and the real completion time, including time away', async () => {
  const st = await newStore(); let t = 1000; const q = await newQuiz(st, { now: () => t });
  await q.mutateLevels(ls => ls.push(level('L1', '一', [CH('c1', '日'), CH('c2', '月')])));
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); t = 5000; await q.answerRead(true);
  t = 9e6; const q2 = await newQuiz(st, { now: () => t }); assert.equal(q2.cur.started, 1000); await q2.answerRead(true);
  assert.equal(q2.records[0].started, 1000); assert.equal(q2.records[0].date, 9e6);
});

/* ---- 17: backup / restore ---- */
async function rich() {
  const st = await newStore(); const q = await seed(st, 4);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); await q.answerWrite(IMG + 'u0'); q.scheduleDraft(() => IMG + 'DR', { immediate: true }); await q.flushDraft();
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); await q.answerRead(false);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'exam', chars: [CH('c1', '日'), CH('c2', '月')] }); await q.answerWrite(IMG + 'e0'); await q.answerWrite(IMG + 'e1');
  await q.setOk(0, false); await q.setOk(1, true); await q.finishMarking();
  const corr = q.openCorrections()[0]; await q.saveAttempt(corr.id, 0, 0, IMG + 'k0'); await q.saveAttempt(corr.id, 0, 1, IMG + 'k1');
  return { st, q, corr };
}
test('backup contains unfinished sessions, drafts and corrections; replace restores them exactly', async () => {
  const { q, corr } = await rich(); const { json, missingImages } = await q.exportBackup();
  assert.equal(missingImages, 0); assert.equal(json.version, 1); assert.equal(json.format, 'cq-backup');
  assert.equal(json.data.sessions.length, 2); assert.equal(json.data.drafts.length, 1); assert.equal(json.data.corrections.length, 1);
  const text = JSON.stringify(json), st2 = await newStore(), q2 = await newQuiz(st2);
  const r = await q2.importBackup(JSON.parse(text), 'replace', () => true);
  assert.equal(r.added.sessions, 2); assert.equal(r.added.corrections, 1);
  const w = q2.sessions.find(x => x.kind === 'write'); assert.equal(w.i, 1); assert.equal((await st2.getImage(w.items[0].imgId)).data, IMG + 'u0');
  q2.cur = w; assert.equal((await q2.loadDraft()).data, IMG + 'DR');
  const c2 = q2.correction(corr.id); assert.deepEqual(C.correctionPosition(c2), { ci: 0, ai: 2, phase: 'write', saved: 2, total: 5 });
  assert.equal((await st2.getImage(c2.items[0].attempts[1])).data, IMG + 'k1');
  assert.deepEqual((await q2.exportBackup()).json.data.sessions.map(x => x.items.map(i => i.img || null)), json.data.sessions.map(x => x.items.map(i => i.img || null)));   // stable round trip
});
test('merge adds missing unfinished work, skips identical, never overwrites, and never revives a completed session', async () => {
  const { q } = await rich(); const { json } = await q.exportBackup(); const text = JSON.stringify(json);
  const st2 = await newStore(), q2 = await newQuiz(st2);
  const m = await q2.importBackup(JSON.parse(text), 'merge'); assert.equal(m.aborted, undefined); assert.equal(m.added.sessions, 2); assert.equal(m.added.corrections, 1);
  const again = await q2.importBackup(JSON.parse(text), 'merge'); assert.equal(again.aborted, undefined); assert.equal(again.added.sessions, 0); assert.equal(again.added.corrections, 0); assert.ok(again.identical >= 3);
  assert.equal(q2.sessions.length, 2);
  // different progress under the same id is a reported conflict and nothing changes
  const diff = JSON.parse(text); diff.data.sessions.find(x => x.kind === 'write').items[0].img = IMG + 'OTHER';
  const before = JSON.stringify(await st2.exportAll()), c = await q2.importBackup(diff, 'merge');
  assert.equal(c.aborted, true); assert.ok(c.conflicts.some(x => x.includes('未完成的測驗'))); assert.equal(JSON.stringify(await st2.exportAll()), before);
  // a session that is already a completed record here does not come back as unfinished
  const q3 = await newQuiz(await newStore()); await q3.importBackup(JSON.parse(text), 'merge');
  const sess = q3.sessions.find(x => x.kind === 'read'); await q3.open(sess.id); await q3.answerRead(true); await q3.answerRead(true); await q3.answerRead(true); await q3.answerRead(true);
  assert.equal(q3.sessions.some(x => x.id === sess.id), false);
  const r3 = await q3.importBackup(JSON.parse(text), 'merge'); assert.equal(q3.sessions.some(x => x.id === sess.id), false); assert.ok(r3.warnings.some(x => x.includes('已經完成')) || r3.aborted);
});
test('older backups (no sessions/corrections fields) still import; invalid new fields are rejected before anything changes', async () => {
  const old = { format: 'cq-backup', version: 1, exported: 'x', data: { levels: [level('L1', '一', [CH('c1', '日')])], records: [] } };
  const { q } = await setup(2); await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' });
  const mq = await newQuiz(await newStore()); assert.equal((await mq.importBackup(JSON.parse(JSON.stringify(old)), 'merge')).added.levels, 1);
  const kept = await q.importBackup(JSON.parse(JSON.stringify(old)), 'merge'); assert.equal(q.sessions.length, 1, 'merge never removes unfinished work');
  const bad = (await (await rich()).q.exportBackup()).json; bad.data.sessions[0].i = 99;
  const { st, q: q4 } = await rich(); const snap = JSON.stringify(await st.exportAll());
  await assert.rejects(() => q4.importBackup(bad, 'replace', () => true), e => e.name === 'ImportError');
  assert.equal(JSON.stringify(await st.exportAll()), snap);
  const bad2 = (await q4.exportBackup()).json; bad2.data.drafts[0].qi = 7;
  await assert.rejects(() => q4.importBackup(bad2, 'merge'), e => e.name === 'ImportError');
  const bad3 = (await q4.exportBackup()).json; bad3.data.corrections[0].items[0].attempts = [null];
  await assert.rejects(() => q4.importBackup(bad3, 'merge'), e => e.name === 'ImportError');
});
test('database upgrade v2 -> v3 moves the single unfinished session and its draft without loss', async () => {
  const idb = newIdb();
  await new Promise((res, rej) => {
    const rq = idb.open(S.DB_NAME, 2);
    rq.onupgradeneeded = () => { const db = rq.result; db.createObjectStore('levels', { keyPath: 'id' }); db.createObjectStore('records', { keyPath: 'id' }).createIndex('levelId', 'levelId');
      db.createObjectStore('images', { keyPath: 'id' }).createIndex('sid', 'sid'); db.createObjectStore('sessions'); db.createObjectStore('meta'); db.createObjectStore('corrections', { keyPath: 'id' }); };
    rq.onsuccess = () => { const db = rq.result, tx = db.transaction(['sessions'], 'readwrite');
      tx.objectStore('sessions').put({ id: 's1', kind: 'write', phase: 'ask', i: 1 }, 'current'); tx.objectStore('sessions').put({ sid: 's1', qi: 1, cid: 'c2', seq: 3, data: IMG + 'D' }, 'draft');
      tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
  });
  const st = S.createStore(await S.openDb(idb));
  assert.equal((await st.loadAll()).sessions[0].id, 's1'); assert.equal((await st.getDraft('s1')).data, IMG + 'D');
  assert.equal(await st.getMeta('x'), undefined);
});
