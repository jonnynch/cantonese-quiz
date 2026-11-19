/* Shared content (global) vs per-learner progress: storage, migration, backup v2 / legacy import, profile matching. */
const test = require('node:test'), assert = require('node:assert/strict');
const { newIdb, CH, level, IMG } = require('./helpers');
const P = require('../public/js/profiles.js'), C = require('../public/js/core.js'), B = require('../public/js/backup.js');

let n = 0;
const uidFrom = (...ids) => { let i = 0; return () => ids[i++] || 'p-auto' + (++n); };
async function boot(idb, uids) { const mgr = await new P.ProfileManager(idb, uids ? { uid: uidFrom(...uids) } : {}).init(); const CT = new C.SharedContent(mgr.content); await CT.load(); return { mgr, CT }; }
const quiz = async (mgr, CT, id) => { const q = new C.Quiz(await mgr.openStore(id), { content: CT }); await q.init(); return q; };
const chars = (n, from = 0) => Array.from({ length: n }, (_, i) => CH('c' + (from + i + 1), String.fromCodePoint(0x4e00 + from + i)));
const lvl = (id, name, cs, modified = 1) => ({ ...level(id, name, cs), created: 1, modified });
async function playRead(q, mode, plan) { await q.startSession({ kind: 'read', levelId: q.levels[0].id, mode }); const k = q.cur.items.length; for (let i = 0; i < k; i++) await q.answerRead(plan(i)); }
const levelsOf = async st => (await st.loadAll()).levels;
const statsJson = q => JSON.stringify([...q.stats.values()].sort((a, b) => (a.cid < b.cid ? -1 : 1)));

/* ---- 1-5: shared content ---- */
test('shared content exists independently of profiles and survives a restart', async () => {
  const idb = newIdb(); let { mgr, CT } = await boot(idb);
  assert.deepEqual(await mgr.list('all'), []);
  assert.equal((await CT.mutate(ls => ls.push(lvl('L1', '一級', chars(3))))).ok, true);
  mgr.db.close(); ({ mgr, CT } = await boot(idb));
  assert.deepEqual(CT.levels.map(l => l.name), ['一級']); assert.equal(CT.levels[0].chars.length, 3); assert.deepEqual(await mgr.list('all'), []);
});
test('content is available to every existing profile and to profiles created later, without being copied into them', async () => {
  const idb = newIdb(), { mgr, CT } = await boot(idb);
  const a = await mgr.create({ name: 'A', avatar: 'cat' }), b = await mgr.create({ name: 'B', avatar: 'dog' });
  await CT.mutate(ls => ls.push(lvl('L1', '一級', chars(2))));
  const qa = await quiz(mgr, CT, a.id), qb = await quiz(mgr, CT, b.id);
  assert.deepEqual(qa.levels.map(l => l.id), ['L1']); assert.deepEqual(qb.levels.map(l => l.id), ['L1']);
  await qa.mutateLevels(ls => ls[0].chars.push(CH('cx', '火')));                              // an edit through one learner...
  assert.equal(qb.levels[0].chars.length, 3);                                                   // ...is the same content for every learner
  const c = await mgr.create({ name: 'C', avatar: 'fox' }), qc = await quiz(mgr, CT, c.id);    // a future learner
  assert.equal(qc.levels[0].chars.length, 3);
  for (const p of [a, b, c]) assert.equal((await levelsOf(await mgr.openStore(p.id))).length, 0, 'no copy of the content inside a profile');
  assert.equal((await mgr.content.loadLevels()).length, 1);
});
test('deleting a learner never deletes the shared content', async () => {
  const idb = newIdb(), { mgr, CT } = await boot(idb); const a = await mgr.create({ name: 'A', avatar: 'cat' });
  await CT.mutate(ls => ls.push(lvl('L1', '一級', chars(2)))); await mgr.remove(a.id, () => true);
  assert.equal((await mgr.content.loadLevels()).length, 1);
});

/* ---- 6: isolation of progress (incl. adaptive statistics) ---- */
test('learning progress and adaptive statistics are isolated per profile while the characters are shared', async () => {
  const idb = newIdb(), { mgr, CT } = await boot(idb); await CT.mutate(ls => ls.push(lvl('L1', '一級', chars(3))));
  const a = await mgr.create({ name: 'A', avatar: 'cat' }), b = await mgr.create({ name: 'B', avatar: 'dog' });
  const qa = await quiz(mgr, CT, a.id), qb = await quiz(mgr, CT, b.id);
  await playRead(qa, 'practice', i => i !== 0);
  assert.equal(qa.records.length, 1); assert.equal(qb.records.length, 0); assert.ok(qa.stats.size > 0); assert.equal(qb.stats.size, 0);
  assert.equal(qb.priorityOf('read', 'c1'), C.ADAPT.BASE);
  const qa2 = await quiz(mgr, CT, a.id), qb2 = await quiz(mgr, CT, b.id); assert.equal(qa2.records.length, 1); assert.equal(qb2.records.length, 0);
});

/* ---- 10-12 + 17: migration ---- */
async function legacyInstall(idb) {                        // two learners, each with its own copy of the content (the old design)
  const m = await new P.ProfileManager(idb, { uid: uidFrom('pA', 'pB') }).init(), out = {};
  for (const [name, mod, extra] of [['A', 5, []], ['B', 9, [CH('cB', '山')]]]) {
    const p = await m.create({ name, avatar: 'cat' }), q = new C.Quiz(await m.openStore(p.id)); await q.init();
    await q.mutateLevels(ls => { ls.push(lvl('L1', '一級', chars(3).concat(extra), mod)); ls.push(lvl('L2-' + name, '只在' + name, chars(2, 10))); });
    await playRead(q, 'practice', i => (name === 'A' ? i !== 1 : true)); out[name] = { p, records: q.records.length, stats: statsJson(q) };
  }
  m.closeAll(); m.db.close(); return out;
}
test('migration moves per-profile content into the shared content once, keeps every level and character, and keeps all progress', async () => {
  const idb = newIdb(), L = await legacyInstall(idb), { mgr, CT } = await boot(idb);
  const r = await P.migrateSharedContent(mgr); assert.equal(r.status, 'migrated'); await CT.load();
  assert.deepEqual(CT.levels.map(l => l.id), ['L1', 'L2-A', 'L2-B']);                         // L1 appears ONCE although both learners had it
  const l1 = CT.levels[0]; assert.equal(l1.name, '一級'); assert.deepEqual(l1.chars.map(c => c.id), ['c1', 'c2', 'c3', 'cB']);   // newest version (B's) wins; no character lost
  for (const k of ['A', 'B']) {
    const st = await mgr.openStore(L[k].p.id); assert.equal((await levelsOf(st)).length, 0, 'old copy removed after the shared content was verified');
    const q = await quiz(mgr, CT, L[k].p.id); assert.equal(q.records.length, L[k].records); assert.equal(statsJson(q), L[k].stats);
  }
  const qa = await quiz(mgr, CT, L.A.p.id), qb = await quiz(mgr, CT, L.B.p.id);                 // statistics stay profile-specific
  const wrong = [...qa.stats.values()].find(r => r.read.practice.incorrect).cid;               // (the order of questions is random: look up the character A got wrong)
  assert.ok(qa.priorityOf('read', wrong) > qb.priorityOf('read', wrong));
});
test('migration is idempotent, also when repeated, interrupted or run on top of partly migrated data', async () => {
  const idb = newIdb(); await legacyInstall(idb); let { mgr, CT } = await boot(idb);
  await P.migrateSharedContent(mgr); await CT.load(); const first = JSON.stringify(CT.levels);
  assert.equal((await P.migrateSharedContent(mgr)).status, 'skipped'); await CT.load(); assert.equal(JSON.stringify(CT.levels), first);
  mgr.db.close(); ({ mgr, CT } = await boot(idb)); assert.equal((await P.migrateSharedContent(mgr)).status, 'skipped'); await CT.load(); assert.equal(JSON.stringify(CT.levels), first);
  // partly migrated: shared content already written, profile copies and the completion mark still there
  const idb2 = newIdb(); await legacyInstall(idb2); ({ mgr, CT } = await boot(idb2));
  await mgr.content.saveLevels([lvl('L1', '一級', chars(3), 5)]); await P.migrateSharedContent(mgr); await CT.load();
  assert.deepEqual(CT.levels.map(l => l.id), ['L1', 'L2-A', 'L2-B']); assert.equal(CT.levels.filter(l => l.id === 'L1').length, 1);
  assert.equal((await P.migrateSharedContent(mgr)).status, 'skipped');
});
test('migration never removes the old copies unless the shared content was verified; a failure is retried safely', async () => {
  const idb = newIdb(), L = await legacyInstall(idb), { mgr } = await boot(idb), real = mgr.content.loadLevels;
  const c = mgr.content; c.loadLevels = async () => [];                                          // read-back verification fails
  await assert.rejects(() => P.migrateSharedContent(mgr), e => e.code === 'migration' || /verified/.test(e.message));
  c.loadLevels = real;
  for (const k of ['A', 'B']) assert.ok((await levelsOf(await mgr.openStore(L[k].p.id))).length > 0, 'originals intact');
  assert.equal(await mgr.getMeta('sharedContent'), undefined);
  assert.equal((await P.migrateSharedContent(mgr)).status, 'migrated');                          // the retry completes
  assert.equal((await mgr.content.loadLevels()).length, 3);
});
test('migration works with no profiles, one profile and an empty profile', async () => {
  let { mgr } = await boot(newIdb()); assert.equal((await P.migrateSharedContent(mgr)).status, 'none'); assert.equal((await mgr.getMeta('sharedContent')).state, 'done');
  const idb = newIdb(); ({ mgr } = await boot(idb, ['p1', 'p2'])); const p = await mgr.create({ name: 'A', avatar: 'cat' }); await mgr.create({ name: 'E', avatar: 'dog' });
  const q = new C.Quiz(await mgr.openStore(p.id)); await q.init(); await q.mutateLevels(ls => ls.push(lvl('L1', '一級', chars(2))));
  assert.equal((await P.migrateSharedContent(mgr)).levels, 1); assert.equal((await mgr.content.loadLevels())[0].chars.length, 2);
});

/* ---- export ---- */
async function twoLearners(idb) {
  const { mgr, CT } = await boot(idb, ['pA', 'pB']); await CT.mutate(ls => ls.push(lvl('L1', '獨一無二級別', chars(3))));
  const a = await mgr.create({ name: '甲', avatar: 'cat' }), b = await mgr.create({ name: '乙', avatar: 'dog' });
  const qa = await quiz(mgr, CT, a.id), qb = await quiz(mgr, CT, b.id);
  await playRead(qa, 'practice', i => i !== 0); await playRead(qb, 'practice', () => true);
  return { mgr, CT, a, b, qa, qb };
}
test('export works with no profiles and contains the content', async () => {
  const { mgr, CT } = await boot(newIdb()); await CT.mutate(ls => ls.push(lvl('L1', '一級', chars(2))));
  const { json } = await B.buildExport(mgr, CT, {}); assert.equal(json.schemaVersion, 2); assert.equal(json.format, 'cq-backup'); assert.deepEqual(json.profiles, []);
  assert.equal(json.content.levels.length, 1); assert.ok(json.exportedAt); assert.equal(B.parse(JSON.parse(JSON.stringify(json))).content.length, 1);
});
test('export with several profiles contains the shared content once and each learner\'s progress separately', async () => {
  const { mgr, CT, a, b } = await twoLearners(newIdb()), { json } = await B.buildExport(mgr, CT, { profileIds: [a.id, b.id] });
  assert.equal(JSON.stringify(json).split('"chars":').length - 1, 1, 'the characters/words are exported exactly once, not per learner');
  assert.equal(json.content.levels.length, 1); assert.equal(json.profiles.length, 2);
  assert.deepEqual(json.profiles.map(p => [p.profileId, p.profileName]), [['pA', '甲'], ['pB', '乙']]);
  json.profiles.forEach(p => { assert.equal(p.data.levels, undefined); assert.equal(p.data.records.length, 1); assert.ok(p.data.stats.length > 0); });
  const only = (await B.buildExport(mgr, CT, { includeContent: false, profileIds: [a.id] })).json; assert.equal(only.content, undefined); assert.equal(only.profiles.length, 1);
});

/* ---- import ---- */
test('import works when no profiles exist: content becomes available at once and to profiles created later; progress is not assigned', async () => {
  const src = await twoLearners(newIdb()), file = JSON.parse(JSON.stringify((await B.buildExport(src.mgr, src.CT, { profileIds: [src.a.id, src.b.id] })).json));
  const { mgr, CT } = await boot(newIdb()), parsed = B.parse(file);
  assert.deepEqual(await mgr.list('all'), []); assert.deepEqual(B.suggestTargets(parsed, []), ['skip', 'skip']);
  const r = await B.apply(mgr, CT, parsed, { content: 'merge', targets: B.suggestTargets(parsed, []) });
  assert.equal(r.content.status, 'merged'); assert.equal(r.content.added.levels, 1); assert.equal(r.content.added.chars, 3); assert.ok(r.profiles.every(p => p.status === 'skipped'));
  assert.equal(CT.levels.length, 1); assert.deepEqual(await mgr.list('all'), []);
  const p = await mgr.create({ name: '新', avatar: 'fox' }), q = await quiz(mgr, CT, p.id);
  assert.equal(q.levels.length, 1); assert.equal(q.records.length, 0); assert.equal(q.stats.size, 0);       // none of A's or B's progress
});
test('progress is imported only into the matching profile; other profiles are untouched and unmatched progress is never assigned', async () => {
  const src = await twoLearners(newIdb()), file = JSON.parse(JSON.stringify((await B.buildExport(src.mgr, src.CT, { profileIds: [src.a.id, src.b.id] })).json));
  const { mgr, CT } = await boot(newIdb(), ['pA', 'pC']); const a = await mgr.create({ name: 'A2', avatar: 'cat' }), c = await mgr.create({ name: 'C', avatar: 'bear' });
  const parsed = B.parse(file), targets = B.suggestTargets(parsed, [a, c]); assert.deepEqual(targets, ['p:pA', 'skip']);         // pB has no local match
  const before = JSON.stringify((await (await quiz(mgr, CT, c.id)).exportBackup()).json.data);
  const r = await B.apply(mgr, CT, parsed, { content: 'merge', targets });
  assert.deepEqual(r.profiles.map(p => p.status), ['imported', 'skipped']);
  const qa = await quiz(mgr, CT, a.id), qc = await quiz(mgr, CT, c.id);
  assert.equal(qa.records.length, 1); assert.deepEqual(qa.stats.get('c1'), src.qa.stats.get('c1')); assert.equal(CT.levels.length, 1);
  assert.equal(JSON.stringify((await qc.exportBackup()).json.data), before); assert.equal(qc.records.length, 0); assert.equal(qc.stats.size, 0);
  const wrong = [...src.qa.stats.values()].find(r => r.read.practice.incorrect).cid;           // A's mistake is in A's statistics, and B (all correct) has none: B's progress was not mixed in
  assert.equal(qa.stats.get(wrong).read.practice.incorrect, 1); assert.equal(src.qb.stats.get(wrong).read.practice.incorrect, 0);
});
test('an explicit mapping may target any profile or create a new one, but two backup learners can never share a target', async () => {
  const src = await twoLearners(newIdb()), parsed = B.parse(JSON.parse(JSON.stringify((await B.buildExport(src.mgr, src.CT, { profileIds: [src.a.id, src.b.id] })).json)));
  const { mgr, CT } = await boot(newIdb()), x = await mgr.create({ name: 'X', avatar: 'cat' });
  await assert.rejects(() => B.apply(mgr, CT, parsed, { content: 'merge', targets: ['p:' + x.id, 'p:' + x.id] }), e => e.name === 'ImportError');
  assert.equal(CT.levels.length, 0, 'invalid choices change nothing');
  await assert.rejects(() => B.apply(mgr, CT, parsed, { content: 'skip', targets: ['p:nope', 'skip'] }), e => e.name === 'ImportError');
  const r = await B.apply(mgr, CT, parsed, { content: 'skip', targets: ['p:' + x.id, 'new'] });
  assert.deepEqual(r.profiles.map(p => p.status), ['imported', 'imported']); assert.equal(r.profiles[1].created, true);
  const all = await mgr.list('all'); assert.equal(all.length, 2); const created = all.find(p => p.id !== x.id); assert.equal(created.name, '乙');
  assert.equal((await quiz(mgr, CT, x.id)).records.length, 1); assert.equal((await quiz(mgr, CT, created.id)).records.length, 1);
  assert.equal(CT.levels.length, 0, 'content was not imported (skipped)');
});
test('content can be imported without progress, and progress without content', async () => {
  const src = await twoLearners(newIdb()), file = JSON.parse(JSON.stringify((await B.buildExport(src.mgr, src.CT, { profileIds: [src.a.id] })).json));
  const { mgr, CT } = await boot(newIdb(), ['pA']); const a = await mgr.create({ name: 'A', avatar: 'cat' });
  let r = await B.apply(mgr, CT, B.parse(file), { content: 'merge', targets: ['skip'] });
  assert.equal(CT.levels.length, 1); assert.equal((await quiz(mgr, CT, a.id)).records.length, 0);
  const fresh = await boot(newIdb(), ['pA']); const a2 = await fresh.mgr.create({ name: 'A', avatar: 'cat' });
  const noContent = JSON.parse(JSON.stringify((await B.buildExport(src.mgr, src.CT, { includeContent: false, profileIds: [src.a.id] })).json));
  r = await B.apply(fresh.mgr, fresh.CT, B.parse(noContent), { content: 'merge', targets: ['p:pA'] });
  assert.equal(r.content.status, 'skipped'); assert.equal(fresh.CT.levels.length, 0); assert.equal((await quiz(fresh.mgr, fresh.CT, a2.id)).records.length, 1);
});
test('content merge keeps existing content, reports conflicts without changing anything, and replace is explicit', async () => {
  const { mgr, CT } = await boot(newIdb()); await CT.mutate(ls => ls.push(lvl('L1', '本機', chars(2), 5)));
  const incoming = { format: 'cq-backup', schemaVersion: 2, content: { levels: [lvl('L1', '備份', chars(3), 9), lvl('L9', '新級別', chars(1, 20))] }, profiles: [] };
  const r = await B.apply(mgr, CT, B.parse(incoming), { content: 'merge', targets: [] });
  assert.equal(r.aborted, true); assert.equal(r.content.status, 'aborted'); assert.ok(r.content.conflicts.length); assert.deepEqual(CT.levels.map(l => l.name), ['本機']);
  const same = { ...incoming, content: { levels: [lvl('L1', '本機', chars(2), 5), lvl('L9', '新級別', chars(1, 20))] } };
  const ok = await B.apply(mgr, CT, B.parse(same), { content: 'merge', targets: [] }); assert.equal(ok.content.added.levels, 1); assert.deepEqual(CT.levels.map(l => l.id), ['L1', 'L9']);
  const rep = await B.apply(mgr, CT, B.parse(incoming), { content: 'replace', targets: [] }); assert.equal(rep.content.status, 'replaced'); assert.deepEqual(CT.levels.map(l => l.name), ['備份', '新級別']);
});
test('importing shared content never overwrites a learner\'s statistics or records', async () => {
  const src = await twoLearners(newIdb()), { mgr, CT } = await boot(newIdb(), ['pA']); const a = await mgr.create({ name: 'A', avatar: 'cat' });
  await CT.mutate(ls => ls.push(lvl('L1', '獨一無二級別', chars(3)))); const qa = await quiz(mgr, CT, a.id); await playRead(qa, 'exam', () => false).catch(() => playRead(qa, 'practice', () => false));
  const before = statsJson(qa), rec = qa.records.length;
  const file = JSON.parse(JSON.stringify((await B.buildExport(src.mgr, src.CT, { profileIds: [] })).json));
  await B.apply(mgr, CT, B.parse(file), { content: 'merge', targets: [] });
  const q2 = await quiz(mgr, CT, a.id); assert.equal(statsJson(q2), before); assert.equal(q2.records.length, rec);
});

/* ---- legacy files ---- */
async function legacyFile() {                            // exactly what the previous version exported: one learner, levels and progress together
  const m = await new P.ProfileManager(newIdb()).init(), p = await m.create({ name: 'L', avatar: 'cat' }), q = new C.Quiz(await m.openStore(p.id)); await q.init();
  await q.mutateLevels(ls => ls.push(lvl('L1', '舊級別', chars(3)))); await playRead(q, 'practice', i => i !== 2);
  return JSON.parse(JSON.stringify((await q.exportBackup()).json));
}
test('legacy backup files import: content is extracted, the progress is offered but never assigned automatically', async () => {
  const file = await legacyFile(); assert.equal(file.version, 1); const parsed = B.parse(file);
  assert.equal(parsed.schema, 1); assert.equal(parsed.content.length, 1); assert.equal(parsed.profiles.length, 1); assert.equal(parsed.profiles[0].legacy, true); assert.equal(parsed.profiles[0].summary.records, 1);
  const { mgr, CT } = await boot(newIdb()), a = await mgr.create({ name: 'A', avatar: 'cat' }), b = await mgr.create({ name: 'B', avatar: 'dog' });
  assert.deepEqual(B.suggestTargets(parsed, [a, b]), ['skip']);
  await B.apply(mgr, CT, parsed, { content: 'merge', targets: ['skip'] });
  assert.equal(CT.levels.length, 1); assert.equal((await quiz(mgr, CT, a.id)).records.length + (await quiz(mgr, CT, b.id)).records.length, 0);
  const r = await B.apply(mgr, CT, parsed, { content: 'merge', targets: ['p:' + b.id] });                      // the user explicitly chooses B
  assert.equal(r.profiles[0].status, 'imported'); assert.equal((await quiz(mgr, CT, b.id)).records.length, 1); assert.equal((await quiz(mgr, CT, a.id)).records.length, 0);
  assert.equal(r.content.identical + r.content.added.levels > 0, true); assert.equal(CT.levels.length, 1, 'no duplicate level');
  const withStats = await quiz(mgr, CT, b.id); assert.ok(withStats.stats.size > 0);
});
test('invalid, damaged or unknown backup files are rejected before anything changes', async () => {
  const { mgr, CT } = await boot(newIdb());
  for (const bad of [null, 5, {}, { format: 'x' }, { format: 'cq-backup', schemaVersion: 3 }, { format: 'cq-backup', schemaVersion: 2, content: { levels: 'no' }, profiles: [] },
    { format: 'cq-backup', schemaVersion: 2, profiles: 'no' }, { format: 'cq-backup', schemaVersion: 2, profiles: [{ profileId: 'a', data: 7 }] },
    { format: 'cq-backup', schemaVersion: 2, profiles: [{ profileId: 'a', data: { records: [] } }, { profileId: 'a', data: { records: [] } }] },
    { format: 'cq-backup', schemaVersion: 2, profiles: [{ profileId: 'a', profileName: 'x', data: { records: [{ id: 1 }] } }] }])
    assert.throws(() => B.parse(bad), e => e.name === 'ImportError');
  assert.equal(CT.levels.length, 0);
  // a content-mode learner refuses a backup that carries levels (content must go through the shared path)
  const p = await mgr.create({ name: 'A', avatar: 'cat' }), q = await quiz(mgr, CT, p.id);
  await assert.rejects(() => q.importBackup({ format: 'cq-backup', version: 1, data: { levels: [lvl('L1', 'x', chars(1))], records: [] } }, 'merge'), e => e.name === 'ImportError');
});
