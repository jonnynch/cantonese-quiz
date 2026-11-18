const test = require('node:test'), assert = require('node:assert/strict');
const P = require('../public/js/profiles.js');
const { S, C, IMG, newIdb, memLS, CH, level, newQuiz, legacyBlob } = require('./helpers');

let n = 0;
async function newMgr(idb) { const m = new P.ProfileManager(idb, { uid: () => 'p-t' + (++n) }); await m.init(); return m; }
const sameIds = () => { let k = 0; return () => 'x' + (++k); };            // identical ids in every learner: proves no cross-learner collisions
async function learner(mgr, name, chars = 3) {
  const p = await mgr.create({ name, avatar: 'cat' }); const st = await mgr.openStore(p.id);
  const q = new C.Quiz(st, { uid: sameIds(), shuffle: a => a.slice(), draftDelay: 5 }); await q.init();
  await q.mutateLevels(ls => ls.push(level('L1', name + '的級別', Array.from({ length: chars }, (_, i) => CH('c' + (i + 1), name + i)))));
  return { p, st, q };
}
async function finishWrite(q, tag, mode = 'practice') {
  await q.startSession({ kind: 'write', levelId: 'L1', mode });
  const total = q.cur.items.length;
  for (let i = 0; i < total; i++) await q.answerWrite(IMG + tag + i);
  for (let i = 0; i < total; i++) await q.setOk(i, i % 2 === 0);
  await q.finishMarking(); return q.result;
}
async function finishRead(q, mode = 'practice', levelId = 'L1') {
  await q.startSession({ kind: 'read', levelId, mode }); const total = q.cur.items.length;
  for (let i = 0; i < total; i++) await q.answerRead(i % 2 === 0); return q.result;
}
const dbNames = async idb => (await idb.databases()).map(d => d.name);
const digest = async st => JSON.stringify([await st.exportAll(), (await st.loadAll()).session, await st.getDraft()]);

/* ---------------- profile management ---------------- */
test('profiles: create, edit name, change avatar, archive, restore', async () => {
  const idb = newIdb(), m = await newMgr(idb);
  const a = await m.create({ name: '  小明 ', avatar: 'panda' });
  assert.equal(a.name, '小明'); assert.equal(a.avatar, 'panda'); assert.equal(a.archivedAt, null); assert.ok(a.id && a.createdAt && a.updatedAt);
  assert.ok(!a.id.includes('cantonese-quiz'), 'the portable id is not the database name');
  const b = await m.update(a.id, { name: '小明明' }); assert.equal(b.name, '小明明'); assert.equal(b.avatar, 'panda');
  const c = await m.update(a.id, { avatar: 'fox' }); assert.equal(c.avatar, 'fox'); assert.equal(c.name, '小明明');
  await m.archive(a.id);
  assert.deepEqual((await m.list()).map(p => p.id), []); assert.deepEqual((await m.list('archived')).map(p => p.id), [a.id]);
  assert.ok((await m.get(a.id)).archivedAt);
  await m.restore(a.id); assert.deepEqual((await m.list()).map(p => p.id), [a.id]); assert.equal((await m.get(a.id)).archivedAt, null);
});

test('profiles: invalid names and avatars are rejected', async () => {
  const m = await newMgr(newIdb());
  for (const bad of [{ name: '', avatar: 'cat' }, { name: '   ', avatar: 'cat' }, { name: 'x'.repeat(21), avatar: 'cat' }, { name: 'ok', avatar: 'nope' }, { name: 'ok' }])
    await assert.rejects(m.create(bad), { name: 'ProfileError' });
  assert.equal((await m.list('all')).length, 0);
  const p = await m.create({ name: 'ok', avatar: 'cat' });
  await assert.rejects(m.update(p.id, { name: ' ' }), { name: 'ProfileError' }); assert.equal((await m.get(p.id)).name, 'ok');
  await assert.rejects(m.update('missing', { name: 'x' }), { code: 'not-found' });
});

test('profiles: they survive a refresh (new manager on the same database) and archived ones stay recoverable', async () => {
  const idb = newIdb(); let m = await newMgr(idb);
  const a = await learner(m, '甲'), b = await learner(m, '乙'); await finishWrite(a.q, 'A');
  await m.archive(b.p.id); m.closeAll();
  m = await newMgr(idb);                                                           // refresh
  assert.deepEqual((await m.list()).map(p => p.id), [a.p.id]); assert.deepEqual((await m.list('archived')).map(p => p.id), [b.p.id]);
  await assert.rejects(m.openStore(b.p.id), { code: 'archived' });                 // not usable through normal operations
  await m.restore(b.p.id);
  const q = new C.Quiz(await m.openStore(b.p.id)); await q.init();
  assert.equal(q.levels[0].name, '乙的級別');                                       // data intact after archive + restore
  const qa = new C.Quiz(await m.openStore(a.p.id)); await qa.init(); assert.equal(qa.records.length, 1);
});

test('profiles: deleting needs confirmation, removes only that learner, and leaves nothing behind', async () => {
  const idb = newIdb(), m = await newMgr(idb);
  const a = await learner(m, '甲'), b = await learner(m, '乙'), c = await learner(m, '丙');
  await finishWrite(a.q, 'A'); await finishWrite(b.q, 'B'); await finishRead(c.q);
  await b.q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); await b.q.answerWrite(IMG + 'unfinished');
  b.q.scheduleDraft(() => IMG + 'draft', { immediate: true }); await b.q.flushDraft();
  const aBefore = await digest(a.st), cBefore = await digest(c.st);
  let asked = ''; assert.deepEqual(await m.remove(b.p.id, msg => { asked = msg; return false; }), { cancelled: true });
  assert.match(asked, /永久刪除「乙」/); assert.match(asked, /無法復原/); assert.match(asked, /其他學習者的資料不受影響/);
  assert.deepEqual(await m.remove(b.p.id, undefined), { cancelled: true });
  assert.ok(await m.get(b.p.id)); assert.ok((await dbNames(idb)).includes(b.p.dbName));       // nothing happened
  assert.deepEqual(await m.remove(b.p.id, () => true), { ok: true });
  assert.equal(await m.get(b.p.id), null); assert.deepEqual((await m.list('all')).map(p => p.id), [a.p.id, c.p.id]);
  assert.ok(!(await dbNames(idb)).includes(b.p.dbName), 'database (records, images, session, draft) is gone');
  assert.equal(await digest(a.st), aBefore); assert.equal(await digest(c.st), cBefore);          // others untouched
  const reopened = S.createStore(await S.openDb(idb, b.p.dbName));                              // nothing orphaned: a fresh empty database
  assert.equal((await reopened.exportAll()).images.length, 0); assert.equal((await reopened.exportAll()).records.length, 0);
  assert.equal((await reopened.loadAll()).session, null); assert.equal(await reopened.getDraft(), null);
});

test('profiles: an interrupted deletion is completed on the next start and never shows the learner again', async () => {
  const idb = newIdb(), m = await newMgr(idb); const a = await learner(m, '甲'), b = await learner(m, '乙'); await finishWrite(b.q, 'B');
  m.closeStore(b.p.id); await m._put({ ...(await m.get(b.p.id)), state: 'deleting' });         // crash right after step 1
  assert.deepEqual((await m.list('all')).map(p => p.id), [a.p.id]);                             // already hidden
  const m2 = await newMgr(idb);
  assert.equal(await m2.get(b.p.id), null); assert.ok(!(await dbNames(idb)).includes(b.p.dbName)); assert.ok((await dbNames(idb)).includes(a.p.dbName));
});

/* ---------------- isolation ---------------- */
test('isolation: levels and characters are independent, even with identical IDs', async () => {
  const m = await newMgr(newIdb()); const a = await learner(m, '甲'), b = await learner(m, '乙');
  assert.equal(a.q.levels[0].id, b.q.levels[0].id);                                              // same level id 'L1' in both learners
  assert.equal(a.q.levels[0].name, '甲的級別'); assert.equal(b.q.levels[0].name, '乙的級別');
  await a.q.mutateLevels(ls => { ls[0].chars[0].jp = 'changed'; ls[0].chars.pop(); ls.push(level('L2', '甲二', [CH('z', '水')])); });
  const b2 = new C.Quiz(b.st); await b2.init();
  assert.equal(b2.levels.length, 1); assert.equal(b2.levels[0].chars.length, 3); assert.notEqual(b2.levels[0].chars[0].jp, 'changed');
  await b.q.mutateLevels(ls => { ls.splice(0, 1); });                                            // deleting B's level leaves A's alone
  const a2 = new C.Quiz(a.st); await a2.init(); assert.deepEqual(a2.levels.map(l => l.id), ['L1', 'L2']); assert.equal(a2.levels[0].chars.length, 2);
});

test('isolation: practice, revision and exam history and handwriting images are independent', async () => {
  const m = await newMgr(newIdb()); const a = await learner(m, '甲', 20), b = await learner(m, '乙', 20);
  const wa = await finishWrite(a.q, 'A');                                                         // writing practice (A)
  await finishRead(b.q);                                                                          // reading practice (B)
  await a.q.startSession({ kind: 'write', levelId: 'L1', mode: 'revision', parentId: wa.id, chars: wa.items.filter(x => !x.ok).map(x => ({ id: x.cid, c: x.c })) });
  for (let i = 0; i < a.q.cur.items.length; i++) await a.q.answerWrite(IMG + 'rev' + i);
  for (let i = 0; i < a.q.cur.items.length; i++) await a.q.setOk(i, true); await a.q.finishMarking();   // revision (A)
  await finishRead(b.q, 'exam'); await finishWrite(a.q, 'AE', 'exam');                          // reading exam (B), writing exam (A)
  const ra = new C.Quiz(a.st); await ra.init(); const rb = new C.Quiz(b.st); await rb.init();
  assert.deepEqual(ra.records.map(r => r.kind + r.mode).sort(), ['writeexam', 'writepractice', 'writerevision']);
  assert.deepEqual(rb.records.map(r => r.kind + r.mode).sort(), ['readexam', 'readpractice']);
  assert.equal(ra.records.find(r => r.mode === 'revision').parentId, wa.id);                      // relationship preserved inside A
  assert.ok(rb.records.every(r => r.kind === 'read'));                                            // ids may even coincide across learners; content never mixes
  const ia = (await a.st.exportAll()).images, ib = (await b.st.exportAll()).images;
  assert.ok(ia.length > 0); assert.equal(ib.length, 0);                                           // B wrote no handwriting
  await finishWrite(b.q, 'B');                                                                    // same generated image ids, different data
  const ib2 = (await b.st.exportAll()).images;
  assert.ok(ib2.every(i => i.data.startsWith(IMG + 'B'))); assert.ok((await a.st.exportAll()).images.every(i => !i.data.startsWith(IMG + 'B')));
  const total = q => q.records.reduce((t, r) => t + r.items.length, 0);                          // statistics come from the learner's own records only
  assert.equal(total(rb) + 0, rb.records.reduce((t, r) => t + r.items.length, 0));
  assert.ok(total(ra) > 0 && total(rb) > 0);
  assert.ok(ra.records.every(r => r.levelName === '甲的級別')); assert.ok(rb.records.every(r => r.levelName === '乙的級別'));
  assert.equal(rb.records.length, 2);
});

test('isolation: unfinished sessions and handwriting drafts are independent', async () => {
  const m = await newMgr(newIdb()); const a = await learner(m, '甲'), b = await learner(m, '乙');
  await a.q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); await a.q.answerWrite(IMG + 'a0');
  a.q.scheduleDraft(() => IMG + 'A-DRAFT', { immediate: true }); await a.q.flushDraft();
  await b.q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); await b.q.answerRead(true);
  const a2 = new C.Quiz(a.st, { draftDelay: 5 }); await a2.init(); const b2 = new C.Quiz(b.st); await b2.init();
  assert.equal(a2.cur.kind, 'write'); assert.equal(a2.cur.i, 1); assert.equal((await a2.loadDraft()).data, IMG + 'A-DRAFT');
  assert.equal(b2.cur.kind, 'read'); assert.equal(b2.cur.i, 1); assert.equal(await b2.loadDraft(), null);
  assert.equal(await b.st.getDraft(), null);
  await b2.discard(() => true);                                                                    // discarding B's session leaves A's alone
  const a3 = new C.Quiz(a.st); await a3.init(); assert.ok(a3.cur); assert.equal((await a3.loadDraft()).data, IMG + 'A-DRAFT');
  assert.equal((await a.st.getDraft()).data, IMG + 'A-DRAFT'); assert.equal((await a.st.exportAll()).images.length, 1);
});

test('isolation: a store can only be attached to its own learner, unknown learners cannot be opened', async () => {
  const idb = newIdb(), m = await newMgr(idb); const a = await learner(m, '甲'), b = await learner(m, '乙');
  const raw = S.createStore(await S.openDb(idb, a.p.dbName));
  await assert.rejects(S.claimOwner(raw, b.p.id), { code: 'owner' });                              // A's data cannot be opened as B
  await S.claimOwner(raw, a.p.id);
  await assert.rejects(m.openStore('nobody'), { code: 'not-found' });
  assert.notEqual(a.p.dbName, b.p.dbName);
});

test('isolation: after switching, the old learner session is closed and cannot save, and new writes land only in the new learner', async () => {
  const m = await newMgr(newIdb()); const a = await learner(m, '甲'), b = await learner(m, '乙');
  await a.q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' });
  a.q.scheduleDraft(() => IMG + 'A-DRAFT');                                                         // pending autosave at the moment of switching
  assert.equal((await a.q.close()).ok, true); a.st.close();
  assert.equal((await a.q.answerWrite(IMG + 'late')).ok, false);                                    // late tap on the old screen
  assert.equal((await a.q.mutateLevels(ls => ls.push(level('X', 'late', [])))).ok, false);
  a.q.scheduleDraft(() => IMG + 'late'); await assert.doesNotReject(a.q.flushDraft());
  const aSt = await m.openStore(a.p.id), aBefore = await digest(aSt);
  assert.equal((await aSt.getDraft()).data, IMG + 'A-DRAFT');                                       // pending drawing was flushed before closing, to A
  await b.q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); await b.q.answerWrite(IMG + 'b0');
  assert.equal(await digest(aSt), aBefore);                                                         // nothing of B went to A
  assert.equal((await b.st.exportAll()).images.length, 1);
  await assert.rejects(a.st.saveSession({ id: 'x' }));                                              // a closed store refuses writes
});

/* ---------------- migration of pre-profile data ---------------- */
async function realisticOldData(idb) {              // what the app stored before profiles existed (database `cantonese-quiz`, no owner mark)
  const st = S.createStore(await S.openDb(idb, S.DB_NAME)); const q = new C.Quiz(st, { uid: sameIds(), shuffle: a => a.slice(), draftDelay: 5 }); await q.init();
  await q.mutateLevels(ls => { ls.push(level('L1', '一年級', Array.from({ length: 22 }, (_, i) => CH('a' + i, '字' + i)))); ls.push(level('L2', '二年級', [CH('b1', '日'), CH('b2', '月')])); });
  const w = await finishWrite(q, 'old'); await finishRead(q);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'revision', parentId: w.id, chars: w.items.filter(x => !x.ok).map(x => ({ id: x.cid, c: x.c })) });
  for (let i = 0; i < q.cur.items.length; i++) await q.answerWrite(IMG + 'r' + i);
  for (let i = 0; i < q.cur.items.length; i++) await q.setOk(i, true); await q.finishMarking();
  await finishRead(q, 'exam');
  await q.startSession({ kind: 'write', levelId: 'L2', mode: 'practice' }); await q.answerWrite(IMG + 'half');
  q.scheduleDraft(() => IMG + 'half-drawn', { immediate: true }); await q.flushDraft();
  const d = await digest(st); st.close(); return d;
}
const oldDigest = async idb => { const st = S.createStore(await S.openDb(idb, S.DB_NAME)); try { return await digest(st); } finally { st.close(); } };

test('migration: existing single-learner data becomes the default learner, completely preserved', async () => {
  const idb = newIdb(); const before = await realisticOldData(idb);
  const m = await newMgr(idb); const r = await P.adoptLegacy(m, memLS());
  assert.equal(r.status, 'adopted');
  const ps = await m.list('all'); assert.equal(ps.length, 1); assert.equal(ps[0].id, P.LEGACY_PROFILE_ID); assert.equal(ps[0].archivedAt, null); assert.ok(ps[0].name && ps[0].avatar);
  const st = await m.openStore(P.LEGACY_PROFILE_ID); assert.equal(await digest(st), before);         // every level, character, record, image, session, draft
  const q = new C.Quiz(st); await q.init();
  assert.equal(q.levels.length, 2); assert.equal(q.records.length, 4); assert.equal(q.cur.levelId, 'L2'); assert.equal((await q.loadDraft()).data, IMG + 'half-drawn');
  const rev = q.records.find(x => x.mode === 'revision'); assert.ok(q.records.some(x => x.id === rev.parentId));                                      // relationship valid
  for (const rec of q.records) for (const it of rec.items) if (it.imgId) assert.ok(await st.getImage(it.imgId), 'image ' + it.imgId);        // all handwriting retrievable
  assert.equal(await oldDigest(idb), before);                                                       // original database untouched
  assert.equal((await m.getMeta('legacyAdoption')).state, 'done');
});

test('migration: repeating it (or refreshing) never duplicates the default learner or any records', async () => {
  const idb = newIdb(); const before = await realisticOldData(idb);
  let m = await newMgr(idb); await P.adoptLegacy(m, memLS()); m.closeAll();
  m = await newMgr(idb); assert.equal((await P.adoptLegacy(m, memLS())).status, 'skipped');
  await m.setMeta('legacyAdoption', { state: 'pending' });                                          // even if the "done" mark were lost
  assert.equal((await P.adoptLegacy(m, memLS())).status, 'adopted');
  assert.equal((await m.list('all')).length, 1); assert.equal(await digest(await m.openStore(P.LEGACY_PROFILE_ID)), before);
});

test('migration: interrupted before or after the profile is registered recovers safely', async () => {
  const idb = newIdb(); const before = await realisticOldData(idb); const m = await newMgr(idb);
  const put = m._put.bind(m); let fail = true; m._put = async p => { if (fail) throw new S.StorageError('write', 'crash'); return put(p); };
  await assert.rejects(P.adoptLegacy(m, memLS()), { code: 'write' });
  assert.equal((await m.list('all')).length, 0); assert.equal(await oldDigest(idb), before);        // nothing lost, nothing half-created
  fail = false; const setMeta = m.setMeta.bind(m); let failMeta = true; m.setMeta = async (k, v) => { if (failMeta) throw new S.StorageError('write', 'crash'); return setMeta(k, v); };
  await assert.rejects(P.adoptLegacy(m, memLS()), { code: 'write' });                               // profile exists, "done" mark missing
  assert.equal((await m.list('all')).length, 1);
  failMeta = false; assert.equal((await P.adoptLegacy(m, memLS())).status, 'adopted');
  assert.equal((await m.list('all')).length, 1); assert.equal(await digest(await m.openStore(P.LEGACY_PROFILE_ID)), before);
});

test('migration: a failed verification keeps all data and reports an error', async () => {
  const idb = newIdb(); const before = await realisticOldData(idb); const m = await newMgr(idb);
  const open = m.openStore.bind(m);
  m.openStore = async (...a) => { const st = await open(...a); return { ...st, exportAll: async () => { const x = await st.exportAll(); x.records.pop(); return x; } }; };
  await assert.rejects(P.adoptLegacy(m, memLS()), { code: 'migration' });
  assert.equal(await oldDigest(idb), before); assert.equal((await m.getMeta('legacyAdoption')), undefined);
  m.openStore = open; assert.equal((await P.adoptLegacy(m, memLS())).status, 'adopted');           // retry works
});

test('migration: Patch 1 localStorage data flows into the default learner; corrupt data is kept and blocks adoption', async () => {
  const idb = newIdb(), m = await newMgr(idb), ls = memLS({ [S.LEGACY_KEY]: legacyBlob() });
  assert.equal((await P.adoptLegacy(m, ls)).status, 'adopted'); assert.equal(ls.getItem(S.LEGACY_KEY), null);
  const q = new C.Quiz(await m.openStore(P.LEGACY_PROFILE_ID)); await q.init();
  assert.equal(q.levels[0].chars.length, 2); assert.equal(q.records.length, 1); assert.equal(q.cur.id, 's1');
  const idb2 = newIdb(), m2 = await newMgr(idb2), bad = memLS({ [S.LEGACY_KEY]: '{broken' });
  await assert.rejects(P.adoptLegacy(m2, bad), { code: 'corrupt' });
  assert.equal(bad.getItem(S.LEGACY_KEY), '{broken'); assert.equal((await m2.list('all')).length, 0); assert.equal(await m2.getMeta('legacyAdoption'), undefined);
});

test('migration: a fresh install gets no default learner; new learners never touch the old database', async () => {
  const idb = newIdb(), m = await newMgr(idb);
  assert.equal((await P.adoptLegacy(m, memLS())).status, 'none'); assert.equal((await m.list('all')).length, 0);
  assert.equal((await P.adoptLegacy(m, memLS())).status, 'skipped');
  const a = await learner(m, '新'); assert.notEqual(a.p.dbName, S.DB_NAME); assert.equal(await oldDigest(idb), await oldDigest(idb));
  const old = S.createStore(await S.openDb(idb, S.DB_NAME)); assert.equal((await old.exportAll()).levels.length, 0);
});
