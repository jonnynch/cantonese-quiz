/* Learner profiles.
   Design: every learner owns a separate IndexedDB database (levels, characters, records, images, unfinished session, draft),
   so one learner's data can never be read, written or deleted through another learner's store. The app-wide profile list
   lives in its own small registry database. The database that existed before profiles (`cantonese-quiz`) is adopted as the
   default learner's database in place: no learner data is copied or rewritten. */
(function (root, factory) {
  const dep = (typeof module === 'object' && module.exports) ? require('./storage.js') : root.CQStorage;
  const m = factory(dep);
  if (typeof module === 'object' && module.exports) module.exports = m; else root.CQProfiles = m;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (S) {
  const REGISTRY_DB = 'cantonese-quiz-profiles', LEGACY_DB = S.DB_NAME, LEGACY_PROFILE_ID = 'p-legacy';
  const AVATARS = ['cat', 'dog', 'rabbit', 'panda', 'bear', 'fox', 'lion', 'frog', 'owl', 'whale'];
  const AVATAR_EMOJI = { cat: '🐱', dog: '🐶', rabbit: '🐰', panda: '🐼', bear: '🐻', fox: '🦊', lion: '🦁', frog: '🐸', owl: '🦉', whale: '🐳' };
  const MAX_NAME = 20;
  const defaultUid = () => 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  class ProfileError extends Error { constructor(code, message) { super(message); this.name = 'ProfileError'; this.code = code; } }

  function openRegistryDb(idb) {
    return new Promise((resolve, reject) => {
      if (!idb) return reject(new S.StorageError('unavailable', 'IndexedDB is not available'));
      let rq; try { rq = idb.open(REGISTRY_DB, 1); } catch (e) { return reject(S.wrap(e, 'unavailable')); }
      rq.onupgradeneeded = () => { const db = rq.result; db.createObjectStore('profiles', { keyPath: 'id' }); db.createObjectStore('meta'); };
      rq.onsuccess = () => { const db = rq.result; db.onversionchange = () => db.close(); resolve(db); };
      rq.onerror = () => reject(S.wrap(rq.error, 'unavailable'));
      rq.onblocked = () => reject(new S.StorageError('blocked', 'Registry upgrade blocked'));
    });
  }

  function validate({ name, avatar }) {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n) throw new ProfileError('name', '請輸入學習者的名字');
    if ([...n].length > MAX_NAME) throw new ProfileError('name', '名字最多 ' + MAX_NAME + ' 個字');
    if (!AVATARS.includes(avatar)) throw new ProfileError('avatar', '請選擇一個頭像');
    return { name: n, avatar };
  }
  const deleteMessage = name => '確定要永久刪除「' + name + '」嗎？\n這個學習者所有的級別、字、練習和考試紀錄、手寫圖片和未完成的測驗都會被刪除，無法復原。其他學習者的資料不受影響。\n（如果只是暫時不用，可以選擇「封存學習者」。）';

  class ProfileManager {
    constructor(idb, o) {
      o = o || {}; this.idb = idb; this.now = o.now || Date.now; this.uid = o.uid || defaultUid; this.db = null; this.stores = new Map();
    }
    async init() { this.db = await openRegistryDb(this.idb); await this._finishDeletes(); return this; }
    _tx(mode, fn) { return S.run(this.db, ['profiles', 'meta'], mode, fn); }
    getMeta(k) { return this._tx('readonly', (p, m, out) => { m.get(k).onsuccess = e => { out.v = e.target.result; }; }); }
    setMeta(k, v) { return this._tx('readwrite', (p, m) => { m.put(v, k); }); }
    _put(p) { return this._tx('readwrite', (st) => { st.put(p); }); }
    _all() { return this._tx('readonly', (st, m, out) => { st.getAll().onsuccess = e => { out.v = e.target.result; }; }); }

    /* which: 'active' (default, what the learner picker shows) | 'archived' | 'all'. Profiles being deleted are never listed. */
    async list(which) {
      which = which || 'active';
      return (await this._all()).filter(p => p.state !== 'deleting' && (which === 'all' || (which === 'archived') === !!p.archivedAt))
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    }
    async get(id) { const p = await this._tx('readonly', (st, m, out) => { st.get(id).onsuccess = e => { out.v = e.target.result; }; }); return p && p.state !== 'deleting' ? p : null; }
    async _require(id) { const p = await this.get(id); if (!p) throw new ProfileError('not-found', '找不到這個學習者'); return p; }

    async create(input) {
      const v = validate(input); const id = this.uid(), t = this.now();
      const p = { id, name: v.name, avatar: v.avatar, createdAt: t, updatedAt: t, archivedAt: null, state: 'active', dbName: 'cantonese-quiz-' + id };
      await this._put(p); return p;
    }
    async update(id, input) {
      const p = await this._require(id); const v = validate({ name: input.name == null ? p.name : input.name, avatar: input.avatar == null ? p.avatar : input.avatar });
      const n = { ...p, ...v, updatedAt: this.now() }; await this._put(n); return n;
    }
    async archive(id) {
      const p = await this._require(id); if (p.archivedAt) return p;
      this.closeStore(id); const n = { ...p, archivedAt: this.now(), updatedAt: this.now() }; await this._put(n); return n;
    }
    async restore(id) {
      const p = await this._require(id); if (!p.archivedAt) return p;
      const n = { ...p, archivedAt: null, updatedAt: this.now() }; await this._put(n); return n;
    }

    /* The ONLY way to reach a learner's data: a store bound to that learner's own database, whose owner mark is verified. */
    async openStore(id, o) {
      const p = await this._require(id);
      if (p.archivedAt && !(o && o.allowArchived)) throw new ProfileError('archived', '這個學習者已封存');
      const cached = this.stores.get(id); if (cached && !cached.closed) return cached;
      const db = await S.openDb(this.idb, p.dbName); const st = S.createStore(db);
      try { await S.claimOwner(st, id); } catch (e) { db.close(); throw e; }
      const close = st.close; st.closed = false; st.close = () => { st.closed = true; this.stores.delete(id); close(); };
      this.stores.set(id, st); return st;
    }
    closeStore(id) { const st = this.stores.get(id); if (st) st.close(); }
    closeAll() { [...this.stores.keys()].forEach(id => this.closeStore(id)); }

    /* Permanent deletion: explicit confirmation, then (1) hide the profile, (2) delete its whole database (all records, images,
       session, draft), (3) remove the profile row. An interruption after (1) is completed on the next start. */
    async remove(id, confirm) {
      const p = await this._require(id);
      if (!(confirm && confirm(deleteMessage(p.name)))) return { cancelled: true };
      this.closeStore(id);
      await this._put({ ...p, state: 'deleting', updatedAt: this.now() });
      await this._dropDb(p.dbName);
      await this._tx('readwrite', (st) => { st.delete(id); });
      return { ok: true };
    }
    _dropDb(name) {
      return new Promise((resolve, reject) => {
        let rq; try { rq = this.idb.deleteDatabase(name); } catch (e) { return reject(S.wrap(e)); }
        const t = setTimeout(() => reject(new S.StorageError('blocked', 'Database deletion is blocked by another open tab')), 8000);
        rq.onsuccess = () => { clearTimeout(t); resolve(); };
        rq.onerror = () => { clearTimeout(t); reject(S.wrap(rq.error)); };
      });
    }
    async _finishDeletes() {
      for (const p of (await this._all()).filter(x => x.state === 'deleting')) { await this._dropDb(p.dbName); await this._tx('readwrite', (st) => { st.delete(p.id); }); }
    }
  }

  /* ---------- adopting the data that existed before profiles ---------- */
  async function digest(st) {
    const a = await st.exportAll(), l = await st.loadAll();
    return JSON.stringify([a.levels, a.records, a.images, l.session, await st.getDraft()]);
  }
  const hasData = async st => { const a = await st.exportAll(), l = await st.loadAll(); return !!(a.levels.length || a.records.length || a.images.length || l.session); };

  /* One-time, re-runnable: (1) run the Patch 1 localStorage->IndexedDB migration into the old database, (2) if that database holds any
     data, register it as the default learner `p-legacy` (deterministic id, so a retry can never create a second default profile),
     (3) verify that the learner opens through the normal profile path and returns exactly the same data as before.
     Nothing in the old database is modified or deleted, so a failure at any point leaves all data recoverable. */
  async function adoptLegacy(mgr, ls) {
    const done = await mgr.getMeta('legacyAdoption');
    if (done && done.state === 'done') return { status: 'skipped' };
    const db = await S.openDb(mgr.idb, LEGACY_DB); const st = S.createStore(db); let before;
    try {
      await S.migrateLegacy(st, ls);                                   // Patch 1 safeguards (verify before deleting localStorage)
      if (!(await hasData(st))) { await mgr.setMeta('legacyAdoption', { state: 'done', created: false, at: mgr.now() }); return { status: 'none' }; }
      before = await digest(st);
      if (!(await mgr.get(LEGACY_PROFILE_ID))) {
        const t = mgr.now();
        await mgr._put({ id: LEGACY_PROFILE_ID, name: '學習者', avatar: AVATARS[0], createdAt: t, updatedAt: t, archivedAt: null, state: 'active', dbName: LEGACY_DB });
      }
    } finally { st.close(); }
    // verification through the real profile path: same data, now owned by the default learner
    const p = await mgr.get(LEGACY_PROFILE_ID);
    if (!p || p.dbName !== LEGACY_DB) throw new S.StorageError('migration', 'Default learner profile was not created');
    const vst = await mgr.openStore(LEGACY_PROFILE_ID, { allowArchived: true });
    if ((await digest(vst)) !== before) throw new S.StorageError('migration', 'Default learner data differs from the original data');
    await mgr.setMeta('legacyAdoption', { state: 'done', created: true, at: mgr.now() });
    return { status: 'adopted', profile: p };
  }

  return { REGISTRY_DB, LEGACY_DB, LEGACY_PROFILE_ID, AVATARS, AVATAR_EMOJI, MAX_NAME, ProfileError, ProfileManager, adoptLegacy };
});
