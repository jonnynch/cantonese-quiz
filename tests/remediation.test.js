/* Writing remediation model: one attempt at a time, five CONSECUTIVE parent-confirmed correct attempts, restart at 0 after a wrong one. */
const test = require('node:test'), assert = require('node:assert/strict');
const { C, IMG, newStore, newQuiz, seed } = require('./helpers');

async function setup() {
  const st = await newStore(), q = await seed(st, 4);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'exam', chars: q.level('L1').chars.slice(0, 3) });
  for (let i = 0; i < 3; i++) await q.answerWrite(IMG + 'a' + i);
  await q.setOk(0, false); await q.setOk(1, true); await q.setOk(2, false); await q.finishMarking();
  const c = q.correctionFor(q.records[0].id); return { st, q, c, id: c.id, record: JSON.stringify(q.records[0]) };
}
const it0 = (q, id, k = 0) => q.correction(id).items[k];
async function attempt(q, id, ci, ok, tag = 'x') { assert.equal((await q.savePending(id, ci, IMG + tag)).ok, true); assert.equal((await q.submitPending(id, ci)).ok, true); return q.markPending(id, ci, ok); }

test('a correct attempt adds one consecutive correct attempt and the pending canvas is cleared for the next', async () => {
  const { q, id } = await setup();
  assert.equal(q.correction(id).items.length, 2); assert.deepEqual([it0(q, id).pending, it0(q, id).checking], [null, false]);
  assert.equal((await attempt(q, id, 0, true, 'p1')).ok, true);
  assert.equal(it0(q, id).attempts.filter(Boolean).length, 1); assert.equal(it0(q, id).pending, null); assert.equal(it0(q, id).checking, false);
  assert.equal((await attempt(q, id, 0, true, 'p2')).ok, true); assert.deepEqual(C.correctionPosition(q.correction(id)), { ci: 0, ai: 2, saved: 2, total: 10 });
});
test('five consecutive correct attempts complete a character; a wrong attempt resets the count to zero and discards the streak', async () => {
  const { q, st, id } = await setup();
  for (let k = 0; k < 4; k++) await attempt(q, id, 0, true, 'g' + k);
  const kept = it0(q, id).attempts.filter(Boolean); assert.equal(kept.length, 4); assert.equal(C.attemptsDone(it0(q, id)), false);
  assert.equal((await attempt(q, id, 0, false, 'bad')).ok, true);                                    // the 5th is wrong
  assert.equal(it0(q, id).attempts.filter(Boolean).length, 0); assert.equal(it0(q, id).pending, null);
  for (const k of kept) assert.equal(await st.getImage(k), null, 'the discarded streak is not kept');
  assert.equal((await q.completeCorrection(id)).ok, false);
  for (let k = 0; k < 5; k++) { assert.equal(C.attemptsDone(it0(q, id)), false); await attempt(q, id, 0, true, 'h' + k); }
  assert.equal(C.attemptsDone(it0(q, id)), true); assert.equal((await q.markPending(id, 0, true)).ok, false);                       // nothing more to mark
  assert.equal((await q.savePending(id, 0, IMG + 'extra')).ok, false, 'a finished character takes no more attempts');
  assert.equal((await q.completeCorrection(id)).ok, false, 'the second character is still open');
  for (let k = 0; k < 5; k++) await attempt(q, id, 1, true, 'i' + k);
  assert.equal((await q.completeCorrection(id)).ok, true); assert.equal(q.correction(id).state, 'done');
});
test('an empty canvas can never be submitted or counted; an unmarked attempt does not count; a submitted attempt is locked', async () => {
  const { q, id } = await setup();
  assert.equal((await q.submitPending(id, 0)).ok, false); assert.equal((await q.markPending(id, 0, true)).ok, false);
  await q.savePending(id, 0, IMG + 'one'); assert.equal(it0(q, id).attempts.filter(Boolean).length, 0);
  await q.savePending(id, 0, null); assert.equal(it0(q, id).pending, null); assert.equal((await q.submitPending(id, 0)).ok, false);   // cleared again
  await q.savePending(id, 0, IMG + 'two'); await q.submitPending(id, 0);
  assert.equal((await q.savePending(id, 0, IMG + 'change')).ok, false); assert.equal(it0(q, id).attempts.filter(Boolean).length, 0);
  assert.equal((await q.savePending(id, 0, 'not-an-image')).ok, false);
});
test('remediation never changes the original record or score, adds no records, and survives reopening mid-attempt', async () => {
  const { st, q, id, record } = await setup(), n = q.records.length;
  for (let k = 0; k < 3; k++) await attempt(q, id, 0, k !== 1, 'r' + k);
  await q.savePending(id, 0, IMG + 'drawing'); await q.submitPending(id, 0);
  const q2 = await newQuiz(st), c = q2.correction(id);
  assert.equal(c.state, 'open'); assert.equal(c.items[0].checking, true); assert.equal((await st.getImage(c.items[0].pending)).data, IMG + 'drawing');
  assert.deepEqual(C.correctionPosition(c), { ci: 0, ai: 1, saved: 1, total: 10 });                 // correct, WRONG (restart), correct: a streak of 1
  assert.equal(JSON.stringify(q2.records[0]), record); assert.equal(q2.records.length, n); assert.equal(q2.stats.size, q.stats.size);   // score and statistics untouched
  assert.equal((await q2.markPending(id, 0, true)).ok, true); assert.equal(q2.correction(id).items[0].attempts.filter(Boolean).length, 2);
});
test('backup keeps the pending and submitted attempt of a correction (replace and merge); invalid combinations are rejected or repaired', async () => {
  const { q, id } = await setup();
  await attempt(q, id, 0, true, 'k0'); await q.savePending(id, 0, IMG + 'pend'); await q.submitPending(id, 0);
  const { json, missingImages } = await q.exportBackup(); assert.equal(missingImages, 0);
  const ex = json.data.corrections[0].items[0]; assert.equal(ex.pending, IMG + 'pend'); assert.equal(ex.checking, true); assert.equal(ex.attempts.filter(Boolean).length, 1);
  const text = JSON.stringify(json), q2 = await newQuiz(await newStore());
  await q2.importBackup(JSON.parse(text), 'replace', () => true);
  const got = q2.correction(id).items[0]; assert.equal(got.checking, true); assert.equal(got.attempts.filter(Boolean).length, 1); assert.equal((await q2.store.getImage(got.pending)).data, IMG + 'pend');
  const q3 = await newQuiz(await newStore()); await q3.importBackup(JSON.parse(text), 'merge'); assert.equal(q3.correction(id).items[0].checking, true);
  const again = await q3.importBackup(JSON.parse(text), 'merge'); assert.equal(again.aborted, undefined); assert.equal(again.added.corrections, 0);
  const diff = JSON.parse(text); diff.data.corrections[0].items[0].pending = IMG + 'other'; assert.equal((await q3.importBackup(diff, 'merge')).aborted, true);   // never overwritten
  const old = JSON.parse(text); delete old.data.corrections[0].items[0].pending; delete old.data.corrections[0].items[0].checking;                             // an older backup has neither field
  const q4 = await newQuiz(await newStore()); await q4.importBackup(old, 'replace', () => true); assert.equal(q4.correction(id).items[0].pending, null); assert.equal(q4.correction(id).items[0].checking, false);
  const bad = JSON.parse(text); bad.data.corrections[0].items[0].checking = 'yes'; await assert.rejects(() => (async () => q4.importBackup(bad, 'merge'))(), e => e.name === 'ImportError');
  const lone = JSON.parse(text); lone.data.corrections[0].items[0].pending = null; lone.data.corrections[0].items[0].checking = true;
  const q5 = await newQuiz(await newStore()); await q5.importBackup(lone, 'replace', () => true); assert.equal(q5.correction(id).items[0].checking, false, 'checking without a drawing is repaired');
});
