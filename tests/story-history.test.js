/* Story reading history: per learner, separate from records / statistics / exams / mastery, persisted, and part of the backup. */
const test = require('node:test'), assert = require('node:assert/strict');
const { S, C, newIdb, CH, level } = require('./helpers');
const P = require('../public/js/profiles.js'), B = require('../public/js/backup.js'), ST = require('../public/js/story.js'), T = require('../public/js/topics.js');

let n = 0;
const uidFrom = (...ids) => { let i = 0; return () => ids[i++] || 'p-auto' + (++n); };
async function boot(idb, uids) { const mgr = await new P.ProfileManager(idb, uids ? { uid: uidFrom(...uids) } : {}).init(); const CT = new C.SharedContent(mgr.content); await CT.load(); return { mgr, CT }; }
const quiz = async (mgr, CT, id) => { const q = new C.Quiz(await mgr.openStore(id), { content: CT }); await q.init(); return q; };
const lvl = (id, name, cs) => ({ ...level(id, name, cs), created: 1, modified: 1 });
let seed = 1; const rng = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const known = new Set([...'貓狗鳥魚兔山水花樹']);
function makeStory(id, over = {}) { const st = ST.generate({ known, difficulty: 1, rng }); return { id, ...st, createdAt: 1000 + (over.n || 0), startedAt: null, completedAt: null, readMs: 0, page: 0, audioUsed: false, comprehension: null, ...over }; }
const ok = async p => assert.equal((await p).ok, true);
const snap = async q => JSON.stringify({ r: q.records, s: [...q.stats.values()], m: [...q.mastery.values()], c: q.corrections, x: q.sessions });

test('a story and its reading progress are saved per learner, newest first, and survive a restart', async () => {
  const { mgr, CT } = await boot(newIdb()), p = await mgr.create({ name: 'A', avatar: 'cat' }); let q = await quiz(mgr, CT, p.id);
  assert.deepEqual(q.storyList(), []); const a = makeStory('s1', { n: 0 }), b = makeStory('s2', { n: 5 });
  await ok(q.saveStory(a)); await ok(q.saveStory(b)); assert.deepEqual(q.storyList().map(x => x.id), ['s2', 's1']);
  await ok(q.saveStory({ ...a, startedAt: 2000, page: 1, readMs: 4000, audioUsed: true })); await ok(q.saveStory({ ...q.story('s1'), completedAt: 3000, readMs: 9000, comprehension: { score: 2, total: 3 } }));
  q = await quiz(mgr, CT, p.id); const s1 = q.story('s1');
  assert.deepEqual([s1.startedAt, s1.completedAt, s1.readMs, s1.audioUsed, s1.page], [2000, 3000, 9000, true, 1]); assert.deepEqual(s1.comprehension, { score: 2, total: 3 });
  assert.equal(s1.title.zh, a.title.zh); assert.equal(s1.sentences.length, a.sentences.length); assert.equal(s1.topic, null); assert.equal(s1.difficulty, 1); assert.equal(q.storyList().length, 2);
  assert.deepEqual(q.recentStories(1), [{ template: b.template, hero: b.hero }]);
});
test('invalid stories are rejected before anything is written, and unusable stored rows are ignored', async () => {
  const { mgr, CT } = await boot(newIdb()), p = await mgr.create({ name: 'A', avatar: 'cat' }), q = await quiz(mgr, CT, p.id), good = makeStory('g');
  const bad = [null, {}, { ...good, id: '' }, { ...good, title: { zh: '', en: 'x' } }, { ...good, sentences: [] }, { ...good, sentences: good.sentences.map(s => ({ ...s, zh: s.zh + '多' })) },
    { ...good, sentences: [{ ...good.sentences[0], tokens: [['', null, null, 0]] }] }, { ...good, sentences: Array(25).fill(good.sentences[0]) }, { ...good, sentences: [{ zh: good.sentences[0].zh, en: 'x', tokens: 'no' }] }];
  for (const x of bad) assert.equal((await q.saveStory(x)).ok, false); assert.equal(q.storyList().length, 0);
  const n1 = C.normStory({ ...good, difficulty: 9, readMs: -5, page: 99, familiar: 7, comprehension: { score: 9, total: 3 }, questions: [{ type: 'mc', zh: 'x', options: ['a'], answer: 0 }, ...good.questions], newChars: ['貓', 5, 'toolongvalue'] });
  assert.equal(n1.difficulty, 1); assert.equal(n1.readMs, 0); assert.equal(n1.page, 0); assert.equal(n1.familiar, 1); assert.equal(n1.comprehension, null); assert.equal(n1.questions.length, good.questions.length); assert.deepEqual(n1.newChars, ['貓']);
  await ok(q.saveStory(good));
  await new Promise((res, rej) => { const tx = q.store.db.transaction(['stories'], 'readwrite'); tx.objectStore('stories').put({ id: 'junk', title: 7 }); tx.objectStore('stories').put({ id: 'junk2', title: { zh: 'x', en: 'y' }, sentences: [{ zh: 'a', en: 'b', tokens: [['b', null, null, 0]] }] }); tx.oncomplete = res; tx.onerror = rej; });
  const q2 = await quiz(mgr, CT, p.id); assert.deepEqual(q2.storyList().map(x => x.id), ['g']);
});
test('reading history is separate from learning: it writes no records, statistics, mastery, sessions or exam results, and learning does not touch it', async () => {
  const { mgr, CT } = await boot(newIdb()); await CT.mutate(ls => ls.push(lvl('L1', '一級', Array.from({ length: 22 }, (_, i) => CH('c' + i, String.fromCodePoint(0x4e00 + i))))));
  const p = await mgr.create({ name: 'A', avatar: 'cat' }), q = await quiz(mgr, CT, p.id);
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'exam' }); for (let i = 0; i < 20; i++) await q.answerRead(i % 4 !== 0); await q.setMastery('L1', 'learning');
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); await q.answerRead(true);
  const before = await snap(q), exams = q.records.filter(r => r.mode === 'exam').map(r => r.items.filter(x => x.ok).length);
  for (let i = 0; i < 4; i++) await ok(q.saveStory(makeStory('s' + i, { n: i, startedAt: 5, completedAt: 6, readMs: 1000, audioUsed: true, comprehension: { score: 3, total: 3 } })));
  assert.equal(await snap(q), before, 'records, statistics, mastery, corrections and sessions are untouched by reading'); assert.deepEqual(q.records.filter(r => r.mode === 'exam').map(r => r.items.filter(x => x.ok).length), exams);
  const stories = JSON.stringify(q.storyList()); await q.answerRead(true); await q.setMastery('L1', 'mastered'); assert.equal(JSON.stringify(q.storyList()), stories, 'and learning does not change the reading history');
});
test('reading history is per profile: another learner sees none of it, switching shows the right one, deleting a learner removes only theirs', async () => {
  const { mgr, CT } = await boot(newIdb()), a = await mgr.create({ name: 'A', avatar: 'cat' }), b = await mgr.create({ name: 'B', avatar: 'dog' });
  const qa = await quiz(mgr, CT, a.id), qb = await quiz(mgr, CT, b.id); await ok(qa.saveStory(makeStory('a1', { n: 1, completedAt: 9 }))); await ok(qa.saveStory(makeStory('a2', { n: 2 }))); await ok(qb.saveStory(makeStory('b1', { n: 1 })));
  assert.deepEqual(qa.storyList().map(x => x.id), ['a2', 'a1']); assert.deepEqual(qb.storyList().map(x => x.id), ['b1']);
  const a2 = await quiz(mgr, CT, a.id), b2 = await quiz(mgr, CT, b.id); assert.deepEqual(a2.storyList().map(x => x.id), ['a2', 'a1']); assert.deepEqual(b2.storyList().map(x => x.id), ['b1']);
  assert.equal(b2.story('a1'), undefined); assert.deepEqual((await (await mgr.openStore(b.id)).loadAll()).stories.map(x => x.id), ['b1']);
  await mgr.remove(a.id, () => true); assert.deepEqual((await quiz(mgr, CT, b.id)).storyList().map(x => x.id), ['b1']);
});

/* ---- what the learner knows ---- */
test('known characters come from what this learner learned (any way) and from levels marked mastered; other learners and unlearned characters do not count', async () => {
  const { mgr, CT } = await boot(newIdb()); await CT.mutate(ls => { ls.push(lvl('L1', '一級', [CH('x1', '貓'), CH('x2', '狗'), CH('x3', '魚')])); ls.push(lvl('L2', '二級', [CH('y1', '山'), CH('y2', '水')])); }); await CT.ensureTopics(T);
  const a = await mgr.create({ name: 'A', avatar: 'cat' }), b = await mgr.create({ name: 'B', avatar: 'dog' }), qa = await quiz(mgr, CT, a.id), qb = await quiz(mgr, CT, b.id);
  assert.equal(qa.knownGlyphs().size, 0);
  for (let r = 0; r < 2; r++) { await qa.startSession({ kind: 'read', levelId: 'L1', mode: 'practice', chars: [CT.levels[0].chars[0]] }); await qa.answerRead(true); }       // 貓: two correct in a row
  await qa.startSession({ kind: 'read', levelId: 'L1', mode: 'practice', chars: [CT.levels[0].chars[1]] }); await qa.answerRead(true);                                   // 狗: only once
  assert.deepEqual([...qa.knownGlyphs()], ['貓']); assert.equal(qb.knownGlyphs().size, 0);
  await qa.setMastery('L2', 'mastered'); assert.deepEqual([...qa.knownGlyphs()].sort(), ['山', '水', '貓'].sort()); await qa.setMastery('L2', 'learning'); assert.deepEqual([...qa.knownGlyphs()], ['貓']);
  for (let r = 0; r < 2; r++) { await qa.startSession({ kind: 'write', levelId: 'topic:food', levelName: '主題：食物', mode: 'practice', chars: [CT.level(T.LIB_LEVEL_ID).chars.find(c => c.c === '飯')] }); await qa.answerWrite('data:image/jpeg;base64,AAAA'); await qa.setOk(0, true); await qa.finishMarking(); }
  assert.ok(qa.knownGlyphs().has('飯'), 'learned through a topic counts too');
  const lone = new C.Quiz(await mgr.openStore(b.id)); await lone.init(); assert.equal(lone.knownGlyphs().size, 0, 'no shared content, nothing known, no crash');
});

/* ---- backup ---- */
test('the single-profile backup carries the reading history; replace restores it, merge only adds stories this learner does not have, older backups leave it alone', async () => {
  const { mgr, CT } = await boot(newIdb()), p = await mgr.create({ name: 'A', avatar: 'cat' }), q = await quiz(mgr, CT, p.id);
  await ok(q.saveStory(makeStory('s1', { n: 1, startedAt: 2, completedAt: 3, readMs: 4000, audioUsed: true, comprehension: { score: 2, total: 3 } }))); await ok(q.saveStory(makeStory('s2', { n: 2, page: 0 })));
  const { json } = await q.exportBackup(); assert.equal(json.version, 1); assert.equal(json.data.stories.length, 2); const text = JSON.stringify(json);
  const dst = await boot(newIdb()), p2 = await dst.mgr.create({ name: 'B', avatar: 'dog' }), q2 = await quiz(dst.mgr, dst.CT, p2.id);
  await q2.importBackup(JSON.parse(text), 'replace', () => true); assert.deepEqual(q2.storyList().map(x => x.id), ['s2', 's1']); assert.deepEqual(q2.story('s1').comprehension, { score: 2, total: 3 }); assert.equal(q2.story('s1').readMs, 4000); assert.equal(q2.story('s1').audioUsed, true);
  assert.equal(JSON.stringify((await q2.exportBackup()).json.data.stories), JSON.stringify(json.data.stories), 'a stable round trip');
  const m = await boot(newIdb()), p3 = await m.mgr.create({ name: 'C', avatar: 'fox' }), q3 = await quiz(m.mgr, m.CT, p3.id); await ok(q3.saveStory({ ...makeStory('s1', { n: 1 }), page: 3 }));                // the local s1 has its own progress
  await q3.importBackup(JSON.parse(text), 'merge'); assert.deepEqual(q3.storyList().map(x => x.id), ['s2', 's1']); assert.equal(q3.story('s1').page, 3, 'never overwritten'); assert.equal(q3.story('s1').completedAt, null);
  assert.equal((await q3.importBackup(JSON.parse(text), 'merge')).aborted, undefined);
  const old = JSON.parse(text); delete old.data.stories; const q4 = await quiz(m.mgr, m.CT, p3.id); await q4.importBackup(JSON.parse(JSON.stringify(old)), 'replace', () => true); assert.equal(q4.storyList().length, 2, 'kept: an older backup has no reading history');
  const q5 = await quiz(dst.mgr, dst.CT, (await dst.mgr.create({ name: 'D', avatar: 'bear' })).id); await q5.importBackup(JSON.parse(JSON.stringify(old)), 'merge'); assert.equal(q5.storyList().length, 0);
});
test('invalid stories in a backup are skipped with a warning (never a crash or a rejected file); malformed lists are ignored', async () => {
  const { mgr, CT } = await boot(newIdb()), p = await mgr.create({ name: 'A', avatar: 'cat' }), q = await quiz(mgr, CT, p.id); await ok(q.saveStory(makeStory('s1')));
  const { json } = await q.exportBackup(); const good = json.data.stories[0];
  json.data.stories = [good, { ...good }, null, 'x', { ...good, id: 's9', sentences: [] }, { ...good, id: 's8', sentences: good.sentences.map(s => ({ ...s, zh: 'x' })) }];
  const q2 = await quiz(mgr, CT, (await mgr.create({ name: 'B', avatar: 'dog' })).id), r = await q2.importBackup(json, 'replace', () => true);
  assert.deepEqual(q2.storyList().map(x => x.id), ['s1']); assert.ok(r.warnings.some(w => w.includes('故事')));
  const j2 = (await q.exportBackup()).json; j2.data.stories = 'oops'; const q3 = await quiz(mgr, CT, (await mgr.create({ name: 'C', avatar: 'fox' })).id); await q3.importBackup(j2, 'merge'); assert.equal(q3.storyList().length, 0);
});
test('the multi-profile backup keeps each learner\'s reading history separate and imports it only into the matching learner', async () => {
  const src = await boot(newIdb(), ['pA', 'pB']), a = await src.mgr.create({ name: 'A', avatar: 'cat' }), b = await src.mgr.create({ name: 'B', avatar: 'dog' });
  const qa = await quiz(src.mgr, src.CT, a.id), qb = await quiz(src.mgr, src.CT, b.id); await ok(qa.saveStory(makeStory('a1', { n: 1, completedAt: 5 }))); await ok(qa.saveStory(makeStory('a2', { n: 2 }))); await ok(qb.saveStory(makeStory('b1', { n: 1 })));
  const file = JSON.parse(JSON.stringify((await B.buildExport(src.mgr, src.CT, { profileIds: [a.id, b.id] })).json)); assert.deepEqual(file.profiles.map(p => p.data.stories.length), [2, 1]);
  const dst = await boot(newIdb(), ['pA', 'pC']), a2 = await dst.mgr.create({ name: 'A2', avatar: 'cat' }), c = await dst.mgr.create({ name: 'C', avatar: 'bear' }), parsed = B.parse(file);
  assert.equal(parsed.profiles[0].summary.stories, 2); const targets = B.suggestTargets(parsed, [a2, c]); assert.deepEqual(targets, ['p:pA', 'skip']);
  await B.apply(dst.mgr, dst.CT, parsed, { content: 'merge', targets });
  assert.deepEqual((await quiz(dst.mgr, dst.CT, a2.id)).storyList().map(x => x.id), ['a2', 'a1']); assert.deepEqual((await quiz(dst.mgr, dst.CT, c.id)).storyList().map(x => x.id), [], 'B\'s stories are not given to C');
  const only = JSON.parse(JSON.stringify(file)); only.profiles.forEach(p => { p.data = { stories: p.data.stories }; });                                                     // a file with nothing but reading history
  const d3 = await boot(newIdb(), ['pB']), b3 = await d3.mgr.create({ name: 'B3', avatar: 'dog' }); await B.apply(d3.mgr, d3.CT, B.parse(only), { content: 'skip', targets: ['skip', 'p:pB'] });
  assert.deepEqual((await quiz(d3.mgr, d3.CT, b3.id)).storyList().map(x => x.id), ['b1']);
});
test('a database from before story reading existed upgrades safely: nothing lost, an empty history', async () => {
  const idb = newIdb();
  await new Promise((res, rej) => {
    const rq = idb.open(S.DB_NAME, 5);
    rq.onupgradeneeded = () => { const db = rq.result; db.createObjectStore('levels', { keyPath: 'id' }); db.createObjectStore('records', { keyPath: 'id' }).createIndex('levelId', 'levelId'); db.createObjectStore('images', { keyPath: 'id' }).createIndex('sid', 'sid'); db.createObjectStore('sessions'); db.createObjectStore('meta');
      db.createObjectStore('corrections', { keyPath: 'id' }); db.createObjectStore('unfinished', { keyPath: 'id' }); db.createObjectStore('drafts', { keyPath: 'sid' }); db.createObjectStore('stats', { keyPath: 'cid' }); db.createObjectStore('mastery', { keyPath: 'levelId' }); };
    rq.onsuccess = () => { const db = rq.result, tx = db.transaction(['records', 'mastery'], 'readwrite'); tx.objectStore('records').put({ id: 'r1', levelId: 'L1', levelName: '一級', kind: 'read', mode: 'practice', parentId: null, date: 5, items: [{ cid: 'c1', c: '一', ok: true, imgId: null }] });
      tx.objectStore('mastery').put({ levelId: 'L1', status: 'mastered', at: 1 }); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
  });
  const st = S.createStore(await S.openDb(idb)); assert.equal(st.db.version, 6); assert.ok([...st.db.objectStoreNames].includes('stories'));
  const d = await st.loadAll(); assert.deepEqual(d.stories, []); assert.equal(d.records.length, 1); assert.equal(d.mastery.length, 1);
  const q = new C.Quiz(st); await q.init(); assert.deepEqual(q.storyList(), []); assert.equal(q.masteryOf('L1').status, 'mastered'); await ok(q.saveStory(makeStory('n1'))); assert.equal((await st.loadAll()).stories.length, 1);
});

test('quick progress updates never overwrite each other (each patch is applied to the latest copy)', async () => {
  const { mgr, CT } = await boot(newIdb()), p = await mgr.create({ name: 'A', avatar: 'cat' }), q = await quiz(mgr, CT, p.id); await ok(q.saveStory(makeStory('s1')));
  const rs = await Promise.all([q.updateStory('s1', s => ({ readMs: s.readMs + 4000 })), q.updateStory('s1', { audioUsed: true }), q.updateStory('s1', { page: 1 }), q.updateStory('s1', s => ({ readMs: s.readMs + 1000, completedAt: 77 })), q.updateStory('s1', () => ({ comprehension: { score: 1, total: 2 } }))]);
  assert.ok(rs.every(r => r.ok)); const s = q.story('s1'); assert.deepEqual([s.readMs, s.audioUsed, s.page, s.completedAt, s.comprehension], [5000, true, 1, 77, { score: 1, total: 2 }]);
  const q2 = await quiz(mgr, CT, p.id); assert.deepEqual([q2.story('s1').readMs, q2.story('s1').completedAt], [5000, 77]);
  assert.equal((await q.updateStory('nope', { page: 1 })).ok, false); assert.equal((await q.updateStory('s1', { title: { zh: '', en: '' } })).ok, false); assert.equal(q.story('s1').title.zh.length > 0, true);
});
