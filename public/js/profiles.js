/* Learner profiles and shared content.
   Design: LEARNING CONTENT (levels and their characters/words) is shared: it lives once in the app-wide registry database, outside every
   profile, so it exists with or without profiles and every profile sees the same content. LEARNING PROGRESS is per learner: every learner owns
   a separate IndexedDB database (records, images, unfinished sessions, drafts, corrections, adaptive statistics), so one learner's data can
   never be read, written or deleted through another learner's store. The app-wide profile list lives in the same registry database. The database that existed before profiles (`cantonese-quiz`) is adopted as the
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
      let rq; try { rq = idb.open(REGISTRY_DB, 2); } catch (e) { return reject(S.wrap(e, 'unavailable')); }
      rq.onupgradeneeded = e => {
        const db = rq.result;
        if (e.oldVersion < 1) { db.createObjectStore('profiles', { keyPath: 'id' }); db.createObjectStore('meta'); }
        if (e.oldVersion < 2) db.createObjectStore('levels', { keyPath: 'id' });          // v2: the shared learning content (data only added)
      };
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
  const deleteMessage = name => '確定要永久刪除「' + name + '」嗎？\n這個學習者所有的練習和考試紀錄、學習統計、手寫圖片和未完成的測驗都會被刪除，無法復原。學習內容（級別和字）和其他學習者的資料不受影響。\n（如果只是暫時不用，可以選擇「封存學習者」。）';

  class ProfileManager {
    constructor(idb, o) {
      o = o || {}; this.idb = idb; this.now = o.now || Date.now; this.uid = o.uid || defaultUid; this.db = null; this.stores = new Map();
    }
    async init() { this.db = await openRegistryDb(this.idb); await this._finishDeletes(); return this; }
    _tx(mode, fn) { return S.run(this.db, ['profiles', 'meta'], mode, fn); }
    getMeta(k) { return this._tx('readonly', (p, m, out) => { m.get(k).onsuccess = e => { out.v = e.target.result; }; }); }
    setMeta(k, v) { return this._tx('readwrite', (p, m) => { m.put(v, k); }); }
    _put(p) { return this._tx('readwrite', (st) => { st.put(p); }); }

    /* ---- shared content (global: independent of profiles, available before the first profile exists) ----
       A content provider for the Quiz/SharedContent classes: { loadLevels, saveLevels, mergeLevels }. */
    get content() {
      if (!this._content) this._content = {
        loadLevels: () => S.run(this.db, ['levels'], 'readonly', (lv, out) => { lv.getAll().onsuccess = e => { out.v = e.target.result; }; }),
        /* replace the whole shared content in one transaction (levels carry their order in `ord`) */
        saveLevels: levels => S.run(this.db, ['levels'], 'readwrite', (lv) => { lv.clear(); levels.forEach((x, i) => lv.put({ ...x, ord: i })); }),
        /* merge: changed levels are written whole, new levels are appended after the existing ones */
        mergeLevels: ({ newLevels, updatedLevels }) => S.run(this.db, ['levels'], 'readwrite', (lv) => {
          updatedLevels.forEach(x => lv.put(x));
          lv.count().onsuccess = e => { newLevels.forEach((x, i) => lv.put({ ...x, ord: e.target.result + i })); };
        }),
      };
      return this._content;
    }
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

  /* ---------- moving the content that used to be copied into every profile into the shared content ----------
     Deterministic merge (documented rules):
       - a level is identified by its id; the same id in several places is ONE level;
       - versions of the same level: the one with the newest `modified` wins (name, description, order of its characters); a tie goes to the
         existing shared content, then to the earlier created learner; characters of the other versions that the winner lacks are ADDED (nothing is lost);
       - a character is identified by its id; if a character id appears in two different levels, the first one is kept;
       - levels that merely have the same name but different ids are different levels: they are all kept (never guessed to be the same).
     Order: shared content first, then each learner in creation order; levels in their own order. */
  function mergeLevelSources(sources) {
    const order = [], versions = new Map();
    sources.forEach((src, rank) => src.slice().sort((a, b) => (a.ord || 0) - (b.ord || 0)).forEach(l => {
      if (!versions.has(l.id)) { versions.set(l.id, []); order.push(l.id); }
      versions.get(l.id).push({ rank, l });
    }));
    const seenChars = new Set(), out = [];
    order.forEach(id => {
      const vs = versions.get(id).slice().sort((a, b) => ((b.l.modified || 0) - (a.l.modified || 0)) || (a.rank - b.rank)), w = vs[0].l;
      const chars = [], addChars = l => (l.chars || []).forEach(c => { if (c && c.id && !seenChars.has(c.id)) { seenChars.add(c.id); chars.push({ id: c.id, c: c.c, jp: c.jp || '', w: c.w || '', wjp: c.wjp || '', m: c.m || '' }); } });
      vs.forEach(v => addChars(v.l));
      const created = vs.map(v => v.l.created).filter(x => Number.isFinite(x) && x > 0);
      out.push({ id, name: w.name, desc: w.desc || '', chars, created: created.length ? Math.min(...created) : (w.created || 0), modified: w.modified || 0 });
    });
    return out;
  }
  const stripOrd = a => JSON.stringify(a.slice().sort((x, y) => (x.ord || 0) - (y.ord || 0)).map(({ ord, ...r }) => r));
  /* Idempotent (a finished migration is skipped; a partly finished one is simply continued) and safe: (1) read the shared content and every
     profile's levels, (2) persist the merged result in the shared store, (3) read it back and compare, (4) ONLY THEN remove the old copies from the
     profiles, (5) record completion. Any failure leaves every original copy in place and the migration is retried at the next start. */
  async function migrateSharedContent(mgr) {
    const done = await mgr.getMeta('sharedContent');
    if (done && done.state === 'done') return { status: 'skipped' };
    const profiles = await mgr.list('all'), sources = [], holders = [];
    const shared = await mgr.content.loadLevels(); if (shared.length) sources.push(shared);
    try {
      for (const p of profiles) {
        const st = await mgr.openStore(p.id, { allowArchived: true }), lv = (await st.loadAll()).levels;
        if (lv.length) { sources.push(lv); holders.push({ p, st }); }
      }
      const merged = mergeLevelSources(sources);
      if (stripOrd(merged) !== stripOrd(shared)) await mgr.content.saveLevels(merged);
      const back = await mgr.content.loadLevels();
      if (stripOrd(back) !== stripOrd(merged)) throw new S.StorageError('migration', 'Shared content could not be verified after saving');
      for (const h of holders) await h.st.saveLevels([]);                 // only now are the per-profile copies removed
      await mgr.setMeta('sharedContent', { state: 'done', at: mgr.now(), levels: merged.length, profiles: profiles.length });
      return { status: holders.length ? 'migrated' : 'none', levels: merged.length };
    } finally { profiles.forEach(p => mgr.closeStore(p.id)); }
  }

  return { REGISTRY_DB, LEGACY_DB, LEGACY_PROFILE_ID, migrateSharedContent, mergeLevelSources, AVATARS, AVATAR_EMOJI, MAX_NAME, ProfileError, ProfileManager, adoptLegacy };
});
