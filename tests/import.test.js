const test = require('node:test'), assert = require('node:assert/strict');
const { S, C, IMG, newStore, newQuiz, seed, CH, level } = require('./helpers');

const rec = (id, o) => ({ id, levelId: 'L1', levelName: '一級', kind: 'write', mode: 'practice', parentId: null, date: 10,
  items: [{ cid: 'c1', c: '日', jp: '', w: '', wjp: '', ok: true, img: IMG }], ...o });
const backup = (levels, records) => ({ format: 'cq-backup', version: 1, exported: 'x', data: { levels, records } });
const snapshot = async st => JSON.stringify(await st.exportAll());

async function prepared(n = 2) {
  const st = await newStore(); const q = await seed(st, n);
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); for (let i = 0; i < n; i++) await q.answerRead(i % 2 === 0);
  return { st, q };
}

test('invalid imports (both modes) are rejected with messages and change nothing', async () => {
  const { st, q } = await prepared(); const before = await snapshot(st);
  const L = (o) => ({ ...level('L1', 'A', [CH('c1', '日')]), ...o });
  const cases = [
    null, { format: 'nope' }, { ...backup([], []), version: 9 },
    backup([L(), L()], []),                                                  // duplicate level id
    backup([L({ chars: [CH('c1', '日'), CH('c1', '月')] })], []),             // duplicate char id
    backup([L({ chars: [CH('c1', '日月')] })], []),                           // not a single character
    backup([L({ name: 5 })], []),
    backup([L()], [rec('r1'), rec('r1')]),                                   // duplicate record id
    backup([L()], [rec('r1', { kind: 'x' })]),
    backup([L()], [rec('r1', { items: [{ cid: 'c1', c: '日', ok: 'yes' }] })]),
    backup([L()], [rec('r1', { items: [{ cid: 'c1', c: '日', ok: true, img: 'javascript:alert(1)' }] })]),
  ];
  for (const mode of ['merge', 'replace']) for (const c of cases) {
    await assert.rejects(q.importBackup(c, mode, () => true), e => e instanceof C.ImportError && e.list.length > 0 && /[\u4e00-\u9fff]/.test(e.list[0]));
  }
  assert.equal(await snapshot(st), before);
  assert.equal(q.records.length, 1); assert.equal(q.levels.length, 1);
});

test('a storage failure during import leaves existing data untouched', async () => {
  const { st, q } = await prepared(); const before = await snapshot(st);
  q.store = { ...st, replaceAll: async () => { throw new S.StorageError('write', 'x'); }, applyMerge: async () => { throw new S.StorageError('write', 'x'); } };
  const good = backup([level('L9', '新', [CH('n1', '火')])], []);
  await assert.rejects(q.importBackup(good, 'replace', () => true)); await assert.rejects(q.importBackup(good, 'merge'));
  assert.equal(await snapshot(st), before); assert.equal(q.levels.length, 1);
});

test('replace needs confirmation', async () => {
  const { st, q } = await prepared(); const before = await snapshot(st);
  const r = await q.importBackup(backup([level('L9', '新', [CH('n1', '火')])], []), 'replace', () => false);
  assert.equal(r.cancelled, true); assert.equal(await snapshot(st), before);
});

test('merge detects conflicts, never overwrites, and adds only new data', async () => {
  const { st, q } = await prepared(3);
  const orig = q.records[0], origRec = JSON.stringify(orig);
  const inc = backup([
    level('L1', '改過的名', [CH('c1', '月'), { ...q.levels[0].chars[1] }, CH('cNew', '火')]),           // c1 differs, c2 identical, cNew is new; level name differs
    level('L2', '二級', [CH('c3', '水'), CH('d1', '木')]),                                             // c3 already belongs to L1
  ], [
    { ...rec('rX'), id: orig.id, items: [{ cid: 'c1', c: '日', ok: false }] },                         // same id, different content
    rec('rNew'),                                                                                       // new, with image
  ]);
  const r = await q.importBackup(inc, 'merge');
  assert.equal(r.conflicts.length, 4, r.conflicts.join('\n'));
  assert.ok(r.conflicts.some(x => x.includes('級別 (L1)')) && r.conflicts.some(x => x.includes('字 (c1)')) && r.conflicts.some(x => x.includes('另一個級別')) && r.conflicts.some(x => x.includes('紀錄')));
  assert.equal(r.identical, 1);
  assert.deepEqual(r.added, { levels: 1, chars: 2, records: 1 });
  const L1 = q.levels.find(l => l.id === 'L1'); assert.equal(L1.name, '一級');
  assert.equal(L1.chars.find(c => c.id === 'c1').c, '字');                                           // existing character kept
  assert.ok(L1.chars.some(c => c.id === 'cNew'));
  assert.deepEqual(q.levels.find(l => l.id === 'L2').chars.map(c => c.id), ['d1']);
  assert.equal(JSON.stringify(q.records.find(x => x.id === orig.id)), origRec);                     // progress preserved
  const nr = q.records.find(x => x.id === 'rNew'); assert.equal((await st.getImage(nr.items[0].imgId)).data, IMG);
  assert.equal((await newQuiz(st)).records.length, 2);                                               // persisted
  const again = await q.importBackup(inc, 'merge');                                                   // importing twice never duplicates
  assert.equal(again.added.records, 0); assert.equal(q.records.length, 2);
});

test('merge warns about records whose level or parent is missing but still keeps them', async () => {
  const { q } = await prepared();
  const r = await q.importBackup(backup([], [rec('rZ', { levelId: 'GONE', parentId: 'NOPE' })]), 'merge');
  assert.equal(r.added.records, 1); assert.equal(r.warnings.length, 2);
});

test('export then replace-import round-trips levels, records and handwriting', async () => {
  const st = await newStore(); const q = await seed(st, 2);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' }); await q.answerWrite(IMG + 'A'); await q.answerWrite(IMG + 'B');
  await q.setOk(0, true); await q.setOk(1, false); await q.finishMarking();
  const { json, missingImages } = await q.exportBackup(); assert.equal(missingImages, 0);
  assert.ok(json.data.records[0].items.every(x => /^data:image/.test(x.img) && !('imgId' in x)));
  const st2 = await newStore(), q2 = await newQuiz(st2);
  await q2.importBackup(JSON.parse(JSON.stringify(json)), 'replace', () => true);
  assert.equal(q2.levels.length, 1); assert.equal(q2.records.length, 1);
  assert.equal((await st2.getImage(q2.records[0].items[1].imgId)).data, IMG + 'B');
});
