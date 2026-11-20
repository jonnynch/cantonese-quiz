/* Ending a practice/exam session early: answered questions are kept, unanswered ones are never counted as wrong. */
const test = require('node:test'), assert = require('node:assert/strict');
const { C, IMG, newStore, newQuiz, seed } = require('./helpers');

async function setup(n = 5) { const st = await newStore(); return { st, q: await seed(st, n) }; }
const readN = async (q, oks) => { for (const ok of oks) await q.answerRead(ok); };
const writeN = async (q, n) => { for (let i = 0; i < n; i++) await q.answerWrite(IMG + i); };

test('practice: ending early finalises only the answered questions; unanswered ones are not counted as incorrect', async () => {
  const { st, q } = await setup(5);
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); const id = q.cur.id, started = q.cur.started;
  await readN(q, [true, false]);
  const r = await q.endEarly(); assert.equal(r.ok, true);
  assert.equal(q.records.length, 1); const rec = q.records[0];
  assert.equal(rec.id, id); assert.equal(rec.items.length, 2); assert.equal(rec.endedEarly, true); assert.equal(rec.planned, 5); assert.equal(rec.started, started);
  assert.deepEqual(rec.items.map(x => x.ok), [true, false]); assert.equal(rec.items.filter(x => !x.ok).length, 1, 'only the real mistake is a mistake');
  assert.equal(q.result, rec); assert.equal(q.cur, null); assert.equal(q.sessions.length, 0);
  assert.equal(q.stats.size, 2); assert.equal([...q.stats.values()].reduce((n, r) => n + r.read.practice.attempts, 0), 2);        // unanswered questions leave no statistics
  assert.equal(q.openCorrections().length, 0);
  const q2 = await newQuiz(st); assert.equal(q2.records.length, 1); assert.equal(q2.sessions.length, 0); assert.equal(q2.cur, null); assert.equal(q2.records[0].items.length, 2);
});
test('exam: ending early keeps the completed questions and the question count it had planned', async () => {
  const { q } = await setup(22);
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'exam' }); assert.equal(q.cur.items.length, 20);
  await readN(q, [true, true, false, true, true, true, false]);
  assert.equal((await q.endEarly()).ok, true);
  const rec = q.records[0]; assert.equal(rec.mode, 'exam'); assert.equal(rec.items.length, 7); assert.equal(rec.planned, 20); assert.equal(rec.items.filter(x => x.ok).length, 5);
  assert.equal(q.stats.size, 7); [...q.stats.values()].forEach(r => assert.equal(r.read.exam.attempts, 1));
});
test('writing exam: the answered answers still go through the parent marking; the result and corrections come from those only', async () => {
  const { st, q } = await setup(22);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'exam' }); const id = q.cur.id; await writeN(q, 3);
  q.scheduleDraft(() => IMG + 'half', { immediate: true }); await q.flushDraft(); assert.equal((await st.getDraft(id)).data, IMG + 'half');   // an unsubmitted drawing of question 4
  assert.equal((await q.endEarly()).ok, true);
  assert.equal(q.records.length, 0, 'not finished until marked'); assert.equal(q.cur.phase, 'mark'); assert.equal(q.cur.items.length, 3); assert.equal(q.cur.planned, 20); assert.equal(q.cur.endedEarly, true);
  assert.equal(await st.getDraft(id), null, 'the unsubmitted drawing of the unanswered question is dropped');
  assert.equal(q.stats.size, 0); assert.equal((await q.finishMarking()).ok, false, 'every answered question must be marked first');
  await q.setOk(0, true); await q.setOk(1, false); await q.setOk(2, true);
  const q2 = await newQuiz(st); assert.equal(q2.sessions.length, 1); assert.equal(q2.cur.phase, 'mark'); assert.equal(q2.cur.items.length, 3);        // suspending during marking still works
  assert.equal((await q2.answerWrite(IMG + 'late')).ok, false, 'the question phase can never be resumed');
  assert.equal((await q2.finishMarking()).ok, true);
  const rec = q2.records[0]; assert.equal(rec.items.length, 3); assert.equal(rec.endedEarly, true); assert.equal(rec.planned, 20); assert.deepEqual(rec.items.map(x => x.ok), [true, false, true]);
  assert.equal(q2.corrections.length, 1); assert.equal(q2.corrections[0].items.length, 1, 'remediation only for the answered mistake'); assert.equal(q2.corrections[0].sourceId, rec.id);
  assert.equal(q2.stats.size, 3); assert.equal(q2.sessions.length, 0);
});
test('ending with nothing answered leaves no record and removes the session and its drawing', async () => {
  const { st, q } = await setup(3);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); const id = q.cur.id;
  q.scheduleDraft(() => IMG + 'x', { immediate: true }); await q.flushDraft();
  assert.equal((await q.endEarly()).ok, true);
  assert.equal(q.records.length, 0); assert.equal(q.sessions.length, 0); assert.equal(q.cur, null); assert.equal(q.result, null); assert.equal(await st.getDraft(id), null);
  assert.equal((await newQuiz(st)).sessions.length, 0);
});
test('an ended session cannot be resumed, and ending twice or concurrently creates one history entry', async () => {
  const { st, q } = await setup(4);
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); await readN(q, [true]);
  const [a, b] = await Promise.all([q.endEarly(), q.endEarly()]); assert.equal([a, b].filter(r => r.ok && !r.busy).length, 1);
  assert.equal((await q.endEarly()).ok, false); assert.equal(q.records.length, 1);
  assert.equal((await q.open('nope')).ok, false);
  const q2 = await newQuiz(st); assert.equal(q2.sessions.length, 0); assert.equal(q2.cur, null); assert.equal(q2.records.length, 1); assert.equal((await q2.endEarly()).ok, false);
  assert.equal((await newQuiz(st)).records.length, 1, 'still one entry after reopening');
});
test('a session awaiting marking is not ended this way; other sessions and open corrections are untouched', async () => {
  const { st, q } = await setup(4);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); await writeN(q, 4); await q.setOk(0, false); await q.setOk(1, true); await q.setOk(2, true); await q.setOk(3, true);
  assert.equal((await q.endEarly()).ok, false); await q.finishMarking();
  const corr = q.openCorrections()[0]; await q.savePending(corr.id, 0, IMG + 'p'); await q.submitAttempt(corr.id, 0); const before = JSON.stringify(q.correction(corr.id));
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); const other = q.cur.id; await readN(q, [true]);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'revision', parentId: 'x', chars: q.level('L1').chars.slice(0, 2) }); await q.answerWrite(IMG + 'r');
  assert.equal((await q.endEarly()).ok, true);                                                       // ends only the current session
  assert.equal(q.sessions.length, 2); assert.equal(q.sessions.find(x => x.id === other).i, 1); assert.equal(q.sessions.some(x => x.mode === 'revision' && x.phase === 'mark'), true);
  assert.equal(JSON.stringify(q.correction(corr.id)), before); assert.equal(q.records.length, 1);
  const q2 = await newQuiz(st); assert.equal(q2.sessions.length, 2); assert.equal(JSON.stringify(q2.correction(corr.id)), before);
});
test('suspend and resume are unchanged: progress, order and start time survive a reopen and the session can be ended later', async () => {
  const { st, q } = await setup(5);
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); const s0 = q.cur; await readN(q, [true, true]);
  const q2 = await newQuiz(st); assert.equal(q2.cur.i, 2); assert.equal(q2.cur.started, s0.started); assert.deepEqual(q2.cur.items.map(x => x.cid), s0.items.map(x => x.cid)); assert.equal(q2.records.length, 0);
  await readN(q2, [false]); assert.equal((await q2.endEarly()).ok, true); assert.equal(q2.records[0].items.length, 3);
});
test('backup keeps the early-end marker on results and on a session that waits for marking; invalid markers are rejected', async () => {
  const { q } = await setup(5);
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); await readN(q, [true, false]); await q.endEarly();
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); await writeN(q, 2); await q.endEarly();
  const { json } = await q.exportBackup(), text = JSON.stringify(json);
  assert.equal(json.data.records[0].endedEarly, true); assert.equal(json.data.records[0].planned, 5); assert.equal(json.data.sessions[0].endedEarly, true); assert.equal(json.data.sessions[0].planned, 5);
  const q2 = await newQuiz(await newStore()); await q2.importBackup(JSON.parse(text), 'replace', () => true);
  assert.equal(q2.records[0].endedEarly, true); assert.equal(q2.records[0].planned, 5); assert.equal(q2.sessions[0].endedEarly, true); assert.equal(q2.sessions[0].items.length, 2);
  const q3 = await newQuiz(await newStore()); await q3.importBackup(JSON.parse(text), 'merge'); assert.equal((await q3.importBackup(JSON.parse(text), 'merge')).aborted, undefined);
  const old = JSON.parse(text); delete old.data.records[0].endedEarly; delete old.data.records[0].planned;                  // an ordinary record has neither
  const q4 = await newQuiz(await newStore()); await q4.importBackup(old, 'replace', () => true); assert.equal(q4.records[0].endedEarly, undefined);
  const bad = JSON.parse(text); bad.data.records[0].endedEarly = 'yes'; await assert.rejects(() => q4.importBackup(bad, 'merge'), e => e.name === 'ImportError');
  const bad2 = JSON.parse(text); bad2.data.sessions[0].planned = 'x'; await assert.rejects(() => q4.importBackup(bad2, 'merge'), e => e.name === 'ImportError');
});
