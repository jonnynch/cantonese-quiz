const test = require('node:test'), assert = require('node:assert/strict');
const { S, IMG, newIdb, newStore, memLS, legacyBlob, quota, CH, level } = require('./helpers');

test('IndexedDB: database is created and basic read/write works', async () => {
  const st = await newStore();
  assert.deepEqual([...st.db.objectStoreNames].sort(), ['corrections', 'images', 'levels', 'meta', 'records', 'sessions']);
  await st.saveLevels([level('L1', 'A', [CH('c1', '日')]), level('L2', 'B', [])]);
  await st.saveSession({ id: 's', items: [] }, { id: 'i1', sid: 's', data: IMG });
  const d = await st.loadAll();
  assert.equal(d.levels.length, 2); assert.equal(d.session.id, 's');
  assert.equal((await st.getImage('i1')).data, IMG);
  await st.saveLevels([level('L2', 'B2', [])]);                      // L1 removed, L2 updated
  assert.deepEqual((await st.loadAll()).levels.map(l => l.name), ['B2']);
  await st.completeSession({ id: 's', levelId: 'L2', items: [] });  // record written + session removed together
  const e = await st.loadAll(); assert.equal(e.session, null); assert.equal(e.records.length, 1);
});

test('IndexedDB: unavailable storage gives a clear error', async () => {
  await assert.rejects(S.openDb(undefined), { code: 'unavailable' });
});

test('IndexedDB: a failing transaction rolls back and keeps existing data', async () => {
  const st = await newStore();
  await st.saveLevels([level('L1', 'A', [])]);
  await assert.rejects(st.replaceAll({ levels: [level('X', 'X', [])], records: [{ nokey: 1 }], images: [] }));
  assert.deepEqual((await st.loadAll()).levels.map(l => l.id), ['L1']);
});

test('migration: legacy localStorage data moves to IndexedDB, then legacy key is removed', async () => {
  const st = await newStore(), ls = memLS({ [S.LEGACY_KEY]: legacyBlob() });
  const r = await S.migrateLegacy(st, ls);
  assert.equal(r.status, 'migrated'); assert.equal(r.images, 3);
  assert.equal(ls.getItem(S.LEGACY_KEY), null);
  const d = await st.loadAll();
  assert.equal(d.levels[0].chars.length, 2); assert.equal(d.records.length, 1);
  assert.equal(d.records[0].items[0].img, undefined);                         // no Base64 left in the record
  assert.equal((await st.getImage(d.records[0].items[0].imgId)).data, IMG);
  assert.equal(d.session.id, 's1'); assert.equal(d.session.i, 1);
  assert.equal((await st.getImage(d.session.items[0].imgId)).data, IMG + 'C');
  assert.equal((await S.migrateLegacy(st, ls)).status, 'none');                // safe to run again
  assert.equal((await st.loadAll()).records.length, 1);
});

test('migration: interrupted write leaves legacy data intact and a retry succeeds without duplicates', async () => {
  const st = await newStore(), ls = memLS({ [S.LEGACY_KEY]: legacyBlob() });
  const broken = { ...st, db: { transaction() { throw quota(); } } };
  await assert.rejects(S.migrateLegacy(broken, ls), { code: 'migration' });
  assert.ok(ls.getItem(S.LEGACY_KEY), 'legacy data must not be deleted');
  assert.equal((await st.loadAll()).levels.length, 0);
  assert.equal((await S.migrateLegacy(st, ls)).status, 'migrated');
  const d = await st.loadAll(); assert.equal(d.levels.length, 1); assert.equal(d.records.length, 1);
  assert.equal((await st.exportAll()).images.length, 3);
});

test('migration: legacy key that cannot be removed is retried later without re-copying over newer edits', async () => {
  const st = await newStore(), ls = memLS({ [S.LEGACY_KEY]: legacyBlob() });
  const stuck = { ...ls, removeItem() { throw new Error('denied'); } };
  assert.equal((await S.migrateLegacy(st, stuck)).status, 'migrated');
  assert.equal((await st.getMeta('migration')).state, 'verified'); assert.ok(ls.getItem(S.LEGACY_KEY));
  const d = await st.loadAll(); d.levels[0].name = '改名了'; await st.saveLevels(d.levels);   // user edit
  assert.equal((await S.migrateLegacy(st, ls)).status, 'migrated');
  const e = await st.loadAll(); assert.equal(e.levels[0].name, '改名了'); assert.equal(e.records.length, 1);
  assert.equal(ls.getItem(S.LEGACY_KEY), null); assert.equal((await st.getMeta('migration')).state, 'done');
});

test('migration: failure while verifying keeps legacy data; retry succeeds and does not duplicate', async () => {
  const st = await newStore(), ls = memLS({ [S.LEGACY_KEY]: legacyBlob() });
  const flaky = { ...st, exportAll: () => Promise.reject(new Error('read failed')) };
  await assert.rejects(S.migrateLegacy(flaky, ls), { code: 'migration' });
  assert.ok(ls.getItem(S.LEGACY_KEY));
  assert.equal((await S.migrateLegacy(st, ls)).status, 'migrated');
  const e = await st.exportAll(); assert.equal(e.levels.length, 1); assert.equal(e.records.length, 1); assert.equal(e.images.length, 3);
});

test('migration: level order of the legacy data is preserved', async () => {
  const st = await newStore(); const d = JSON.parse(legacyBlob());
  d.levels = [level('Z', '最先', []), level('A', '第二', []), level('M', '第三', [])];   // same `created`, ids not in order
  await S.migrateLegacy(st, memLS({ [S.LEGACY_KEY]: JSON.stringify(d) }));
  const q = await require('./helpers').newQuiz(st);
  assert.deepEqual(q.levels.map(l => l.id), ['Z', 'A', 'M']);
});

/* ---- verification compares full content, not counts ---- */
const legacyConv = () => S.convertLegacy(JSON.parse(legacyBlob()));
const clone = x => JSON.parse(JSON.stringify(x));
async function failsWith(setup, part) {
  const st = await newStore(), ls = memLS({ [S.LEGACY_KEY]: legacyBlob() });
  await setup(st, legacyConv());
  const before = await st.exportAll();
  await assert.rejects(S.migrateLegacy(st, ls), e => e.code === 'migration' && e.parts.includes(part) && e.problems.length > 0, 'expected failure for ' + part);
  assert.ok(ls.getItem(S.LEGACY_KEY), 'legacy data must stay');                  // 15
  const after = await st.exportAll();                                              // pre-existing rows are never overwritten
  for (const k of ['levels', 'records', 'images']) before[k].forEach(x => assert.deepEqual(after[k].find(y => y.id === x.id), x, k + ' ' + x.id + ' was changed'));
  assert.notEqual((await st.getMeta('migration') || {}).state, 'verified');
  return { st, ls };
}
test('migration verification: different character content fails', async () => {                                 // 11
  const { st, ls } = await failsWith(async (st, c) => { const l = clone(c.levels[0]); l.chars[1].jp = 'WRONG'; await st.saveLevels([l]); }, '級別');
  await st.replaceAll({ levels: [], records: [], images: [] });                       // clean the conflict, then retry
  assert.equal((await S.migrateLegacy(st, ls)).status, 'migrated');
});
test('migration verification: different character order / extra field fails', async () => {
  await failsWith(async (st, c) => { const l = clone(c.levels[0]); l.chars.reverse(); await st.saveLevels([l]); }, '級別');
  await failsWith(async (st, c) => { const l = clone(c.levels[0]); l.name = '另一個名'; await st.saveLevels([l]); }, '級別');
});
test('migration verification: different record item content fails', async () => {                              // 12
  await failsWith(async (st, c) => { const r = clone(c.records[0]); r.items[1].ok = true; await st.completeSession(r); }, '紀錄');
  await failsWith(async (st, c) => { const r = clone(c.records[0]); r.items.reverse(); await st.completeSession(r); }, '紀錄');
  await failsWith(async (st, c) => { const r = clone(c.records[0]); r.date = 6; await st.completeSession(r); }, '紀錄');
});
test('migration verification: different handwriting image content fails', async () => {                         // 13
  await failsWith(async (st, c) => { await st.replaceAll({ levels: [], records: [], images: [{ ...c.images[0], data: c.images[0].data + 'X' }] }); }, '手寫圖片');
});
test('migration verification: different unfinished session state fails', async () => {                         // 14
  await failsWith(async (st, c) => { await st.saveSession({ ...clone(c.session), i: 0 }); }, '未完成的測驗');
  await failsWith(async (st, c) => { const s = clone(c.session); s.items.reverse(); await st.saveSession(s); }, '未完成的測驗');
});
test('migration: repeated migration never duplicates records', async () => {                                    // 17
  const st = await newStore(), ls = memLS({ [S.LEGACY_KEY]: legacyBlob() });
  await S.migrateLegacy(st, ls); ls.setItem(S.LEGACY_KEY, legacyBlob());          // legacy key reappears (e.g. old cached page)
  assert.equal((await S.migrateLegacy(st, ls)).status, 'skipped');
  const e = await st.exportAll(); assert.equal(e.records.length, 1); assert.equal(e.images.length, 3); assert.equal(e.levels.length, 1);
});

test('migration: corrupt legacy data is reported and never deleted', async () => {
  for (const raw of ['{not json', JSON.stringify({ levels: 1, records: [] }), JSON.stringify({ levels: [{ name: 'no id', chars: [] }], records: [] })]) {
    const st = await newStore(), ls = memLS({ [S.LEGACY_KEY]: raw });
    await assert.rejects(S.migrateLegacy(st, ls), { code: 'corrupt' });
    assert.equal(ls.getItem(S.LEGACY_KEY), raw);
    assert.equal((await st.loadAll()).levels.length, 0);
  }
});

test('migration: nothing to do when there is no legacy data', async () => {
  assert.equal((await S.migrateLegacy(await newStore(), memLS())).status, 'none');
});
