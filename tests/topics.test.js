/* Topic packs (Explore): shared topic definitions that REFERENCE shared character records; per-learner progress from the per-character statistics. */
const test = require('node:test'), assert = require('node:assert/strict');
const { S, C, IMG, newIdb, CH, level } = require('./helpers');
const P = require('../public/js/profiles.js'), B = require('../public/js/backup.js'), T = require('../public/js/topics.js');

let n = 0;
const uidFrom = (...ids) => { let i = 0; return () => ids[i++] || 'p-auto' + (++n); };
async function boot(idb, uids) { const mgr = await new P.ProfileManager(idb, uids ? { uid: uidFrom(...uids) } : {}).init(); const CT = new C.SharedContent(mgr.content); await CT.load(); return { mgr, CT }; }
const quiz = async (mgr, CT, id) => { const q = new C.Quiz(await mgr.openStore(id), { content: CT }); await q.init(); return q; };
const lvl = (id, name, cs) => ({ ...level(id, name, cs), created: 1, modified: 1 });
const allChars = CT => CT.levels.flatMap(l => l.chars);
const topicOf = (CT, id) => CT.topic(id);
const glyphs = CT => allChars(CT).map(c => c.c);
async function practise(q, CT, tid, oks) {              // a topic practice exactly as the app starts it: the ordinary engine on the topic's shared characters
  const t = CT.topic(tid), cs = q.topicProgress(t).chars.map(({ id, c, jp, w, wjp }) => ({ id, c, jp, w, wjp }));
  const r = await q.startSession({ kind: 'read', levelId: 'topic:' + t.id, levelName: '主題：' + t.zh, mode: 'practice', chars: cs }); assert.equal(r.ok, true);
  const k = q.cur.items.length; for (let i = 0; i < k; i++) await q.answerRead(typeof oks === 'function' ? oks(i, q.cur.items[q.cur.i].cid) : oks);
}

test('the built-in packs: 14 topics with Traditional Chinese and English names, an icon and a character count; entries are valid', () => {
  assert.equal(T.PACKS.length, 14);
  assert.deepEqual(T.PACKS.map(p => p.zh), ['動物', '天氣', '食物', '家庭', '身體', '顏色', '數字', '交通', '學校', '自然', '屋企', '動作', '情緒', '時間']);
  assert.deepEqual(T.PACKS.map(p => p.en), ['Animals', 'Weather', 'Food', 'Family', 'Body', 'Colours', 'Numbers', 'Transport', 'School', 'Nature', 'Home', 'Actions', 'Emotions', 'Time']);
  assert.deepEqual(T.PACKS.map(p => p.items.length), [12, 10, 10, 8, 8, 7, 11, 6, 6, 7, 7, 8, 7, 8]);
  const seen = new Map();
  for (const p of T.PACKS) { assert.ok(p.id && p.icon && p.ord > 0);
    for (const [c, jp, w, wjp] of p.items) { assert.equal([...c].length, 1); assert.ok(w.includes(c), c + ' is in its word ' + w); assert.match(jp, /^[a-z]+[1-6]$/); assert.equal(wjp.split(' ').length, [...w].length);
      if (seen.has(c)) assert.deepEqual(seen.get(c), [jp, w, wjp], 'a character shared by topics has one set of data'); seen.set(c, [jp, w, wjp]); } }
  assert.equal(new Set(T.PACKS.map(p => p.id)).size, 14);
});
test('opening Explore adds the packs once; entries missing from the library go into ONE hidden shared level, with stable ids; nothing is duplicated', async () => {
  const { mgr, CT } = await boot(newIdb()); assert.equal(CT.topics.length, 0); assert.deepEqual(CT.levels, []);
  assert.equal((await CT.ensureTopics(T)).ok, true);
  assert.equal(CT.topics.length, 14); assert.deepEqual(CT.topics.map(t => t.zh), T.PACKS.map(p => p.zh));
  const lib = CT.level(T.LIB_LEVEL_ID); assert.equal(CT.levels.length, 1); assert.equal(lib.hidden, true); assert.equal(lib.name, '主題字庫'); assert.equal(lib.chars.length, 109);
  assert.equal(new Set(glyphs(CT)).size, glyphs(CT).length, 'every character exists exactly once'); assert.equal(CT.level(T.LIB_LEVEL_ID).chars.find(c => c.c === '貓').id, 'tc-8c93');
  const snapshot = JSON.stringify([CT.levels, CT.topics]);
  assert.equal((await CT.ensureTopics(T)).ok, true); assert.equal(JSON.stringify([CT.levels, CT.topics]), snapshot, 'running it again changes nothing');
  const CT2 = new C.SharedContent(mgr.content); await CT2.load(); assert.equal(JSON.stringify([CT2.levels, CT2.topics]), snapshot, 'and it is persisted in the shared content');
  const a = topicOf(CT, 'animals'); assert.equal(a.charIds.length, 12); assert.equal(CT.topicChars(a).map(c => c.c).join(''), '貓狗牛羊馬鳥魚兔熊雞豬蛇'); assert.deepEqual(CT.topicChars(a)[0], { id: 'tc-8c93', c: '貓', jp: 'maau1', w: '小貓', wjp: 'siu2 maau1', m: '' });
});
test('topics reference the EXISTING shared character records (a curriculum level\'s record is used, never copied)', async () => {
  const { CT } = await boot(newIdb());
  await CT.mutate(ls => { ls.push(lvl('L1', '一級', [CH('x1', '魚'), CH('x2', '日'), CH('x3', '山')])); ls.push(lvl('L2', '二級', [CH('y1', '魚'), CH('y2', '貓')])); });
  const before = JSON.stringify(CT.levels.map(l => l.chars));
  await CT.ensureTopics(T);
  assert.equal(JSON.stringify(CT.levels.filter(l => l.id !== T.LIB_LEVEL_ID).map(l => l.chars)), before, 'curriculum content is untouched');
  const animals = topicOf(CT, 'animals'), food = topicOf(CT, 'food'), weather = topicOf(CT, 'weather'), time = topicOf(CT, 'time'), nature = topicOf(CT, 'nature');
  assert.ok(animals.charIds.includes('x1')); assert.ok(food.charIds.includes('x1'), '魚 resolves to the first curriculum record in both topics'); assert.ok(!animals.charIds.includes('y1'));
  assert.ok(animals.charIds.includes('y2'), '貓 exists in a level, so it is referenced'); assert.ok(weather.charIds.includes('x2')); assert.ok(time.charIds.includes('x2')); assert.ok(nature.charIds.includes('x3'), '山 is in Nature');
  const lib = CT.level(T.LIB_LEVEL_ID); ['魚', '日', '貓', '山'].forEach(g => assert.equal(lib.chars.some(c => c.c === g), false, g + ' is not copied into the library'));
  assert.equal(glyphs(CT).filter(g => g === '魚').length, 2, 'only the two curriculum records of the user exist'); assert.equal(CT.topicChars(animals).find(c => c.c === '魚').id, 'x1');
  assert.equal(lib.chars.length, 109 - 4, 'the library holds exactly the characters that exist nowhere else (魚 日 貓 山 do already)'); assert.equal(allChars(CT).length, 3 + 2 + 105);
});
test('a character can belong to several topics and is still ONE record', async () => {
  const { CT } = await boot(newIdb()); await CT.ensureTopics(T);
  const of = g => CT.topics.filter(t => CT.topicChars(t).some(c => c.c === g)).map(t => t.id);
  assert.deepEqual(of('魚'), ['animals', 'food']); assert.deepEqual(of('日'), ['weather', 'time']); assert.deepEqual(of('月'), ['weather', 'time']); assert.deepEqual(of('水'), ['food', 'nature']);
  assert.deepEqual(of('食'), ['food', 'actions']); assert.deepEqual(of('家'), ['family', 'home']);
  for (const g of ['魚', '日', '月', '水', '食', '家']) { const ids = CT.topics.flatMap(t => CT.topicChars(t)).filter(c => c.c === g).map(c => c.id); assert.equal(new Set(ids).size, 1, g); assert.equal(allChars(CT).filter(c => c.c === g).length, 1); }
  assert.equal(CT.topics.reduce((k, t) => k + t.charIds.length, 0), 115); assert.equal(allChars(CT).length, 109);
});
test('topic membership is independent of the levels: the same topics result whatever the curriculum holds, and removing a level only drops unresolvable references', async () => {
  const { CT } = await boot(newIdb()); await CT.ensureTopics(T);
  const ids = topicOf(CT, 'colours').charIds.slice(); assert.equal(CT.topicChars(topicOf(CT, 'colours')).length, 7);
  await CT.mutate(ls => ls.push(lvl('L1', '一級', [CH('q1', '紅')]))); assert.deepEqual(topicOf(CT, 'colours').charIds, ids, 'adding a level never rewrites a topic');
  await CT.mutate(ls => { ls.find(l => l.id === T.LIB_LEVEL_ID).chars = ls.find(l => l.id === T.LIB_LEVEL_ID).chars.filter(c => c.c !== '紅'); });
  assert.equal(CT.topicChars(topicOf(CT, 'colours')).length, 6, 'a reference that no longer resolves is skipped, not a crash'); assert.equal(CT.topicChars(null).length, 0); assert.equal(CT.topicChars({ charIds: ['nope'] }).length, 0);
});

/* ---- progress ---- */
test('progress is tracked per character: learned after two correct answers in a row, never lost by a later reload', async () => {
  const idb = newIdb(), { mgr, CT } = await boot(idb); await CT.ensureTopics(T); const p = await mgr.create({ name: 'A', avatar: 'cat' }); let q = await quiz(mgr, CT, p.id);
  const a = () => q.topicProgress(CT.topic('animals'));
  assert.deepEqual([a().learned, a().total], [0, 12]); assert.equal(a().chars.every(c => !c.learned), true);
  await practise(q, CT, 'animals', true); assert.equal(a().learned, 0, 'one correct answer is not enough'); assert.equal(q.records.length, 1); assert.equal(q.records[0].levelId, 'topic:animals'); assert.equal(q.records[0].levelName, '主題：動物');
  await practise(q, CT, 'animals', (i, cid) => !CT.topicChars(CT.topic('animals')).slice(0, 5).some(c => c.id === cid));      // five characters answered wrong in the second round
  assert.equal(a().learned, 7); assert.equal(a().chars.filter(c => c.learned).length, 7); assert.equal(C.TOPIC.LEARNED_STREAK, 2);
  await practise(q, CT, 'animals', true); assert.equal(a().learned, 7, 'the five that were wrong are back at a streak of 1: not learned yet; the other seven stay learned');
  q = await quiz(mgr, CT, p.id); const after = q.topicProgress(CT.topic('animals')); assert.equal(after.total, 12); assert.equal(after.learned, 7);
  const food = q.topicProgress(CT.topic('food')); assert.equal(food.learned, 1, '魚 is learned in Animals, so it counts in Food too (one record, one progress)');
});
test('progress is independent between profiles', async () => {
  const { mgr, CT } = await boot(newIdb()); await CT.ensureTopics(T);
  const a = await mgr.create({ name: 'A', avatar: 'cat' }), b = await mgr.create({ name: 'B', avatar: 'dog' }); const qa = await quiz(mgr, CT, a.id), qb = await quiz(mgr, CT, b.id);
  await practise(qa, CT, 'weather', true); await practise(qa, CT, 'weather', true);
  assert.equal(qa.topicProgress(CT.topic('weather')).learned, 10); assert.equal(qb.topicProgress(CT.topic('weather')).learned, 0); assert.equal(qb.stats.size, 0); assert.equal(qb.records.length, 0);
  await practise(qb, CT, 'food', true); await practise(qb, CT, 'food', false);
  assert.equal(qa.topicProgress(CT.topic('food')).learned, 0); assert.equal(qb.topicProgress(CT.topic('food')).learned, 0); assert.equal((await quiz(mgr, CT, b.id)).records.length, 2); assert.equal((await quiz(mgr, CT, a.id)).records.length, 2);
  const a2 = await quiz(mgr, CT, a.id); assert.equal(a2.topicProgress(CT.topic('weather')).learned, 10); assert.equal(a2.topicProgress(CT.topic('time')).learned, 2, '日 and 月 are shared with Time');
});
test('topic learning shares the per-character statistics with the curriculum (no duplicate progress) and never rewrites curriculum records', async () => {
  const { mgr, CT } = await boot(newIdb()); await CT.mutate(ls => ls.push(lvl('L1', '一級', [CH('x1', '魚'), CH('x2', '貓'), CH('x3', '山')]))); await CT.ensureTopics(T);
  const p = await mgr.create({ name: 'A', avatar: 'cat' }), q = await quiz(mgr, CT, p.id);
  await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' }); for (let i = 0; i < 3; i++) await q.answerRead(true);
  const curRec = JSON.stringify(q.records[0]), fishBefore = JSON.stringify(q.stats.get('x1').read.practice); assert.equal(q.stats.get('x1').read.consecutiveCorrect, 1);
  assert.equal(q.topicProgress(CT.topic('animals')).chars.find(c => c.c === '魚').learned, false);
  await practise(q, CT, 'animals', true);
  assert.equal(JSON.stringify(q.records.find(r => r.levelId === 'L1')), curRec, 'the curriculum record is unchanged'); assert.equal(q.records.length, 2);
  assert.equal(q.stats.get('x1').read.practice.attempts, 2, 'ONE statistics row for 魚: curriculum + topic attempts'); assert.equal(q.stats.get('x1').read.consecutiveCorrect, 2); assert.notEqual(JSON.stringify(q.stats.get('x1').read.practice), fishBefore);
  assert.equal(q.topicProgress(CT.topic('animals')).chars.find(c => c.c === '魚').learned, true, 'learned through the curriculum + the topic');
  const ids = [...q.stats.keys()]; assert.equal(new Set(ids).size, ids.length); assert.equal(ids.filter(i => ['x1', 'tc-9b5a', 'tc-9b5a'].includes(i)).length, 1, 'no second statistics row for 魚');
  assert.equal(q.stats.has('tc-9b5a'), false); assert.equal(q.levels.find(l => l.id === 'L1').chars.length, 3);
});
test('topic learning does not grant level mastery, and a level\'s manual mastery does not gate any topic', async () => {
  const { mgr, CT } = await boot(newIdb()); await CT.mutate(ls => { ls.push(lvl('L1', '一級', [CH('x1', '魚'), CH('x2', '貓')])); ls.push(lvl('L2', '二級', [CH('y1', '山')])); }); await CT.ensureTopics(T);
  const p = await mgr.create({ name: 'A', avatar: 'cat' }), q = await quiz(mgr, CT, p.id);
  assert.equal(q.masteryOf('L1').status, 'notStarted'); await practise(q, CT, 'animals', true); await practise(q, CT, 'animals', true); await practise(q, CT, 'nature', true); await practise(q, CT, 'nature', true);
  assert.equal(q.topicProgress(CT.topic('animals')).learned, 12); assert.equal(q.mastery.size, 0, 'no mastery row was written');
  assert.deepEqual(['L1', 'L2'].map(id => q.masteryOf(id)), [{ status: 'notStarted', manual: false }, { status: 'notStarted', manual: false }], 'not even the automatic "learning" (a topic record is not a level record)');
  assert.equal(q.records.every(r => r.levelId.startsWith('topic:')), true);
  await q.setMastery('L1', 'mastered'); await q.setMastery('L2', 'notStarted');                                                       // any mastery state: topics stay open
  for (const t of CT.topics) { const pr = q.topicProgress(t); assert.ok(pr.total > 0); }
  await practise(q, CT, 'food', true); assert.equal(q.records.at(-1).levelId, 'topic:food'); assert.equal(q.masteryOf('L1').status, 'mastered'); assert.equal(q.masteryOf('L2').status, 'notStarted');
  assert.equal((await q.startSession({ kind: 'write', levelId: 'topic:colours', levelName: '主題：顏色', mode: 'practice', chars: q.topicProgress(CT.topic('colours')).chars })).ok, true);
});
test('topic practice has the same engine: a topic session can be suspended, resumed, ended early and revised like any other', async () => {
  const { mgr, CT } = await boot(newIdb()); await CT.ensureTopics(T); const p = await mgr.create({ name: 'A', avatar: 'cat' }); let q = await quiz(mgr, CT, p.id);
  const cs = q.topicProgress(CT.topic('body')).chars; assert.equal((await q.startSession({ kind: 'read', levelId: 'topic:body', levelName: '主題：身體', mode: 'practice', chars: cs })).ok, true);
  await q.answerRead(true); await q.answerRead(false);
  assert.equal((await q.startSession({ kind: 'read', levelId: 'topic:body', levelName: '主題：身體', mode: 'practice', chars: cs })).duplicate, true);        // never two copies
  q = await quiz(mgr, CT, p.id); assert.equal(q.cur.i, 2); assert.equal(q.cur.levelName, '主題：身體'); assert.equal(q.sessions.length, 1);
  assert.equal((await q.endEarly()).ok, true); const rec = q.records[0]; assert.equal(rec.items.length, 2); assert.equal(rec.endedEarly, true); assert.equal(rec.levelName, '主題：身體');
  const bad = rec.items.filter(x => !x.ok); assert.equal((await q.startSession({ kind: 'read', levelId: rec.levelId, levelName: rec.levelName, mode: 'revision', parentId: rec.id, chars: bad.map(x => ({ id: x.cid, c: x.c, jp: x.jp, w: x.w, wjp: x.wjp })) })).ok, true);
  assert.equal(q.cur.levelName, '主題：身體');
});
test('the curriculum is unaffected: the hidden library is just another shared level, exams still draw 20 distinct characters from their own level', async () => {
  const { mgr, CT } = await boot(newIdb()); await CT.mutate(ls => ls.push(lvl('L1', '一級', Array.from({ length: 22 }, (_, i) => CH('c' + i, String.fromCodePoint(0x4e00 + 100 + i)))))); await CT.ensureTopics(T);
  const p = await mgr.create({ name: 'A', avatar: 'cat' }), q = await quiz(mgr, CT, p.id); assert.equal(q.levels.length, 2);
  for (const kind of ['read', 'write']) { assert.equal((await q.startSession({ kind, levelId: 'L1', mode: 'exam' })).ok, true); const ids = q.cur.items.map(x => x.cid); assert.equal(ids.length, 20); assert.equal(new Set(ids).size, 20); assert.ok(ids.every(i => i.startsWith('c'))); await q.discard(() => true); }
  assert.equal((await q.startSession({ kind: 'read', levelId: 'L1', mode: 'practice' })).ok, true); assert.equal(q.cur.items.length, 22);
});

/* ---- persistence, upgrade, backup ---- */
test('topics persist in the shared content across a restart; a registry from before topics existed upgrades safely', async () => {
  const idb = newIdb();
  await new Promise((res, rej) => {
    const rq = idb.open(P.REGISTRY_DB, 2);
    rq.onupgradeneeded = () => { const db = rq.result; db.createObjectStore('profiles', { keyPath: 'id' }); db.createObjectStore('meta'); db.createObjectStore('levels', { keyPath: 'id' }); };
    rq.onsuccess = () => { const db = rq.result, tx = db.transaction(['levels'], 'readwrite'); tx.objectStore('levels').put({ ...lvl('L1', '一級', [CH('x1', '魚')]), ord: 0 }); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
  });
  let { mgr, CT } = await boot(idb); assert.equal(mgr.db.version, 3); assert.deepEqual(CT.levels.map(l => l.id), ['L1']); assert.deepEqual(CT.topics, []);
  await CT.ensureTopics(T); assert.ok(CT.topic('animals').charIds.includes('x1')); mgr.db.close();
  ({ mgr, CT } = await boot(idb)); assert.equal(CT.topics.length, 14); assert.ok(CT.topic('food').charIds.includes('x1')); assert.equal(CT.levels.length, 2);
});
test('the backup carries the topics ONCE with the shared content, and the learner\'s topic progress through the existing statistics and records', async () => {
  const src = await boot(newIdb(), ['pA']); await src.CT.ensureTopics(T); const a = await src.mgr.create({ name: 'A', avatar: 'cat' }), qa = await quiz(src.mgr, src.CT, a.id);
  await practise(qa, src.CT, 'animals', true); await practise(qa, src.CT, 'animals', true);
  const file = JSON.parse(JSON.stringify((await B.buildExport(src.mgr, src.CT, { profileIds: [a.id] })).json));
  assert.equal(file.content.topics.length, 14); assert.equal(JSON.stringify(file).split('"charIds"').length - 1, 14); assert.equal(file.content.levels.length, 1); assert.equal(file.content.levels[0].hidden, true);
  assert.equal(file.profiles[0].data.records.filter(r => r.levelId === 'topic:animals').length, 2); assert.equal(file.profiles[0].data.stats.length, 12);
  const dst = await boot(newIdb(), ['pA']); const a2 = await dst.mgr.create({ name: 'A2', avatar: 'cat' }); const parsed = B.parse(file); assert.equal(parsed.topics.length, 14);
  const r = await B.apply(dst.mgr, dst.CT, parsed, { content: 'merge', targets: B.suggestTargets(parsed, [a2]) });
  assert.equal(r.content.added.topics, 14); assert.equal(dst.CT.topics.length, 14); assert.equal(dst.CT.topicChars(dst.CT.topic('animals')).length, 12);
  const q2 = await quiz(dst.mgr, dst.CT, a2.id); assert.equal(q2.topicProgress(dst.CT.topic('animals')).learned, 12); assert.equal(q2.records.length, 2);
  const again = await B.apply(dst.mgr, dst.CT, B.parse(file), { content: 'merge', targets: ['p:' + a2.id] }); assert.equal(again.aborted, undefined); assert.equal(again.content.added.topics, 0); assert.equal(dst.CT.topics.length, 14);
  // a second learner on the destination has none of it
  const b2 = await dst.mgr.create({ name: 'B2', avatar: 'dog' }); assert.equal((await quiz(dst.mgr, dst.CT, b2.id)).topicProgress(dst.CT.topic('animals')).learned, 0);
  // changed topic with the same id: a reported conflict, nothing applied; replace is explicit
  const diff = JSON.parse(JSON.stringify(file)); diff.content.topics[0].charIds = diff.content.topics[0].charIds.slice(1);
  const c = await B.apply(dst.mgr, dst.CT, B.parse(diff), { content: 'merge', targets: ['skip'] }); assert.equal(c.aborted, true); assert.ok(c.content.conflicts.some(x => x.includes('動物'))); assert.equal(dst.CT.topic('animals').charIds.length, 12);
  const rep = await B.apply(dst.mgr, dst.CT, B.parse(diff), { content: 'replace', targets: ['skip'] }); assert.equal(rep.content.status, 'replaced'); assert.equal(dst.CT.topic('animals').charIds.length, 11);
});
test('backups from before topics existed import unchanged, bad topic data is rejected before anything changes, and opening Explore afterwards does not duplicate characters', async () => {
  const src = await boot(newIdb()); await src.CT.mutate(ls => ls.push(lvl('L1', '一級', [CH('x1', '魚'), CH('x2', '山')])));
  const old = JSON.parse(JSON.stringify((await B.buildExport(src.mgr, src.CT, {})).json)); assert.equal(old.content.topics, undefined);
  const dst = await boot(newIdb()); await B.apply(dst.mgr, dst.CT, B.parse(old), { content: 'merge', targets: [] }); assert.equal(dst.CT.levels.length, 1); assert.equal(dst.CT.topics.length, 0);
  await dst.CT.ensureTopics(T); assert.ok(dst.CT.topic('animals').charIds.includes('x1')); assert.equal(glyphs(dst.CT).filter(g => g === '魚').length, 1); assert.equal(glyphs(dst.CT).filter(g => g === '山').length, 1);
  for (const bad of [{ topics: 'x' }, { topics: [{ id: 'a' }] }, { topics: [{ id: 'a', zh: '甲', charIds: [1] }] }, { topics: [{ id: 'a', zh: '甲', charIds: [] }, { id: 'a', zh: '乙', charIds: [] }] }, { topics: [{ id: 'a', zh: '甲', charIds: [], ord: 'x' }] }, { topics: [{ id: '', zh: '甲', charIds: [] }] }]) {
    const f = JSON.parse(JSON.stringify(old)); f.content.topics = bad.topics; assert.throws(() => B.parse(f), e => e.name === 'ImportError');
  }
  const v1 = { format: 'cq-backup', version: 1, data: { levels: [lvl('L9', '舊', [CH('z1', '日')])], records: [] } }; assert.equal(B.parse(v1).topics, null);
  assert.equal(C.normTopic({ id: 'a', zh: '甲', charIds: ['x', 'x', 1, ''] }).charIds.length, 1); assert.equal(C.normTopic(null), null); assert.equal(C.normTopic({ id: 'a' }), null);
  assert.equal(C.charLearned(null), false); assert.equal(C.charLearned({ read: 'x', write: null }), false); assert.equal(C.charLearned({ read: { consecutiveCorrect: 2 } }), true);
  const nc = new C.Quiz((await dst.mgr.openStore((await dst.mgr.create({ name: 'Q', avatar: 'cat' })).id))); await nc.init(); assert.deepEqual(nc.topicProgress({ charIds: ['x'] }), { total: 0, learned: 0, chars: [] }, 'a stand-alone learner without shared content has no topics, and no crash');
});
