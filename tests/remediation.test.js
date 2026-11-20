/* Writing remediation: write the character five times, THEN mark the five attempts; all five correct finishes it, any incorrect one starts a fresh set. */
const test = require('node:test'), assert = require('node:assert/strict');
const { C, IMG, newStore, newQuiz, seed } = require('./helpers');

async function setup() {
  const st = await newStore(), q = await seed(st, 4);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'exam', chars: q.level('L1').chars.slice(0, 3) });
  for (let i = 0; i < 3; i++) await q.answerWrite(IMG + 'a' + i);
  await q.setOk(0, false); await q.setOk(1, true); await q.setOk(2, false); await q.finishMarking();
  const c = q.correctionFor(q.records[0].id); return { st, q, c, id: c.id, record: JSON.stringify(q.records[0]) };
}
const it = (q, id, k = 0) => q.correction(id).items[k];
const ok = async p => assert.equal((await p).ok, true);
async function write(q, id, ci, n, tag = 'w') { for (let k = 0; k < n; k++) { await ok(q.savePending(id, ci, IMG + tag + k)); await ok(q.submitAttempt(id, ci)); } }
async function markAll(q, id, ci, marks) { for (let k = 0; k < 5; k++) await ok(q.markAttempt(id, ci, k, marks[k])); }

test('five attempts are written first; marking is impossible until all five are submitted, and the fifth opens the marking phase', async () => {
  const { q, id } = await setup();
  assert.equal(q.correction(id).items.length, 2); assert.equal(C.itemPhase(it(q, id)), 'write');
  for (let k = 0; k < 4; k++) {
    await write(q, id, 0, 1, 's' + k); assert.equal(C.itemPhase(it(q, id)), 'write'); assert.equal(it(q, id).attempts.filter(Boolean).length, k + 1);
    assert.equal((await q.markAttempt(id, 0, 0, true)).ok, false, 'no marking while writing'); assert.equal((await q.finishSet(id, 0)).ok, false);
    assert.deepEqual(it(q, id).marks, Array(5).fill(null));
  }
  assert.deepEqual(C.correctionPosition(q.correction(id)), { ci: 0, ai: 4, phase: 'write', saved: 4, total: 10 });
  await write(q, id, 0, 1, 's4'); assert.equal(C.itemPhase(it(q, id)), 'mark'); assert.deepEqual(C.correctionPosition(q.correction(id)), { ci: 0, ai: 0, phase: 'mark', saved: 5, total: 10 });
  assert.equal((await q.savePending(id, 0, IMG + 'x')).ok, false); assert.equal((await q.submitAttempt(id, 0)).ok, false); assert.equal((await q.saveAttempt(id, 0, 0, IMG + 'x')).ok, false);   // the five are final
});
test('a blank canvas can never be submitted; each attempt is saved as its own image and a pending drawing never counts', async () => {
  const { q, st, id } = await setup();
  assert.equal((await q.submitAttempt(id, 0)).ok, false);
  await ok(q.savePending(id, 0, IMG + 'draw')); assert.equal(it(q, id).attempts.filter(Boolean).length, 0);
  await ok(q.savePending(id, 0, null)); assert.equal((await q.submitAttempt(id, 0)).ok, false);
  assert.equal((await q.savePending(id, 0, 'not-an-image')).ok, false);
  await write(q, id, 0, 5); const ids = it(q, id).attempts; assert.equal(new Set(ids).size, 5);
  const imgs = (await st.exportAll()).images.filter(i => i.sid === id); assert.equal(imgs.length, 5); assert.equal(new Set(imgs.map(i => i.data)).size, 5);
});
test('the five attempts are marked individually; a mark can be changed before the set is finished', async () => {
  const { q, id } = await setup(); await write(q, id, 0, 5);
  assert.equal((await q.finishSet(id, 0)).ok, false, 'all five must be marked first');
  await ok(q.markAttempt(id, 0, 2, true)); assert.deepEqual(it(q, id).marks, [null, null, true, null, null]);              // independent of the others
  await ok(q.markAttempt(id, 0, 0, false)); await ok(q.markAttempt(id, 0, 0, true)); assert.equal(it(q, id).marks[0], true);   // changed
  assert.deepEqual(C.correctionPosition(q.correction(id)), { ci: 0, ai: 1, phase: 'mark', saved: 5, total: 10 });
  assert.equal((await q.markAttempt(id, 0, 5, true)).ok, false); assert.equal((await q.markAttempt(id, 0, 1, 'yes')).ok, false);
  await markAll(q, id, 0, [true, true, true, true, true]); assert.equal((await q.finishSet(id, 0)).ok, true);
  assert.equal(C.attemptsDone(it(q, id)), true); assert.equal(it(q, id).confirmed, true);
});
test('five correct marks finish the character; every character needs its own full set; then the activity can be completed', async () => {
  const { q, id } = await setup();
  assert.equal((await q.completeCorrection(id)).ok, false);
  await write(q, id, 0, 5); await markAll(q, id, 0, Array(5).fill(true)); assert.equal(C.attemptsDone(it(q, id)), false, 'not finished until the set is finished');
  assert.equal((await q.completeCorrection(id)).ok, false); await ok(q.finishSet(id, 0));
  assert.deepEqual(C.correctionPosition(q.correction(id)), { ci: 1, ai: 0, phase: 'write', saved: 5, total: 10 });
  assert.equal((await q.completeCorrection(id)).ok, false);
  await write(q, id, 1, 5, 'v'); await markAll(q, id, 1, Array(5).fill(true)); await ok(q.finishSet(id, 1));
  await ok(q.completeCorrection(id)); assert.equal(q.correction(id).state, 'done');
  assert.equal((await q.markAttempt(id, 0, 0, false)).ok, false, 'a finished activity is closed');
});
test('any incorrect mark resets the consecutive-correct count: the whole set is discarded and five completely new attempts are required', async () => {
  const { q, st, id } = await setup();
  await write(q, id, 0, 5, 'old'); const oldIds = it(q, id).attempts.slice();
  await markAll(q, id, 0, [true, true, true, true, false]);                                    // 4 correct, 1 incorrect
  await ok(q.finishSet(id, 0));
  const x = it(q, id); assert.deepEqual(x.attempts, Array(5).fill(null)); assert.deepEqual(x.marks, Array(5).fill(null)); assert.equal(x.pending, null); assert.equal(x.confirmed, false); assert.equal(x.failed, 1);
  assert.equal(C.itemPhase(x), 'write'); assert.deepEqual(C.correctionPosition(q.correction(id)), { ci: 0, ai: 0, phase: 'write', saved: 0, total: 10 });
  for (const o of oldIds) assert.equal(await st.getImage(o), null, 'the failed set is not kept or reused');
  assert.equal((await q.completeCorrection(id)).ok, false);
  await write(q, id, 0, 4, 'new');                                                              // four new ones are not enough: still writing, no marking
  assert.equal(C.itemPhase(it(q, id)), 'write'); assert.equal((await q.markAttempt(id, 0, 0, true)).ok, false);
  await write(q, id, 0, 1, 'new4'); const newIds = it(q, id).attempts; assert.equal(C.itemPhase(it(q, id)), 'mark');
  assert.equal(newIds.filter(i => oldIds.includes(i)).length, 0, 'every attempt of the new set is new');
  await markAll(q, id, 0, Array(5).fill(true)); await ok(q.finishSet(id, 0)); assert.equal(C.attemptsDone(it(q, id)), true); assert.equal(it(q, id).failed, 1);
  const imgs = (await st.exportAll()).images.filter(i => i.sid === id); assert.equal(imgs.length, 5, 'only the confirmed set remains');
});
test('a change of marks before finishing decides the outcome (incorrect -> correct completes, correct -> incorrect resets)', async () => {
  const { q, id } = await setup(); await write(q, id, 0, 5); await markAll(q, id, 0, [true, false, true, true, true]);
  await ok(q.markAttempt(id, 0, 1, true)); await ok(q.finishSet(id, 0)); assert.equal(C.attemptsDone(it(q, id)), true);
  await write(q, id, 1, 5, 'z'); await markAll(q, id, 1, Array(5).fill(true)); await ok(q.markAttempt(id, 1, 3, false)); await ok(q.finishSet(id, 1));
  assert.equal(C.attemptsDone(it(q, id, 1)), false); assert.equal(it(q, id, 1).attempts.filter(Boolean).length, 0);
});
test('resume restores the phase and progress: mid-writing, mid-marking (with the marks given) and after a reset; the original result is unchanged', async () => {
  const { st, q, id, record } = await setup(), n = q.records.length;
  await write(q, id, 0, 3); await ok(q.savePending(id, 0, IMG + 'unsubmitted'));
  let q2 = await newQuiz(st), c = q2.correction(id);
  assert.deepEqual(C.correctionPosition(c), { ci: 0, ai: 3, phase: 'write', saved: 3, total: 10 }); assert.equal((await st.getImage(c.items[0].pending)).data, IMG + 'unsubmitted');
  await write(q2, id, 0, 2, 'm'); await ok(q2.markAttempt(id, 0, 0, true)); await ok(q2.markAttempt(id, 0, 1, false));
  q2 = await newQuiz(st); assert.deepEqual(C.correctionPosition(q2.correction(id)), { ci: 0, ai: 2, phase: 'mark', saved: 5, total: 10 }); assert.deepEqual(it(q2, id).marks, [true, false, null, null, null]);
  await markAll(q2, id, 0, [true, true, true, true, false]); await ok(q2.finishSet(id, 0));
  q2 = await newQuiz(st); assert.deepEqual(C.correctionPosition(q2.correction(id)), { ci: 0, ai: 0, phase: 'write', saved: 0, total: 10 }); assert.equal(it(q2, id).failed, 1);
  assert.equal(JSON.stringify(q2.records[0]), record); assert.equal(q2.records.length, n); assert.equal(q2.stats.size, q.stats.size);        // score and statistics untouched
});
test('data saved by the previous attempt-by-attempt model is upgraded without losing a drawing', async () => {
  const { st, q, id } = await setup(), ids = ['i1', 'i2', 'i3', 'i4'];
  const old = JSON.parse(JSON.stringify(q.correction(id))); old.items[0].attempts = [ids[0], ids[1], ids[2], null, null]; old.items[0].pending = ids[3]; old.items[0].checking = true;
  delete old.items[0].marks; delete old.items[0].confirmed; delete old.items[0].failed; delete old.items[1].marks; delete old.items[1].confirmed; delete old.items[1].failed;
  old.items[1].attempts = ['j1', 'j2', 'j3', 'j4', 'j5'];                                      // an older finished character
  for (const i of [...ids, 'j1', 'j2', 'j3', 'j4', 'j5']) await st.saveCorrection(old, { id: i, sid: id, data: IMG + i }, null);
  const q2 = await newQuiz(st), c = q2.correction(id);
  assert.deepEqual(c.items[0].attempts, [ids[0], ids[1], ids[2], ids[3], null]); assert.deepEqual(c.items[0].marks, [true, true, true, null, null]); assert.equal(c.items[0].pending, null); assert.equal('checking' in c.items[0], false);
  assert.equal(C.itemPhase(c.items[0]), 'write'); assert.equal(C.attemptsDone(c.items[1]), true);
  assert.equal(C.attemptsDone({ attempts: ['a', 'b', 'c', 'd', 'e'] }), true, 'five saved attempts without any marks = an older finished character');
});
test('backup keeps the phase, marks, drawing and failed-set count (replace and merge); older and invalid data are handled', async () => {
  const { q, id } = await setup();
  await write(q, id, 0, 5, 'b'); await markAll(q, id, 0, [true, true, false, true, true]); await ok(q.finishSet(id, 0));   // a failed set: failed = 1
  await write(q, id, 0, 5, 'c'); await ok(q.markAttempt(id, 0, 0, true)); await ok(q.markAttempt(id, 0, 3, false));
  await write(q, id, 1, 2, 'd'); await ok(q.savePending(id, 1, IMG + 'pend'));
  const { json, missingImages } = await q.exportBackup(); assert.equal(missingImages, 0);
  const ex = json.data.corrections[0].items; assert.deepEqual(ex[0].marks, [true, null, null, false, null]); assert.equal(ex[0].failed, 1); assert.equal(ex[1].pending, IMG + 'pend'); assert.equal(ex[1].attempts.filter(Boolean).length, 2); assert.equal('checking' in ex[0], false);
  const text = JSON.stringify(json), q2 = await newQuiz(await newStore());
  await q2.importBackup(JSON.parse(text), 'replace', () => true);
  const got = q2.correction(id); assert.deepEqual(got.items[0].marks, [true, null, null, false, null]); assert.equal(got.items[0].failed, 1); assert.equal((await q2.store.getImage(got.items[1].pending)).data, IMG + 'pend');
  assert.deepEqual(C.correctionPosition(got), C.correctionPosition(q.correction(id)));
  const q3 = await newQuiz(await newStore()); await q3.importBackup(JSON.parse(text), 'merge');
  assert.equal((await q3.importBackup(JSON.parse(text), 'merge')).aborted, undefined);
  const diff = JSON.parse(text); diff.data.corrections[0].items[0].marks[1] = false; assert.equal((await q3.importBackup(diff, 'merge')).aborted, true);   // never overwritten
  const bad = [t => { t.data.corrections[0].items[0].marks = [true]; }, t => { t.data.corrections[0].items[0].marks[0] = 'yes'; }, t => { t.data.corrections[0].items[0].confirmed = 1; }, t => { t.data.corrections[0].items[0].failed = 'x'; }];
  for (const f of bad) { const b = JSON.parse(text); f(b); await assert.rejects(() => q3.importBackup(b, 'merge'), e => e.name === 'ImportError'); }
  const old = JSON.parse(text); for (const x of old.data.corrections[0].items) { delete x.marks; delete x.confirmed; delete x.failed; }          // a backup from before marking existed
  const q4 = await newQuiz(await newStore()); await q4.importBackup(old, 'replace', () => true);
  assert.equal(q4.correction(id).items[0].marks.length, 5); assert.equal(C.itemPhase(q4.correction(id).items[0]), 'done', 'five saved attempts and no marks = an older finished character');
  assert.equal(C.itemPhase(q4.correction(id).items[1]), 'write'); assert.equal(q4.correction(id).items[1].attempts.filter(Boolean).length, 2);   // two written so far: still writing
  const fix = JSON.parse(text); fix.data.corrections[0].items[0].confirmed = true;                                                             // "confirmed" without five correct marks is repaired
  const q5 = await newQuiz(await newStore()); await q5.importBackup(fix, 'replace', () => true); assert.equal(q5.correction(id).items[0].confirmed, false);
});
