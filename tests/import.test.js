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

test('merge detects conflicts and, by default, applies nothing', async () => {
  const { st, q } = await prepared(3);
  const before = await snapshot(st), origId = q.records[0].id, origRec = JSON.stringify(q.records[0]);
  const inc = backup([
    level('L1', '改過的名', [CH('c1', '月'), { ...q.levels[0].chars[1] }, CH('cNew', '火')]),    // level name differs, c1 differs, c2 identical, cNew new
    level('L2', '二級', [CH('c3', '水'), CH('d1', '木')]),                                      // c3 already belongs to L1
  ], [
    { ...rec('rX'), id: origId, items: [{ cid: 'c1', c: '日', ok: false }] },          // same id, different content
    rec('rNew'),
  ]);
  const r = await q.importBackup(inc, 'merge');
  assert.equal(r.aborted, true); assert.equal(r.conflicts.length, 4, r.conflicts.join('\n'));
  assert.ok(r.conflicts.some(x => x.includes('級別 (L1)')) && r.conflicts.some(x => x.includes('字 (c1)')) && r.conflicts.some(x => x.includes('另一個級別')) && r.conflicts.some(x => x.includes('紀錄 (')));
  assert.equal(r.identical, 1); assert.deepEqual(r.added, { levels: 0, chars: 0, records: 0 });
  assert.equal(await snapshot(st), before);                                                   // nothing changed, nothing half-merged
  assert.equal(JSON.stringify(q.records.find(x => x.id === origId)), origRec); assert.equal(q.levels.length, 1);
  // explicit opt-in: apply only the non-conflicting parts; conflicting items are still never overwritten
  const p = await q.importBackup(inc, 'merge', undefined, { allowPartial: true });
  assert.equal(p.aborted, undefined); assert.deepEqual(p.added, { levels: 1, chars: 2, records: 1 });
  const L1 = q.levels.find(l => l.id === 'L1'); assert.equal(L1.name, '一級'); assert.equal(L1.chars.find(c => c.id === 'c1').c, '字');
  assert.ok(L1.chars.some(c => c.id === 'cNew')); assert.deepEqual(q.levels.find(l => l.id === 'L2').chars.map(c => c.id), ['d1']);
  assert.equal(JSON.stringify(q.records.find(x => x.id === origId)), origRec);
  assert.deepEqual(q.levels.map(l => l.id), ['L1', 'L2']);                                    // new level goes after existing ones
  assert.equal((await st.getImage(q.records.find(x => x.id === 'rNew').items[0].imgId)).data, IMG);
  assert.equal((await newQuiz(st)).records.length, 2);
});

/* a finished write session with two handwritten answers, exported as a backup */
async function withWriting() {
  const st = await newStore(); const q = await seed(st, 2);
  await q.startSession({ kind: 'write', levelId: 'L1', mode: 'practice' });
  await q.answerWrite(IMG + 'A'); await q.answerWrite(IMG + 'B'); await q.setOk(0, true); await q.setOk(1, false); await q.finishMarking();
  const { json } = await q.exportBackup();
  return { st, q, json: () => JSON.parse(JSON.stringify(json)) };
}

test('merge: identical duplicates (levels, characters, records with handwriting) are skipped, not conflicts', async () => {
  const { st, q, json } = await withWriting(); const before = await snapshot(st);
  const r = await q.importBackup(json(), 'merge');
  assert.equal(r.aborted, undefined); assert.equal(r.conflicts.length, 0);
  assert.equal(r.identical, 3);                                                              // 2 characters + 1 record
  assert.deepEqual(r.added, { levels: 0, chars: 0, records: 0 }); assert.equal(await snapshot(st), before);
});

test('merge: every character field difference with the same ID is a conflict', async () => {
  const { st, q, json } = await withWriting(); const before = await snapshot(st);
  for (const [f, name] of [['jp', '粵拼'], ['w', '詞語'], ['wjp', '詞語粵拼'], ['m', '意思'], ['c', '字']]) {
    const j = json(); j.data.levels[0].chars[0][f] = f === 'c' ? '水' : 'DIFFERENT';
    const r = await q.importBackup(j, 'merge');
    assert.equal(r.aborted, true, f); assert.equal(r.conflicts.length, 1); assert.match(r.conflicts[0], new RegExp('字 \\(c1\\).*' + name + '（現有'));
  }
  assert.equal(await snapshot(st), before);
});

test('merge: different handwriting image with the same record ID is a conflict (presence alone is not enough)', async () => {
  const { st, q, json } = await withWriting(); const before = await snapshot(st);
  const j = json(); j.data.records[0].items[1].img = IMG + 'TAMPERED';
  const r = await q.importBackup(j, 'merge');
  assert.equal(r.aborted, true); assert.equal(r.conflicts.length, 1); assert.match(r.conflicts[0], /第 2 題的手寫圖片不同/); assert.match(r.conflicts[0], /寫字練習/);
  assert.equal(await snapshot(st), before);
  const j2 = json(); delete j2.data.records[0].items[0].img;                               // image missing in the backup
  assert.equal((await q.importBackup(j2, 'merge')).aborted, true);
});

test('merge: different nested record items (order, marks, fields, count) are conflicts', async () => {
  const { st, q, json } = await withWriting(); const before = await snapshot(st);
  const variants = [
    [j => j.data.records[0].items.reverse(), /的字不同/],
    [j => { j.data.records[0].items[0].ok = false; }, /第 1 題的評分不同/],
    [j => { j.data.records[0].items[1].w = '另一個詞'; }, /詞語或粵拼不同/],
    [j => { j.data.records[0].items.pop(); }, /題目數量不同/],
    [j => { j.data.records[0].date += 1; }, /日期不同/],
    [j => { j.data.records[0].mode = 'exam'; }, /模式不同/],
    [j => { j.data.records[0].levelName = 'X'; }, /級別名稱不同/],
  ];
  for (const [mut, re] of variants) { const j = json(); mut(j); const r = await q.importBackup(j, 'merge'); assert.equal(r.aborted, true, String(re)); assert.match(r.conflicts[0], re); }
  assert.equal(await snapshot(st), before);
});

test('merge: different level metadata with the same ID is a conflict', async () => {
  const { st, q, json } = await withWriting(); const before = await snapshot(st);
  for (const [f, v, re] of [['name', '別的名', /名稱/], ['desc', '別的說明', /說明/], ['created', 999, /建立時間/]]) {
    const j = json(); j.data.levels[0][f] = v; const r = await q.importBackup(j, 'merge');
    assert.equal(r.aborted, true, f); assert.match(r.conflicts[0], /^級別 \(L1\)/); assert.match(r.conflicts[0], re);
  }
  assert.equal(await snapshot(st), before);
});

test('merge conflicts never overwrite or discard existing data, and invalid files change nothing', async () => {
  const { st, q, json } = await withWriting(); const before = await snapshot(st);
  const j = json(); j.data.records[0].items[0].ok = false; j.data.levels.push(level('NEW', '新級別', [CH('n1', '火')])); j.data.records.push(rec('rNew'));
  assert.equal((await q.importBackup(j, 'merge')).aborted, true);
  assert.equal(await snapshot(st), before);                                                  // the valid new level/record were NOT applied either
  const bad = json(); bad.data.records[0].items[0].img = 'nope';
  await assert.rejects(q.importBackup(bad, 'merge'), e => e instanceof C.ImportError);
  assert.equal(await snapshot(st), before);
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
