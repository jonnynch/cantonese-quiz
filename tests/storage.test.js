const test = require('node:test'), assert = require('node:assert/strict');
const { S, IMG, newIdb, newStore, memLS, legacyBlob, quota, CH, level } = require('./helpers');

test('IndexedDB: database is created and basic read/write works', async () => {
  const st = await newStore();
  assert.deepEqual([...st.db.objectStoreNames].sort(), ['images', 'levels', 'meta', 'records', 'sessions']);
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

test('migration: failed verification keeps legacy data; the retry does not overwrite newer IndexedDB edits', async () => {
  const st = await newStore(), ls = memLS({ [S.LEGACY_KEY]: legacyBlob() });
  const flaky = { ...st, exportAll: () => Promise.reject(new Error('read failed')) };
  await assert.rejects(S.migrateLegacy(flaky, ls), { code: 'migration' });
  assert.ok(ls.getItem(S.LEGACY_KEY));
  assert.equal((await st.getMeta('migration')).state, 'copied');
  const d = await st.loadAll(); d.levels[0].name = '改名了'; await st.saveLevels(d.levels);   // user edit after the interruption
  assert.equal((await S.migrateLegacy(st, ls)).status, 'migrated');
  const e = await st.loadAll(); assert.equal(e.levels[0].name, '改名了'); assert.equal(e.records.length, 1);
  assert.equal(ls.getItem(S.LEGACY_KEY), null);
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
