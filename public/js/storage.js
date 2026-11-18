/* IndexedDB storage layer + one-time migration from the legacy localStorage format.
   Works in the browser (global CQStorage) and in Node (module.exports) for tests. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.CQStorage = m;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DB_NAME = 'cantonese-quiz', DB_VERSION = 2, LEGACY_KEY = 'cantonese-quiz-v1';

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
        if (old < 2) db.createObjectStore('corrections', { keyPath: 'id' });   // v2: writing-correction activities (data only added, never changed)
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
        return run(db, ['levels', 'records', 'sessions', 'corrections'], 'readonly', (lv, rc, ss, cs, out) => {
          const o = out.v = {};
          cs.getAll().onsuccess = e => { o.corrections = e.target.result; };
          lv.getAll().onsuccess = e => { o.levels = e.target.result; };
          rc.getAll().onsuccess = e => { o.records = e.target.result; };
          ss.get('current').onsuccess = e => { o.session = e.target.result || null; };
        });
      },
      saveLevels(levels) {
        return run(db, ['levels'], 'readwrite', (st) => {
          const keep = new Set(levels.map(l => l.id));
          st.getAllKeys().onsuccess = e => { e.target.result.forEach(k => { if (!keep.has(k)) st.delete(k); }); };
          levels.forEach((l, i) => st.put({ ...l, ord: i }));   // `ord` keeps the user's level order
        });
      },
      /* Persist the unfinished session (and optionally one new image) atomically. */
      saveSession(session, image) {
        return run(db, ['sessions', 'images'], 'readwrite', (ss, im) => { if (image) im.put(image); ss.put(session, 'current'); ss.delete('draft'); });
      },
      /* Start a new session; if replacing an old (explicitly discarded) one, remove its images in the same transaction. */
      startSession(session, oldSid) {
        return run(db, ['sessions', 'images'], 'readwrite', (ss, im) => {
          if (oldSid) im.index('sid').getAllKeys(oldSid).onsuccess = e => e.target.result.forEach(k => im.delete(k));
          ss.put(session, 'current'); ss.delete('draft');
        });
      },
      /* Finish: write the completed record and remove the unfinished session in ONE transaction. */
      /* The optional writing-correction activity is created in the SAME transaction (put-if-absent: its id is derived from the
         record id, so it can never be created twice). */
      completeSession(record, correction) {
        return run(db, ['records', 'sessions', 'corrections'], 'readwrite', (rc, ss, cs) => {
          rc.put(record); ss.delete('current'); ss.delete('draft'); if (correction) putIfAbsent(cs, correction);
        });
      },
      /* One correction attempt: the updated activity, the new image (or none = attempt cleared) and removal of the replaced image, atomically. */
      saveCorrection(correction, image, deleteImgId) {
        return run(db, ['corrections', 'images'], 'readwrite', (cs, im) => { if (image) im.put(image); if (deleteImgId) im.delete(deleteImgId); cs.put(correction); });
      },
      discardSession(sid) {
        return run(db, ['sessions', 'images'], 'readwrite', (ss, im) => {
          ss.delete('current'); ss.delete('draft');
          im.index('sid').getAllKeys(sid).onsuccess = e => e.target.result.forEach(k => im.delete(k));
        });
      },
      /* Handwriting draft of the question currently being written: { sid, qi, cid, seq, data|null }.
         An older write (lower seq, same session+question) can never replace a newer one. */
      saveDraft(d) {
        return run(db, ['sessions'], 'readwrite', (ss) => {
          const g = ss.get('draft');
          g.onsuccess = () => { const o = g.result; if (!(o && o.sid === d.sid && o.qi === d.qi && o.seq > d.seq)) ss.put(d, 'draft'); };
        });
      },
      getDraft() { return run(db, ['sessions'], 'readonly', (ss, out) => { ss.get('draft').onsuccess = e => { out.v = e.target.result || null; }; }); },
      getImages(ids) {
        return run(db, ['images'], 'readonly', (im, out) => { const o = out.v = {}; ids.forEach(id => { im.get(id).onsuccess = e => { if (e.target.result) o[id] = e.target.result.data; }; }); });
      },
      getImage(id) {
        return run(db, ['images'], 'readonly', (im, out) => { im.get(id).onsuccess = e => { out.v = e.target.result || null; }; });
      },
      /* Replace every data store in one transaction (explicit "replace all" import). */
      replaceAll({ levels, records, images }) {
        return run(db, ['levels', 'records', 'images', 'sessions', 'corrections'], 'readwrite', (lv, rc, im, ss, cs) => {
          lv.clear(); rc.clear(); ss.clear();
          levels.forEach((x, i) => lv.put({ ...x, ord: i })); records.forEach(x => rc.put(x));
          // writing-correction activities are not part of the backup format yet: keep them (and their images) instead of silently losing them
          cs.getAllKeys().onsuccess = e => {
            const keep = new Set(e.target.result);
            im.openCursor().onsuccess = ev => { const c = ev.target.result; if (c) { if (!keep.has(c.value.sid)) c.delete(); c.continue(); } else images.forEach(x => im.put(x)); };
          };
        });
      },
      /* Merge: updated levels are written whole; new levels are appended after the existing ones;
         records/images are only added if absent. */
      applyMerge({ newLevels, updatedLevels, records, images }) {
        return run(db, ['levels', 'records', 'images'], 'readwrite', (lv, rc, im) => {
          updatedLevels.forEach(x => lv.put(x));
          lv.count().onsuccess = e => { newLevels.forEach((x, i) => lv.put({ ...x, ord: e.target.result + i })); };
          records.forEach(x => putIfAbsent(rc, x)); images.forEach(x => putIfAbsent(im, x));
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
    const levels = d.levels.map((l, i) => ({ ...l, ord: i }));
    const records = d.records.map(r => ({ ...r, items: conv(r.items, r.id) }));
    const session = d.cur && d.cur.id ? { ...d.cur, items: conv(d.cur.items, d.cur.id) } : null;
    return { levels, records, images, session };
  }

  /* ---- deterministic, field-level comparison (never just counts or presence) ---- */
  function diffs(a, b, path, out) {
    if (out.length >= 12) return;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const arr = Array.isArray(a);
      if (arr !== Array.isArray(b)) { out.push(path); return; }
      new Set([...Object.keys(a), ...Object.keys(b)]).forEach(k => diffs(a[k], b[k], path + (arr ? '[' + k + ']' : '.' + k), out));
    } else if (a !== b) out.push(path);
  }
  const PART_NAMES = { levels: '級別', records: '紀錄', images: '手寫圖片', session: '未完成的測驗' };

  /* Compare EVERYTHING that was in the legacy blob with what is now in IndexedDB.
     Returns { parts:Set, problems:[path...] }; empty problems = verified. */
  async function verifyMigration(store, conv) {
    const all = await store.exportAll(), cur = (await store.loadAll()).session;
    const lv = new Map(all.levels.map(l => [l.id, l])), rc = new Map(all.records.map(r => [r.id, r])), im = new Map(all.images.map(i => [i.id, i]));
    const problems = [], parts = new Set();
    const check = (part, label, exp, act) => { const o = []; diffs(exp, act, label, o); if (o.length) { parts.add(part); problems.push(...o); } };
    conv.levels.forEach(l => check('levels', 'levels[' + l.id + ']', l, lv.get(l.id)));      // names, ord, every character field, character order
    conv.records.forEach(r => check('records', 'records[' + r.id + ']', r, rc.get(r.id)));   // type, level, dates, item ids/order/marks/fields
    conv.images.forEach(i => check('images', 'images[' + i.id + ']', i, im.get(i.id)));      // full image content
    if (conv.session) check('session', 'session', conv.session, cur);                         // id, order, index, answers, image refs
    return { parts, problems };
  }

  /* Safe, re-runnable migration:
     1. copy everything in ONE transaction (put-if-absent: never overwrites existing IndexedDB data);
     2. verify by reading back and comparing all content with the legacy data;
     3. only then mark meta.migration='verified', remove the legacy key and mark 'done'.
     Legacy data is never touched before step 3. A crash anywhere leaves it intact; re-running re-copies
     (a no-op for data already there) and re-verifies. Once 'verified' is recorded the copy is never repeated,
     so later IndexedDB edits are never overwritten. */
  async function migrateLegacy(store, ls) {
    let raw = null;
    try { raw = ls ? ls.getItem(LEGACY_KEY) : null; } catch (e) { raw = null; }
    if (raw == null) return { status: 'none' };
    const mig = await store.getMeta('migration');
    if (mig && mig.state === 'done') return { status: 'skipped' };
    let legacy, conv;
    try { legacy = JSON.parse(raw); conv = convertLegacy(legacy); }
    catch (e) { throw (e instanceof StorageError ? e : new StorageError('corrupt', 'Legacy data cannot be parsed', e)); }

    if (!mig || mig.state !== 'verified') {
      try {
        await run(store.db, ['levels', 'records', 'images', 'sessions'], 'readwrite', (lv, rc, im, ss) => {
          conv.levels.forEach(x => putIfAbsent(lv, x));
          conv.records.forEach(x => putIfAbsent(rc, x));
          conv.images.forEach(x => putIfAbsent(im, x));
          if (conv.session) { const g = ss.getKey('current'); g.onsuccess = () => { if (g.result === undefined) ss.put(conv.session, 'current'); }; }
        });
      } catch (e) { throw new StorageError('migration', 'Migration could not write to IndexedDB', e); }
      let v;
      try { v = await verifyMigration(store, conv); } catch (e) { throw new StorageError('migration', 'Migration verification failed to run', e); }
      if (v.problems.length) {
        const err = new StorageError('migration', 'Migration verification found differences: ' + v.problems.slice(0, 6).join(', '));
        err.parts = [...v.parts].map(p => PART_NAMES[p]); err.problems = v.problems; throw err;
      }
      try { await store.setMeta('migration', { state: 'verified', at: Date.now() }); } catch (e) { throw new StorageError('migration', 'Migration could not record verification', e); }
    }
    let removed = true;
    try { ls.removeItem(LEGACY_KEY); } catch (e) { removed = false; }
    if (removed) await store.setMeta('migration', { state: 'done', at: Date.now() });
    return { status: 'migrated', levels: conv.levels.length, records: conv.records.length, images: conv.images.length };
  }

  /* Mark a database as belonging to exactly one learner profile (set once, then verified on every open),
     so a store for profile A can never be attached to the data of profile B. */
  async function claimOwner(store, pid) {
    let cur = await store.getMeta('owner');
    if (cur === undefined) {
      await run(store.db, ['meta'], 'readwrite', (m) => { const g = m.getKey('owner'); g.onsuccess = () => { if (g.result === undefined) m.put(pid, 'owner'); }; });
      cur = await store.getMeta('owner');
    }
    if (cur !== pid) throw new StorageError('owner', 'This database belongs to a different learner profile');
    store.pid = pid; return store;
  }

  return { DB_NAME, LEGACY_KEY, StorageError, wrap, run, openDb, createStore, claimOwner, migrateLegacy, convertLegacy };
});
