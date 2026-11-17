const { IDBFactory } = require('fake-indexeddb');
const S = require('../public/js/storage.js');
const C = require('../public/js/core.js');

const IMG = 'data:image/jpeg;base64,/9j/AAAA';
const newIdb = () => new IDBFactory();
async function newStore(idb) { return S.createStore(await S.openDb(idb || newIdb())); }
function memLS(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
}
function counterUid() { const p = Math.random().toString(36).slice(2, 6); let n = 0; return () => p + (++n); }
const CH = (id, c) => ({ id, c, jp: 'jp' + id, w: 'w' + c, wjp: 'wjp', m: '' });
function level(id, name, chars) { return { id, name, desc: '', chars, created: 1, modified: 1 }; }
async function newQuiz(store, o) {
  const q = new C.Quiz(store, { uid: counterUid(), shuffle: a => a.slice(), ...(o || {}) });
  await q.init(); return q;
}
async function seed(store, n = 3) {
  const q = await newQuiz(store);
  await q.mutateLevels(ls => ls.push(level('L1', '一級', Array.from({ length: n }, (_, i) => CH('c' + (i + 1), '字日月火水木'[i % 6])))));
  return q;
}
function legacyBlob() {
  return JSON.stringify({
    levels: [level('L1', '一級', [CH('c1', '日'), CH('c2', '月')])],
    records: [{ id: 'r1', levelId: 'L1', levelName: '一級', kind: 'write', mode: 'practice', parentId: null, date: 5,
      items: [{ cid: 'c1', c: '日', jp: '', w: '', wjp: '', ok: true, img: IMG }, { cid: 'c2', c: '月', jp: '', w: '', wjp: '', ok: false, img: IMG + 'B' }] }],
    cur: { id: 's1', levelId: 'L1', kind: 'write', mode: 'practice', parentId: null, started: 1, i: 1, phase: 'ask',
      items: [{ cid: 'c1', c: '日', jp: '', w: '', wjp: '', ok: null, img: IMG + 'C' }, { cid: 'c2', c: '月', jp: '', w: '', wjp: '', ok: null, img: null }] },
  });
}
const quota = () => Object.assign(new Error('full'), { name: 'QuotaExceededError' });
module.exports = { S, C, IMG, newIdb, newStore, memLS, counterUid, CH, level, newQuiz, seed, legacyBlob, quota };
