const test = require('node:test'), assert = require('node:assert/strict');
const { S, C, IMG, newStore, newQuiz, seed, CH } = require('./helpers');

const fail = () => new S.StorageError('write', 'disk full');
/* store wrapper whose write methods can be made to fail or to be slow */
function flaky(st) {
  const f = { ...st, failing: false, delay: 0, calls: 0 };
  for (const m of ['saveSession', 'completeSession', 'startSession', 'discardSession']) {
    f[m] = async (...a) => { f.calls++; if (f.delay) await new Promise(r => setTimeout(r, f.delay)); if (f.failing) throw fail(); return st[m](...a); };
  }
  return f;
}
async function writeSession(n = 3) {
  const st = await newStore(), fs = flaky(st); await seed(st, n);
  const q = await newQuiz(fs);
  assert.equal((await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' })).ok, true);
  return { st, fs, q };
}

test('failed save of a handwriting answer keeps the question, keeps the image data and can be retried', async () => {
  const { st, fs, q } = await writeSession();
  fs.failing = true;
  const r = await q.answerWrite(IMG + 'XYZ');
  assert.equal(r.ok, false); assert.equal(r.error.code, 'write');
  assert.equal(q.cur.i, 0); assert.equal(q.cur.items[0].imgId, null);               // not advanced, nothing marked as saved
  assert.equal((await st.loadAll()).session.i, 0); assert.equal((await st.exportAll()).images.length, 0);
  fs.failing = false;
  const r2 = await q.retryLast();                                                    // retry re-sends the SAME handwriting
  assert.equal(r2.ok, true); assert.equal(q.cur.i, 1);
  const imgs = (await st.exportAll()).images; assert.equal(imgs.length, 1); assert.equal(imgs[0].data, IMG + 'XYZ');
  assert.equal((await st.loadAll()).session.items[0].imgId, imgs[0].id);
});

test('failed save does not advance reading questions and cannot create a false completed session', async () => {
  const st = await newStore(), fs = flaky(st); await seed(st, 2);
  const q = await newQuiz(fs); await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' });
  fs.failing = true;
  assert.equal((await q.answerRead(true)).ok, false); assert.equal(q.cur.i, 0); assert.equal(q.cur.items[0].ok, null);
  fs.failing = false; assert.equal((await q.answerRead(true)).ok, true); assert.equal(q.cur.i, 1);
  fs.failing = true;                                                                  // last question: completion write fails
  assert.equal((await q.answerRead(false)).ok, false);
  assert.ok(q.cur, 'session must still be open'); assert.equal(q.records.length, 0); assert.equal(q.result, null);
  assert.equal((await st.loadAll()).records.length, 0); assert.equal((await st.loadAll()).session.i, 1);
  fs.failing = false; assert.equal((await q.retryLast()).ok, true);
  assert.equal(q.cur, null); assert.equal(q.records.length, 1); assert.equal(q.records[0].items.filter(x => x.ok).length, 1);
  assert.equal((await st.loadAll()).session, null);
});

test('failed marking / finishing does not change scores or complete the session', async () => {
  const { st, fs, q } = await writeSession(2);
  await q.answerWrite(IMG); await q.answerWrite(IMG);
  assert.equal(q.cur.phase, 'mark');
  fs.failing = true;
  assert.equal((await q.setOk(0, true)).ok, false); assert.equal(q.cur.items[0].ok, null);
  fs.failing = false; await q.setOk(0, true); await q.setOk(1, false);
  fs.failing = true;
  assert.equal((await q.finishMarking()).ok, false);
  assert.ok(q.cur); assert.equal(q.records.length, 0); assert.equal((await st.loadAll()).records.length, 0);
  fs.failing = false; assert.equal((await q.finishMarking()).ok, true);
  assert.equal(q.records.length, 1); assert.equal(q.records[0].items.length, 2); assert.ok(q.records[0].items[0].imgId);
});

test('duplicate submission is ignored while a save is in flight', async () => {
  const { fs, q } = await writeSession();
  fs.delay = 30; const before = fs.calls;
  const [a, b] = await Promise.all([q.answerWrite(IMG), q.answerWrite(IMG)]);
  assert.equal(a.ok, true); assert.equal(b.busy, true);
  assert.equal(fs.calls - before, 1); assert.equal(q.cur.i, 1);
});

test('unfinished session survives a refresh and resumes at the correct question without repeats', async () => {
  const st = await newStore(); await seed(st, 4);
  let q = await newQuiz(st); await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' });
  await q.answerWrite(IMG + '1'); await q.answerWrite(IMG + '2');
  const order = q.cur.items.map(x => x.cid);
  q = await newQuiz(st);                                                              // "refresh": brand-new controller, same database
  assert.ok(q.cur); assert.equal(q.cur.i, 2); assert.deepEqual(q.cur.items.map(x => x.cid), order);
  assert.ok(q.cur.items[0].imgId && q.cur.items[1].imgId && !q.cur.items[2].imgId);
  assert.equal((await st.getImage(q.cur.items[1].imgId)).data, IMG + '2');
  assert.equal(q.records.length, 0, 'unfinished sessions are not completed records');
  await q.answerWrite(IMG + '3'); await q.answerWrite(IMG + '4');
  assert.equal(q.cur.phase, 'mark');
  for (let k = 0; k < 4; k++) await q.setOk(k, true);
  await q.finishMarking();
  assert.deepEqual(q.records[0].items.map(x => x.cid), order);
  assert.equal(new Set(q.records[0].items.map(x => x.imgId)).size, 4);
});

test('a read session in marking progress also resumes after refresh', async () => {
  const st = await newStore(); await seed(st, 3);
  let q = await newQuiz(st); await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' });
  await q.answerRead(true); q = await newQuiz(st);
  assert.equal(q.cur.i, 1); assert.equal(q.cur.items[0].ok, true); assert.equal(q.cur.items[1].ok, null);
});

test('discarding requires explicit confirmation; leaving/refreshing never deletes', async () => {
  const st = await newStore(); await seed(st);
  const q = await newQuiz(st); await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); await q.answerWrite(IMG);
  assert.equal((await q.discard(() => false)).cancelled, true);
  assert.ok(q.cur); assert.ok((await st.loadAll()).session); assert.equal((await st.exportAll()).images.length, 1);
  assert.equal((await q.discard(undefined)).cancelled, true);                          // no confirmation callback = no deletion
  assert.ok((await (await newQuiz(st)).cur));
  assert.equal((await q.discard(() => true)).ok, true);
  assert.equal(q.cur, null); assert.equal((await st.loadAll()).session, null); assert.equal((await st.exportAll()).images.length, 0);
});

test('starting another exercise keeps the unfinished one; only an identical duplicate needs confirmation to be replaced', async () => {
  const st = await newStore(); await seed(st);
  const q = await newQuiz(st); await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' });
  const first = q.cur.id;
  const dup = await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' });             // same level/kind/mode: never a second copy
  assert.equal(dup.ok, false); assert.equal(dup.duplicate, true); assert.equal(dup.existing, first); assert.equal(q.cur.id, first); assert.equal(q.sessions.length, 1);
  assert.equal((await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' })).ok, true);   // a different exercise: both are kept
  assert.notEqual(q.cur.id, first); assert.equal(q.sessions.length, 2); assert.ok(q.sessions.some(x => x.id === first)); assert.equal(q.records.length, 0);
  assert.equal((await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice', confirm: () => false })).duplicate, true);   // declined replacement changes nothing
  assert.equal((await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice', confirm: () => true })).ok, true);         // explicit replacement of the duplicate only
  assert.equal(q.sessions.length, 2); assert.ok(!q.sessions.some(x => x.id === first)); assert.ok(q.sessions.some(x => x.kind === 'write'));
});

test('revision attempts are new records and never overwrite the original', async () => {
  const st = await newStore(); await seed(st, 2);
  const q = await newQuiz(st); await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' });
  await q.answerRead(false); await q.answerRead(true);
  const orig = q.result; const snapshot = JSON.stringify(orig);
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'revision', parentId: orig.id, chars: orig.items.filter(x => !x.ok).map(x => ({ id: x.cid, c: x.c })) });
  await q.answerRead(true);
  assert.equal(q.records.length, 2); assert.equal(JSON.stringify(q.records.find(r => r.id === orig.id)), snapshot);
  assert.equal(q.records.find(r => r.mode === 'revision').parentId, orig.id);
});

test('level edits are persisted before the in-memory state changes', async () => {
  const st = await newStore(); const q = await seed(st);
  const bad = { ...st, saveLevels: async () => { throw fail(); } };
  q.store = bad;
  const r = await q.mutateLevels(ls => { ls[0].name = '壞'; });
  assert.equal(r.ok, false); assert.equal(q.levels[0].name, '一級');
  q.store = st; assert.equal((await q.mutateLevels(ls => { ls[0].name = '好'; })).ok, true);
  assert.equal((await newQuiz(st)).levels[0].name, '好');
});
