const test = require('node:test'), assert = require('node:assert/strict');
const { S, IMG, newStore, newQuiz, seed } = require('./helpers');

const wait = ms => new Promise(r => setTimeout(r, ms));
const DELAY = 15;
async function setup(n = 3, wrapFn) {
  const st = await newStore(); await seed(st, n);
  const store = wrapFn ? wrapFn(st) : st;
  const q = await newQuiz(store, { draftDelay: DELAY });
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' });
  return { st, store, q };
}
/* wrapper that logs draft writes, tracks overlap and can delay / fail them */
function spy(st) {
  const w = { ...st, log: [], active: 0, maxActive: 0, delay: 0, failing: false };
  w.saveDraft = async d => {
    w.active++; w.maxActive = Math.max(w.maxActive, w.active);
    try { if (w.delay) await wait(w.delay); if (w.failing) throw new S.StorageError('write', 'full'); w.log.push('draft:' + d.data); return await st.saveDraft(d); }
    finally { w.active--; }
  };
  const ss = st.saveSession; w.saveSession = async (...a) => { w.log.push('session'); return ss(...a); };
  return w;
}

test('autosave: finishing a stroke saves the drawing after the debounce delay', async () => {
  const { st, q } = await setup();
  q.scheduleDraft(() => IMG + 'S1');
  assert.equal(await st.getDraft(), null, 'not written on every pointer event');
  await wait(DELAY * 4);
  const d = await st.getDraft(); assert.equal(d.data, IMG + 'S1'); assert.equal(d.sid, q.cur.id); assert.equal(d.qi, 0);
});

test('autosave: rapid strokes are coalesced and writes never overlap', async () => {
  let w; const { st, q } = await setup(3, st => (w = spy(st)));
  w.delay = 20;
  for (let i = 1; i <= 30; i++) { q.scheduleDraft(() => IMG + i); if (i % 5 === 0) await wait(2); }
  q.scheduleDraft(() => IMG + 'LAST', { immediate: true });
  q.scheduleDraft(() => IMG + 'LAST', { immediate: true });
  await q.flushDraft();
  assert.equal(w.maxActive, 1, 'writes must be serialised');
  assert.ok(w.log.length < 10, 'writes are coalesced, got ' + w.log.length);
  assert.equal((await st.getDraft()).data, IMG + 'LAST');
});

test('autosave: latest drawing is restored after a refresh', async () => {
  const { st, q } = await setup();
  q.scheduleDraft(() => IMG + 'OLD'); q.scheduleDraft(() => IMG + 'NEW'); await q.flushDraft();
  const q2 = await newQuiz(st);                                             // refresh
  const d = await q2.loadDraft(); assert.equal(d.data, IMG + 'NEW');
  assert.equal(q2.cur.i, 0);
});

test('autosave: clearing the canvas persists an empty drawing', async () => {
  const { st, q } = await setup();
  q.scheduleDraft(() => IMG + 'INK', { immediate: true }); await q.flushDraft();
  q.scheduleDraft(() => null, { immediate: true }); await q.flushDraft();
  assert.equal((await st.getDraft()).data, null);
  const d = await (await newQuiz(st)).loadDraft(); assert.equal(d.data, null);       // nothing to redraw after refresh
});

test('autosave: drafts are not shared between questions', async () => {
  const { st, q } = await setup();
  q.scheduleDraft(() => IMG + 'Q1'); await q.flushDraft();
  assert.equal((await q.answerWrite(IMG + 'FINAL')).ok, true);
  assert.equal(q.cur.i, 1);
  assert.equal(await q.loadDraft(), null); assert.equal(await st.getDraft(), null);   // draft removed with the answer
  await st.saveDraft({ sid: q.cur.id, qi: 0, cid: q.cur.items[0].cid, seq: 1, data: IMG + 'STALE' });
  assert.equal(await q.loadDraft(), null, 'a draft for question 1 must not appear on question 2');
  await st.saveDraft({ sid: q.cur.id, qi: 1, cid: 'someone-else', seq: 2, data: IMG + 'WRONGCID' });
  assert.equal(await q.loadDraft(), null);
  q.scheduleDraft(() => IMG + 'Q2'); await q.flushDraft();
  assert.equal((await q.loadDraft()).data, IMG + 'Q2');
});

test('autosave: drafts are not shared between sessions', async () => {
  const { st, q } = await setup();
  q.scheduleDraft(() => IMG + 'A'); await q.flushDraft();
  assert.equal((await q.discard(() => true)).ok, true);
  assert.equal(await st.getDraft(), null);                                          // discarding removes the draft
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' });
  assert.equal(await q.loadDraft(), null);
  await st.saveDraft({ sid: 'another-session', qi: 0, cid: q.cur.items[0].cid, seq: 1, data: IMG + 'X' });
  assert.equal(await q.loadDraft(), null);
  q.scheduleDraft(() => IMG + 'B'); await q.flushDraft();                           // explicitly starting over the same exercise also clears ITS draft
  const old = q.cur.id; assert.equal((await st.getDraft(old)).data, IMG + 'B');
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice', confirm: () => true });
  assert.equal(await st.getDraft(old), null); assert.equal(await q.loadDraft(), null);
});

test('autosave: completing a question waits for the pending autosave', async () => {
  let w; const { st, q } = await setup(3, st => (w = spy(st)));
  w.delay = 30;
  q.scheduleDraft(() => IMG + 'PENDING');
  const r = await q.answerWrite(IMG + 'FINAL');
  assert.equal(r.ok, true);
  assert.deepEqual(w.log, ['draft:' + IMG + 'PENDING', 'session'], 'draft written before the answer is committed');
  assert.equal(q.cur.i, 1); assert.equal(await st.getDraft(), null);
});

test('autosave: a failed autosave blocks completion, keeps the drawing, and can be retried', async () => {
  let w; const { st, q } = await setup(3, st => (w = spy(st)));
  const errors = []; q.onDraftError = e => errors.push(e.code);
  w.failing = true;
  q.scheduleDraft(() => IMG + 'KEEP', { immediate: true });
  await assert.rejects(q.flushDraft(), { code: 'write' });
  assert.deepEqual(errors, ['write', 'write'].slice(0, errors.length)); assert.ok(errors.length >= 1);
  const r = await q.answerWrite(IMG + 'FINAL');
  assert.equal(r.ok, false); assert.equal(q.cur.i, 0); assert.equal(q.cur.items[0].imgId, null);
  assert.equal((await st.loadAll()).session.i, 0); assert.equal((await st.exportAll()).images.length, 0);
  w.failing = false; let ok = 0; q.onDraftOk = () => ok++;
  assert.equal((await q.retryLast()).ok, true);
  assert.equal(q.cur.i, 1); assert.equal(ok, 1); assert.equal((await st.exportAll()).images[0].data, IMG + 'FINAL');
});

test('autosave: a failed autosave keeps the pending drawing so a manual retry writes it', async () => {
  let w; const { st, q } = await setup(3, st => (w = spy(st)));
  w.failing = true; q.scheduleDraft(() => IMG + 'KEEP', { immediate: true });
  await assert.rejects(q.flushDraft());
  w.failing = false; await q.flushDraft();
  assert.equal((await st.getDraft()).data, IMG + 'KEEP');
});

test('autosave: an older write can never overwrite a newer drawing', async () => {
  const st = await newStore();
  const base = { sid: 's', qi: 0, cid: 'c1' };
  await st.saveDraft({ ...base, seq: 5, data: 'NEW' });
  await st.saveDraft({ ...base, seq: 4, data: 'OLD' });                             // arrives late
  assert.equal((await st.getDraft()).data, 'NEW');
  await st.saveDraft({ ...base, qi: 1, cid: 'c2', seq: 1, data: 'NEXTQ' });          // different question always replaces
  assert.equal((await st.getDraft()).data, 'NEXTQ');
  // through the controller: a slow earlier write plus a later one end with the later drawing
  let w; const { st: st2, q } = await setup(3, s => (w = spy(s)));
  w.delay = 25; q.scheduleDraft(() => IMG + 'first', { immediate: true }); await wait(5);
  q.scheduleDraft(() => IMG + 'second', { immediate: true }); await q.flushDraft();
  assert.equal((await st2.getDraft()).data, IMG + 'second');
});

test('autosave: a draft pending for a question that was already left is dropped, not written to the next one', async () => {
  const { st, q } = await setup();
  q.scheduleDraft(() => IMG + 'LATE');
  q._pend.qi = 99;                                                                   // simulate the question having changed
  await q.flushDraft();
  assert.equal(await st.getDraft(), null);
});

test('autosave: flushing with nothing pending does not block later autosaves', async () => {
  const { st, q } = await setup();
  await q.flushDraft(); await q.flushDraft();
  q.scheduleDraft(() => IMG + 'AFTER', { immediate: true });
  await q.flushDraft();
  assert.equal((await st.getDraft()).data, IMG + 'AFTER');
});
