/* Per-profile level mastery: a manual label stored in the learner's own data; never shared, never touching history, scores or statistics. */
const test = require('node:test'), assert = require('node:assert/strict');
const { S, C, IMG, newIdb, newStore, newQuiz, seed, CH, level } = require('./helpers');
const P = require('../public/js/profiles.js'), B = require('../public/js/backup.js');

let n = 0;
const uidFrom = (...ids) => { let i = 0; return () => ids[i++] || 'p-auto' + (++n); };
async function boot(idb, uids) { const mgr = await new P.ProfileManager(idb, uids ? { uid: uidFrom(...uids) } : {}).init(); const CT = new C.SharedContent(mgr.content); await CT.load(); return { mgr, CT }; }
const quiz = async (mgr, CT, id) => { const q = new C.Quiz(await mgr.openStore(id), { content: CT }); await q.init(); return q; };
const chars = (k, from = 0) => Array.from({ length: k }, (_, i) => CH('c' + (from + i + 1), String.fromCodePoint(0x4e00 + from + i)));
const lvl = (id, name, cs) => ({ ...level(id, name, cs), created: 1, modified: 1 });
async function content(CT, k = 22) { await CT.mutate(ls => { ls.push(lvl('L1', '一級', chars(k))); ls.push(lvl('L2', '二級', chars(k, 30))); ls.push(lvl('L3', '三級', chars(3, 60))); }); }
const mastered = q => ['L1', 'L2', 'L3'].map(id => q.masteryOf(id).status);

test('a level can be marked mastered, changed at any time and removed; the automatic status follows this learner\'s history', async () => {
  const st = await newStore(), q = await seed(st, 3);
  assert.deepEqual(q.masteryOf('L1'), { status: 'notStarted', manual: false });
  assert.equal((await q.setMastery('L1', 'mastered')).ok, true); assert.deepEqual(q.masteryOf('L1'), { status: 'mastered', manual: true });
  assert.equal((await q.setMastery('L1', 'learning')).ok, true); assert.deepEqual(q.masteryOf('L1'), { status: 'learning', manual: true });          // mastery removed
  assert.equal((await q.setMastery('L1', 'notStarted')).ok, true); assert.deepEqual(q.masteryOf('L1'), { status: 'notStarted', manual: true });
  assert.equal((await q.setMastery('L1', 'mastered')).ok, true); assert.equal((await q.setMastery('L1', null)).ok, true); assert.deepEqual(q.masteryOf('L1'), { status: 'notStarted', manual: false });   // back to automatic
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); assert.deepEqual(q.masteryOf('L1'), { status: 'learning', manual: false }, 'an unfinished session counts as started');
  assert.equal((await q.setMastery('L1', 'finished')).ok, false); assert.equal((await q.setMastery('', 'mastered')).ok, false); assert.equal((await q.setMastery(7, 'mastered')).ok, false);
  assert.equal(q.masteryOf('L1').manual, false);
});
test('mastery persists after a reload (and the status of a level with history is "learning" without a manual status)', async () => {
  const st = await newStore(); let q = await seed(st, 3);
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); for (let i = 0; i < 3; i++) await q.answerRead(true);
  await q.setMastery('L1', 'mastered'); await q.setMastery('L9', 'learning');
  q = await newQuiz(st); assert.equal(q.masteryOf('L1').status, 'mastered'); assert.equal(q.masteryOf('L9').status, 'learning'); assert.equal(q.masteryOf('L2').status, 'notStarted');
  await q.setMastery('L1', null); q = await newQuiz(st); assert.deepEqual(q.masteryOf('L1'), { status: 'learning', manual: false }, 'history exists, so it shows as learning');
});
test('different profiles have independent mastery of the same shared levels; switching shows the right one; deleting a profile removes only its own', async () => {
  const idb = newIdb(), { mgr, CT } = await boot(idb); await content(CT);
  const a = await mgr.create({ name: 'A', avatar: 'cat' }), b = await mgr.create({ name: 'B', avatar: 'dog' }), c = await mgr.create({ name: 'C', avatar: 'fox' });
  const qa = await quiz(mgr, CT, a.id), qb = await quiz(mgr, CT, b.id);
  await qa.setMastery('L1', 'mastered'); await qa.setMastery('L2', 'mastered'); await qb.setMastery('L1', 'mastered');
  assert.deepEqual(mastered(qa), ['mastered', 'mastered', 'notStarted']); assert.deepEqual(mastered(qb), ['mastered', 'notStarted', 'notStarted']);
  await qb.setMastery('L1', 'learning'); assert.deepEqual(mastered(qa), ['mastered', 'mastered', 'notStarted'], 'changing B never changes A');
  const qa2 = await quiz(mgr, CT, a.id), qb2 = await quiz(mgr, CT, b.id), qc = await quiz(mgr, CT, c.id);      // "switch" = a fresh view of each profile
  assert.deepEqual(mastered(qa2), ['mastered', 'mastered', 'notStarted']); assert.deepEqual(mastered(qb2), ['learning', 'notStarted', 'notStarted']); assert.deepEqual(mastered(qc), ['notStarted', 'notStarted', 'notStarted']);
  assert.equal((await (await mgr.openStore(c.id)).loadAll()).mastery.length, 0); assert.equal((await (await mgr.openStore(a.id)).loadAll()).mastery.length, 2);
  await mgr.remove(b.id, () => true); assert.deepEqual(mastered(await quiz(mgr, CT, a.id)), ['mastered', 'mastered', 'notStarted']);
});
test('marking a level mastered does not alter practice or exam history, statistics, corrections or the level, and creates no result', async () => {
  const st = await newStore(), q = await seed(st, 22);
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice', chars: q.level('L1').chars.slice(0, 4) }); for (const ok of [true, false, true, true]) await q.answerRead(ok);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice', chars: q.level('L1').chars.slice(0, 2) }); await q.answerWrite(IMG + '1'); await q.answerWrite(IMG + '2'); await q.setOk(0, false); await q.setOk(1, true); await q.finishMarking();
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'exam' }); for (let i = 0; i < 20; i++) await q.answerRead(i % 5 !== 0);
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); await q.answerRead(true);               // an unfinished session
  const snap = async () => { const a = await st.exportAll(); const { mastery, ...rest } = a; return JSON.stringify(rest); }, before = await snap(), levels = JSON.stringify(q.levels);
  const recs = q.records.length, stats = JSON.stringify([...q.stats.values()]), corr = q.corrections.length, pri = q.priorityOf('read', 'c1');
  await q.setMastery('L1', 'mastered'); await q.setMastery('L1', 'learning'); await q.setMastery('L1', 'mastered'); await q.setMastery('L1', null);
  assert.equal(await snap(), before, 'records, images, sessions, drafts, corrections and statistics are byte-identical');
  assert.equal(q.records.length, recs); assert.equal(JSON.stringify([...q.stats.values()]), stats); assert.equal(q.corrections.length, corr); assert.equal(q.priorityOf('read', 'c1'), pri); assert.equal(JSON.stringify(q.levels), levels);
  assert.equal(q.sessions.length, 1); assert.equal(q.cur.i, 1);
});
test('mastered levels stay fully playable: every kind of practice, revision and exam can still be started and finished', async () => {
  const st = await newStore(), q = await seed(st, 22); await q.setMastery('L1', 'mastered');
  for (const [kind, mode] of [['read', 'practice'], ['write', 'practice'], ['read', 'exam'], ['write', 'exam']]) {
    const r = await q.startSession({ kind, levelId: 'L1', mode }); assert.equal(r.ok, true, kind + mode); assert.equal(q.cur.levelId, 'L1'); await q.discard(() => true);
  }
  assert.equal((await q.startSession({ kind: 'read', levelId: 'L1', mode: 'revision', parentId: 'p', chars: q.level('L1').chars.slice(0, 2) })).ok, true); await q.answerRead(true); await q.answerRead(true);
  assert.equal(q.records.length, 1); assert.equal(q.masteryOf('L1').status, 'mastered', 'finishing a session does not change a manual status');
  assert.equal((await q.startSession({ kind: 'read', levelId: 'L2', mode: 'practice' })).ok, false, 'only because this level does not exist here');   // other levels are not gated either
});

/* ---- profiles without mastery data ---- */
test('a database from before mastery existed upgrades safely: nothing lost, every level shows its automatic status', async () => {
  const idb = newIdb();
  await new Promise((res, rej) => {
    const rq = idb.open(S.DB_NAME, 4);
    rq.onupgradeneeded = () => { const db = rq.result; db.createObjectStore('levels', { keyPath: 'id' }); db.createObjectStore('records', { keyPath: 'id' }).createIndex('levelId', 'levelId');
      db.createObjectStore('images', { keyPath: 'id' }).createIndex('sid', 'sid'); db.createObjectStore('sessions'); db.createObjectStore('meta'); db.createObjectStore('corrections', { keyPath: 'id' });
      db.createObjectStore('unfinished', { keyPath: 'id' }); db.createObjectStore('drafts', { keyPath: 'sid' }); db.createObjectStore('stats', { keyPath: 'cid' }); };
    rq.onsuccess = () => { const db = rq.result, tx = db.transaction(['levels', 'records', 'stats'], 'readwrite');
      tx.objectStore('levels').put({ ...lvl('L1', '一級', chars(2)), ord: 0 }); tx.objectStore('records').put({ id: 'r1', levelId: 'L1', levelName: '一級', kind: 'read', mode: 'practice', parentId: null, date: 5, items: [{ cid: 'c1', c: '一', ok: true, imgId: null }] });
      tx.objectStore('stats').put({ cid: 'c1', c: '一', read: {}, write: {} }); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
  });
  const st = S.createStore(await S.openDb(idb)); assert.equal(st.db.version, 5); assert.ok([...st.db.objectStoreNames].includes('mastery'));
  const d = await st.loadAll(); assert.deepEqual(d.mastery, []); assert.equal(d.records.length, 1); assert.equal(d.levels.length, 1); assert.equal(d.stats.length, 1);
  const q = new C.Quiz(st); await q.init(); assert.deepEqual(q.masteryOf('L1'), { status: 'learning', manual: false }); assert.deepEqual(q.masteryOf('L2'), { status: 'notStarted', manual: false });
  await q.setMastery('L2', 'mastered'); assert.equal((await new C.Quiz(st).init(), (await st.loadAll()).mastery.length), 1);
});

/* ---- export / import ---- */
test('the single-profile backup carries mastery; replace restores it, merge only adds levels the learner has not set, an older backup leaves it alone', async () => {
  const st = await newStore(), q = await seed(st, 3); await q.setMastery('L1', 'mastered'); await q.setMastery('L2', 'learning');
  const { json } = await q.exportBackup(); assert.equal(json.version, 1); assert.deepEqual(json.data.mastery.map(x => [x.levelId, x.status]), [['L1', 'mastered'], ['L2', 'learning']]);
  const text = JSON.stringify(json);
  const q2 = await newQuiz(await newStore()); await q2.importBackup(JSON.parse(text), 'replace', () => true); assert.deepEqual([q2.masteryOf('L1').status, q2.masteryOf('L2').status], ['mastered', 'learning']);
  const q3 = await newQuiz(await newStore()); await q3.setMastery('L1', 'learning'); await q3.importBackup(JSON.parse(text), 'merge');
  assert.equal(q3.masteryOf('L1').status, 'learning', 'this learner\'s own setting is never overwritten'); assert.equal(q3.masteryOf('L2').status, 'learning'); assert.equal(q3.mastery.get('L2').manual === undefined, true);
  const q3b = await newQuiz(q3.store); assert.equal(q3b.masteryOf('L1').status, 'learning'); assert.equal((await q3.importBackup(JSON.parse(text), 'merge')).aborted, undefined);
  const old = JSON.parse(text); delete old.data.mastery;                                                           // a backup from before mastery existed
  const q4 = await newQuiz(await newStore()); await q4.setMastery('L1', 'mastered'); await q4.importBackup(JSON.parse(JSON.stringify(old)), 'replace', () => true); assert.equal(q4.masteryOf('L1').status, 'mastered', 'kept');
  const q5 = await newQuiz(await newStore()); await q5.importBackup(JSON.parse(JSON.stringify(old)), 'merge'); assert.equal(q5.mastery.size, 0);
});
test('invalid mastery entries in a backup are skipped with a warning, never a crash or a rejected file', async () => {
  const st = await newStore(), q = await seed(st, 3), { json } = await q.exportBackup(); json.data.mastery = [{ levelId: 'L1', status: 'mastered' }, { levelId: 'L1', status: 'learning' }, { levelId: 'L2', status: 'gold-star' }, { levelId: 5, status: 'mastered' }, null, 'x', { status: 'mastered' }];
  const q2 = await newQuiz(await newStore()), r = await q2.importBackup(json, 'replace', () => true);
  assert.deepEqual([...q2.mastery.keys()], ['L1']); assert.equal(q2.masteryOf('L1').status, 'mastered'); assert.ok(r.warnings.some(w => w.includes('掌握狀態')));
  const j2 = (await q.exportBackup()).json; j2.data.mastery = 'oops'; const q3 = await newQuiz(await newStore()); await q3.importBackup(j2, 'merge'); assert.equal(q3.mastery.size, 0);
  const j3 = (await q.exportBackup()).json; j3.data.mastery = [{ levelId: 'L1', status: 'mastered', at: 'yesterday' }]; const q4 = await newQuiz(await newStore()); await q4.importBackup(j3, 'merge'); assert.equal(q4.mastery.get('L1').at, null);
  await new Promise((res, rej) => { const tx = st.db.transaction(['mastery'], 'readwrite'); tx.objectStore('mastery').put({ levelId: 'LX', status: 'weird' }); tx.oncomplete = res; tx.onerror = rej; });   // a corrupt row already stored
  const q5 = await newQuiz(st); assert.equal(q5.masteryOf('LX').status, 'notStarted'); assert.equal((await q5.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' })).ok, true);
});
test('the multi-profile backup keeps each learner\'s mastery separate and imports it only into the matching learner', async () => {
  const src = await boot(newIdb(), ['pA', 'pB']); await content(src.CT);
  const a = await src.mgr.create({ name: 'A', avatar: 'cat' }), b = await src.mgr.create({ name: 'B', avatar: 'dog' }); const qa = await quiz(src.mgr, src.CT, a.id), qb = await quiz(src.mgr, src.CT, b.id);
  await qa.setMastery('L1', 'mastered'); await qa.setMastery('L2', 'mastered'); await qb.setMastery('L1', 'mastered');
  const file = JSON.parse(JSON.stringify((await B.buildExport(src.mgr, src.CT, { profileIds: [a.id, b.id] })).json));
  assert.deepEqual(file.profiles.map(p => p.data.mastery.length), [2, 1]); assert.equal(file.content.levels.length, 3, 'the shared content is exported once, without any status');
  assert.ok(file.content.levels.every(l => !('status' in l) && !('mastery' in l)));
  const dst = await boot(newIdb(), ['pA', 'pC']); const a2 = await dst.mgr.create({ name: 'A2', avatar: 'cat' }), c = await dst.mgr.create({ name: 'C', avatar: 'bear' });
  const parsed = B.parse(file); assert.equal(parsed.profiles[0].summary.mastery, 2); const targets = B.suggestTargets(parsed, [a2, c]); assert.deepEqual(targets, ['p:pA', 'skip']);
  await B.apply(dst.mgr, dst.CT, parsed, { content: 'merge', targets });
  assert.deepEqual(mastered(await quiz(dst.mgr, dst.CT, a2.id)), ['mastered', 'mastered', 'notStarted']); assert.deepEqual(mastered(await quiz(dst.mgr, dst.CT, c.id)), ['notStarted', 'notStarted', 'notStarted'], 'B\'s mastery is not assigned to C');
  const r = await B.apply(dst.mgr, dst.CT, parsed, { content: 'skip', targets: ['skip', 'p:' + c.id] }); assert.equal(r.profiles[1].status, 'imported');   // explicit choice: B's progress into C
  assert.deepEqual(mastered(await quiz(dst.mgr, dst.CT, c.id)), ['mastered', 'notStarted', 'notStarted']); assert.deepEqual(mastered(await quiz(dst.mgr, dst.CT, a2.id)), ['mastered', 'mastered', 'notStarted']);
  const old = JSON.parse(JSON.stringify(file)); old.profiles.forEach(p => { delete p.data.mastery; });                       // a v2 file from before mastery existed
  const dst2 = await boot(newIdb(), ['pA']); const a3 = await dst2.mgr.create({ name: 'A3', avatar: 'cat' }); await B.apply(dst2.mgr, dst2.CT, B.parse(old), { content: 'merge', targets: ['p:pA', 'skip'] });
  assert.deepEqual(mastered(await quiz(dst2.mgr, dst2.CT, a3.id)), ['notStarted', 'notStarted', 'notStarted']);
});
