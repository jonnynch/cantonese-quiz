/* IndexedDB storage layer + one-time migration from the legacy localStorage format.
   Works in the browser (global CQStorage) and in Node (module.exports) for tests. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.CQStorage = m;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DB_NAME = 'cantonese-quiz', DB_VERSION = 1, LEGACY_KEY = 'cantonese-quiz-v1';

  class StorageError extends Error {
    constructor(code, message, cause) { super(message); this.name = 'StorageError'; this.code = code; this.cause = cause; }
  }
  function wrap(e, code) {
    if (e instanceof StorageError) return e;
    const quota = e && (e.name === 'QuotaExceededError' || e.name === 'QUOTA_EXCEEDED_ERR');
    return new StorageError(quota ? 'quota' : (code || 'write'), (e && e.message) || String(e), e);
  }

  function openDb(idb, name) {
    return new Promise((resolve, reject) => {
      if (!idb) return reject(new StorageError('unavailable', 'IndexedDB is not available'));
      let rq;
      try { rq = idb.open(name || DB_NAME, DB_VERSION); } catch (e) { return reject(wrap(e, 'unavailable')); }
      rq.onupgradeneeded = (ev) => {
        const db = rq.result, old = ev.oldVersion;
        if (old < 1) {
          db.createObjectStore('levels', { keyPath: 'id' });
          db.createObjectStore('records', { keyPath: 'id' }).createIndex('levelId', 'levelId');
          db.createObjectStore('images', { keyPath: 'id' }).createIndex('sid', 'sid');
          db.createObjectStore('sessions');
          db.createObjectStore('meta');
        }
      };
      rq.onsuccess = () => { const db = rq.result; db.onversionchange = () => db.close(); resolve(db); };
      rq.onerror = () => reject(wrap(rq.error, 'unavailable'));
      rq.onblocked = () => reject(new StorageError('blocked', 'Database upgrade blocked by another tab'));
    });
  }

  /* Run fn inside one transaction. Resolves only when the transaction has COMMITTED. */
  function run(db, names, mode, fn) {
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(names, mode); } catch (e) { return reject(wrap(e)); }
      const out = {};
      tx.oncomplete = () => resolve(out.v);
      tx.onabort = () => reject(wrap(tx.error || new Error('Transaction aborted')));
      tx.onerror = () => { /* abort handler reports it */ };
      try { fn(...names.map(n => tx.objectStore(n)), out); }
      catch (e) { try { tx.abort(); } catch (_) { /* already finished */ } reject(wrap(e)); }
    });
  }
  const putIfAbsent = (st, obj) => { const r = st.getKey(obj.id); r.onsuccess = () => { if (r.result === undefined) st.put(obj); }; };

  function createStore(db) {
    return {
      db,
      loadAll() {
        return run(db, ['levels', 'records', 'sessions'], 'readonly', (lv, rc, ss, out) => {
          const o = out.v = {};
          lv.getAll().onsuccess = e => { o.levels = e.target.result; };
          rc.getAll().onsuccess = e => { o.records = e.target.result; };
          ss.get('current').onsuccess = e => { o.session = e.target.result || null; };
        });
      },
      saveLevels(levels) {
        return run(db, ['levels'], 'readwrite', (st) => {
          const keep = new Set(levels.map(l => l.id));
          st.getAllKeys().onsuccess = e => { e.target.result.forEach(k => { if (!keep.has(k)) st.delete(k); }); };
          levels.forEach(l => st.put(l));
        });
      },
      /* Persist the unfinished session (and optionally one new image) atomically. */
      saveSession(session, image) {
        return run(db, ['sessions', 'images'], 'readwrite', (ss, im) => { if (image) im.put(image); ss.put(session, 'current'); });
      },
      /* Start a new session; if replacing an old (explicitly discarded) one, remove its images in the same transaction. */
      startSession(session, oldSid) {
        return run(db, ['sessions', 'images'], 'readwrite', (ss, im) => {
          if (oldSid) im.index('sid').getAllKeys(oldSid).onsuccess = e => e.target.result.forEach(k => im.delete(k));
          ss.put(session, 'current');
        });
      },
      /* Finish: write the completed record and remove the unfinished session in ONE transaction. */
      completeSession(record) {
        return run(db, ['records', 'sessions'], 'readwrite', (rc, ss) => { rc.put(record); ss.delete('current'); });
      },
      discardSession(sid) {
        return run(db, ['sessions', 'images'], 'readwrite', (ss, im) => {
          ss.delete('current');
          im.index('sid').getAllKeys(sid).onsuccess = e => e.target.result.forEach(k => im.delete(k));
        });
      },
      getImage(id) {
        return run(db, ['images'], 'readonly', (im, out) => { im.get(id).onsuccess = e => { out.v = e.target.result || null; }; });
      },
      /* Replace every data store in one transaction (explicit "replace all" import). */
      replaceAll({ levels, records, images }) {
        return run(db, ['levels', 'records', 'images', 'sessions'], 'readwrite', (lv, rc, im, ss) => {
          lv.clear(); rc.clear(); im.clear(); ss.clear();
          levels.forEach(x => lv.put(x)); records.forEach(x => rc.put(x)); images.forEach(x => im.put(x));
        });
      },
      /* Merge: updated levels are written whole; records/images are only added if absent. */
      applyMerge({ levels, records, images }) {
        return run(db, ['levels', 'records', 'images'], 'readwrite', (lv, rc, im) => {
          levels.forEach(x => lv.put(x)); records.forEach(x => putIfAbsent(rc, x)); images.forEach(x => putIfAbsent(im, x));
        });
      },
      exportAll() {
        return run(db, ['levels', 'records', 'images'], 'readonly', (lv, rc, im, out) => {
          const o = out.v = {};
          lv.getAll().onsuccess = e => { o.levels = e.target.result; };
          rc.getAll().onsuccess = e => { o.records = e.target.result; };
          im.getAll().onsuccess = e => { o.images = e.target.result; };
        });
      },
      getMeta(key) { return run(db, ['meta'], 'readonly', (m, out) => { m.get(key).onsuccess = e => { out.v = e.target.result; }; }); },
      setMeta(key, val) { return run(db, ['meta'], 'readwrite', (m) => { m.put(val, key); }); },
      close() { db.close(); },
    };
  }

  /* ---------------- legacy migration ---------------- */
  function convertLegacy(d) {
    if (!d || !Array.isArray(d.levels) || !Array.isArray(d.records)) throw new StorageError('corrupt', 'Legacy data has an invalid structure');
    const images = [];
    const conv = (items, owner) => (Array.isArray(items) ? items : []).map((x, k) => {
      const { img, ...rest } = x || {};
      if (typeof img === 'string' && img) { const id = 'm-' + owner + '-' + k; images.push({ id, sid: owner, data: img }); return { ...rest, imgId: id }; }
      return rest;
    });
    d.levels.forEach(l => { if (!l || !l.id || !Array.isArray(l.chars)) throw new StorageError('corrupt', 'Legacy level without id/chars'); });
    d.records.forEach(r => { if (!r || !r.id || !Array.isArray(r.items)) throw new StorageError('corrupt', 'Legacy record without id/items'); });
    const levels = d.levels.map(l => ({ ...l }));
    const records = d.records.map(r => ({ ...r, items: conv(r.items, r.id) }));
    const session = d.cur && d.cur.id ? { ...d.cur, items: conv(d.cur.items, d.cur.id) } : null;
    return { levels, records, images, session };
  }

  /* Compare what is in IndexedDB with what the legacy blob contained. Returns a list of problems (empty = verified). */
  async function verifyMigration(store, conv, checkSession) {
    const all = await store.exportAll(), cur = (await store.loadAll()).session;
    const lv = new Map(all.levels.map(l => [l.id, l])), rc = new Map(all.records.map(r => [r.id, r])), im = new Map(all.images.map(i => [i.id, i]));
    const bad = [];
    conv.levels.forEach(l => { const x = lv.get(l.id); if (!x || x.chars.length < l.chars.length) bad.push('level ' + l.id); });
    conv.records.forEach(r => { const x = rc.get(r.id); if (!x || x.items.length !== r.items.length) bad.push('record ' + r.id); });
    conv.images.forEach(i => { const x = im.get(i.id); if (!x || x.data !== i.data) bad.push('image ' + i.id); });
    if (checkSession && conv.session && !(cur && cur.id === conv.session.id)) {
      const wasCompleted = rc.has(conv.session.id); // session may have been finished after migration
      if (!wasCompleted) bad.push('session ' + conv.session.id);
    }
    return bad;
  }

  /* Safe, re-runnable migration:
     1. copy everything in ONE transaction (put-if-absent) and mark meta.migration='copied' in that same transaction;
     2. verify by reading back;
     3. only then delete the legacy localStorage key and mark 'done'.
     A crash at any point leaves the legacy data intact; a re-run never overwrites newer IndexedDB data. */
  async function migrateLegacy(store, ls) {
    let raw = null;
    try { raw = ls ? ls.getItem(LEGACY_KEY) : null; } catch (e) { raw = null; }
    if (raw == null) return { status: 'none' };
    const mig = await store.getMeta('migration');
    if (mig && mig.state === 'done') return { status: 'skipped' };
    let legacy, conv;
    try { legacy = JSON.parse(raw); conv = convertLegacy(legacy); }
    catch (e) { throw (e instanceof StorageError ? e : new StorageError('corrupt', 'Legacy data cannot be parsed', e)); }

    if (!mig || mig.state !== 'copied') {
      try {
        await run(store.db, ['levels', 'records', 'images', 'sessions', 'meta'], 'readwrite', (lv, rc, im, ss, mt) => {
          conv.levels.forEach(x => putIfAbsent(lv, x));
          conv.records.forEach(x => putIfAbsent(rc, x));
          conv.images.forEach(x => putIfAbsent(im, x));
          if (conv.session) { const g = ss.getKey('current'); g.onsuccess = () => { if (g.result === undefined) ss.put(conv.session, 'current'); }; }
          mt.put({ state: 'copied', at: Date.now() }, 'migration');
        });
      } catch (e) { throw new StorageError('migration', 'Migration could not write to IndexedDB', e); }
    }
    let bad;
    try { bad = await verifyMigration(store, conv, !mig || mig.state !== 'copied'); } catch (e) { throw new StorageError('migration', 'Migration verification failed to run', e); }
    if (bad.length) throw new StorageError('migration', 'Migration verification found problems: ' + bad.slice(0, 5).join(', '));
    try { ls.removeItem(LEGACY_KEY); } catch (e) { /* harmless: state stays 'copied' and removal is retried next load */ }
    await store.setMeta('migration', { state: 'done', at: Date.now() });
    return { status: 'migrated', levels: conv.levels.length, records: conv.records.length, images: conv.images.length };
  }

  return { DB_NAME, LEGACY_KEY, StorageError, openDb, createStore, migrateLegacy, convertLegacy };
});
