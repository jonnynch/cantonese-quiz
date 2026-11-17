/* DOM-free application logic: levels, sessions (persist-before-advance), backup validation and merge. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.CQCore = m;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const defaultUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clone = x => JSON.parse(JSON.stringify(x));
  function shuf(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  const sortLevels = ls => ls.slice().sort((a, b) => (a.created || 0) - (b.created || 0) || (a.id < b.id ? -1 : 1));

  class ImportError extends Error {
    constructor(list) { super(list.join('；')); this.name = 'ImportError'; this.list = list; }
  }

  /* ---------------- backup validation ---------------- */
  const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
  const MAX_IMG = 3000000;
  const KINDS = ['read', 'write'], MODES = ['practice', 'revision', 'exam'];
  const isStr = v => typeof v === 'string';
  const optStr = v => v == null || typeof v === 'string';
  const str = v => (typeof v === 'string' ? v : '');
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

  /* Returns sanitised {levels, records} (records still carry inline `img`) or throws ImportError with every problem found. */
  function validateBackup(j) {
    if (!isObj(j) || j.format !== 'cq-backup') throw new ImportError(['這不是有效的備份檔']);
    if (j.version !== 1) throw new ImportError(['不支援的備份版本']);
    const d = j.data;
    if (!isObj(d) || !Array.isArray(d.levels) || !Array.isArray(d.records)) throw new ImportError(['備份缺少級別或紀錄']);
    const errs = []; const add = m => { if (errs.length < 10) errs.push(m); else errs.more = true; };
    const lvIds = new Set(), chIds = new Set(), rcIds = new Set();
    const levels = [], records = [];
    d.levels.forEach((l, i) => {
      const at = '第 ' + (i + 1) + ' 個級別';
      if (!isObj(l) || !isStr(l.id) || !l.id) return add(at + '沒有有效的編號');
      if (lvIds.has(l.id)) return add('級別編號重複：' + l.id);
      lvIds.add(l.id);
      if (!isStr(l.name) || !l.name.trim()) add(at + '沒有名稱');
      if (!optStr(l.desc)) add(at + '的說明格式不正確');
      if (!Array.isArray(l.chars)) return add(at + '的字列表格式不正確');
      const chars = [];
      l.chars.forEach((c, k) => {
        const cat = '「' + str(l.name) + '」第 ' + (k + 1) + ' 個字';
        if (!isObj(c) || !isStr(c.id) || !c.id) return add(cat + '沒有有效的編號');
        if (chIds.has(c.id)) return add('字的編號重複：' + c.id);
        chIds.add(c.id);
        if (!isStr(c.c) || [...c.c].length !== 1) return add(cat + '必須是一個字');
        if (![c.jp, c.w, c.wjp, c.m].every(optStr)) return add(cat + '的欄位格式不正確');
        chars.push({ id: c.id, c: c.c, jp: str(c.jp), w: str(c.w), wjp: str(c.wjp), m: str(c.m) });
      });
      levels.push({ id: l.id, name: str(l.name), desc: str(l.desc), chars,
        created: Number.isFinite(l.created) ? l.created : 0, modified: Number.isFinite(l.modified) ? l.modified : 0 });
    });
    d.records.forEach((r, i) => {
      const at = '第 ' + (i + 1) + ' 個紀錄';
      if (!isObj(r) || !isStr(r.id) || !r.id) return add(at + '沒有有效的編號');
      if (rcIds.has(r.id)) return add('紀錄編號重複：' + r.id);
      rcIds.add(r.id);
      if (!isStr(r.levelId) || !r.levelId) return add(at + '沒有級別編號');
      if (!KINDS.includes(r.kind) || !MODES.includes(r.mode)) return add(at + '的類型不正確');
      if (!Number.isFinite(r.date)) return add(at + '的日期不正確');
      if (!optStr(r.levelName) || !optStr(r.parentId)) return add(at + '的欄位格式不正確');
      if (!Array.isArray(r.items)) return add(at + '的題目列表格式不正確');
      const items = []; let ok = true;
      r.items.forEach((x, k) => {
        const it = at + '第 ' + (k + 1) + ' 題';
        if (!isObj(x) || !isStr(x.cid) || !x.cid || !isStr(x.c) || !x.c) { ok = false; return add(it + '資料有誤'); }
        if (typeof x.ok !== 'boolean') { ok = false; return add(it + '沒有評分結果'); }
        if (![x.jp, x.w, x.wjp].every(optStr)) { ok = false; return add(it + '的欄位格式不正確'); }
        if (x.img != null && x.img !== '' && (!isStr(x.img) || x.img.length > MAX_IMG || !IMG_RE.test(x.img))) { ok = false; return add(it + '的手寫圖片資料有誤'); }
        items.push({ cid: x.cid, c: x.c, jp: str(x.jp), w: str(x.w), wjp: str(x.wjp), ok: x.ok, img: x.img || null });
      });
      if (ok) records.push({ id: r.id, levelId: r.levelId, levelName: str(r.levelName), kind: r.kind, mode: r.mode,
        parentId: r.parentId || null, date: r.date, items });
    });
    if (errs.length) { if (errs.more) errs.push('還有更多錯誤未列出'); throw new ImportError(errs); }
    return { levels, records };
  }

  /* Move inline `img` data out of record items into separate image rows (stored in IndexedDB). */
  function splitImages(records) {
    const images = [];
    const out = records.map(r => ({ ...r, items: r.items.map((x, k) => {
      const { img, ...rest } = x;
      if (img) { const id = 'imp-' + r.id + '-' + k; images.push({ id, sid: r.id, data: img }); return { ...rest, imgId: id }; }
      return rest;
    }) }));
    return { records: out, images };
  }

  const sameChar = (a, b) => ['c', 'jp', 'w', 'wjp', 'm'].every(k => str(a[k]) === str(b[k]));
  const sameRecord = (a, b) => a.levelId === b.levelId && a.kind === b.kind && a.mode === b.mode && (a.parentId || null) === (b.parentId || null) &&
    a.date === b.date && a.items.length === b.items.length &&
    a.items.every((x, k) => { const y = b.items[k]; return x.cid === y.cid && x.c === y.c && x.ok === y.ok && !!(x.imgId || x.img) === !!(y.imgId || y.img); });

  /* Pure merge planner. Never overwrites existing data; every difference becomes a reported conflict. */
  function planMerge(existing, incoming, now) {
    const P = { newLevels: [], updatedLevels: [], newRecords: [], images: [], conflicts: [], warnings: [], identical: 0, added: { levels: 0, chars: 0, records: 0 } };
    const lvMap = new Map(existing.levels.map(l => [l.id, l]));
    const owner = new Map(); existing.levels.forEach(l => l.chars.forEach(c => owner.set(c.id, { lid: l.id, c })));
    incoming.levels.forEach(L => {
      const e = lvMap.get(L.id);
      if (!e) {
        const chars = [];
        L.chars.forEach(c => {
          const o = owner.get(c.id);
          if (o) P.conflicts.push('字「' + c.c + '」(' + c.id + ') 已經在另一個級別，沒有加入「' + L.name + '」');
          else { chars.push(c); owner.set(c.id, { lid: L.id, c }); }
        });
        P.newLevels.push({ ...L, chars }); P.added.levels++; P.added.chars += chars.length; return;
      }
      if (e.name !== L.name || str(e.desc) !== str(L.desc)) P.conflicts.push('級別 (' + L.id + ') 名稱或說明不同：現有「' + e.name + '」，備份「' + L.name + '」。已保留現有版本');
      const merged = clone(e); let added = 0;
      L.chars.forEach(c => {
        const o = owner.get(c.id);
        if (!o) { merged.chars.push(c); owner.set(c.id, { lid: L.id, c }); added++; }
        else if (o.lid !== L.id) P.conflicts.push('字「' + c.c + '」(' + c.id + ') 已經在另一個級別，沒有加入「' + L.name + '」');
        else if (sameChar(o.c, c)) P.identical++;
        else P.conflicts.push('字 (' + c.id + ') 內容不同：現有「' + o.c.c + '」，備份「' + c.c + '」。已保留現有版本');
      });
      if (added) { merged.modified = now; P.updatedLevels.push(merged); P.added.chars += added; }
    });
    const rcMap = new Map(existing.records.map(r => [r.id, r]));
    const levelIds = new Set([...existing.levels.map(l => l.id), ...incoming.levels.map(l => l.id)]);
    const recIds = new Set([...existing.records.map(r => r.id), ...incoming.records.map(r => r.id)]);
    const fresh = [];
    incoming.records.forEach(r => {
      const x = rcMap.get(r.id);
      if (!x) { fresh.push(r); return; }
      if (sameRecord(x, r)) P.identical++; else P.conflicts.push('紀錄 (' + r.id + ') 編號相同但內容不同，已保留現有紀錄');
    });
    const sp = splitImages(fresh);
    P.newRecords = sp.records; P.images = sp.images; P.added.records = sp.records.length;
    const noLevel = fresh.filter(r => !levelIds.has(r.levelId)).length, noParent = fresh.filter(r => r.parentId && !recIds.has(r.parentId)).length;
    if (noLevel) P.warnings.push(noLevel + ' 個紀錄所屬的級別不在資料中（紀錄仍會保留，以當時的級別名稱顯示）');
    if (noParent) P.warnings.push(noParent + ' 個溫習紀錄找不到原本的測驗紀錄（仍會保留）');
    return P;
  }

  function buildRecord(s, now) {
    return { id: s.id, levelId: s.levelId, levelName: s.levelName || '', kind: s.kind, mode: s.mode, parentId: s.parentId || null, date: now,
      items: s.items.map(({ cid, c, jp, w, wjp, ok, imgId }) => ({ cid, c, jp, w, wjp, ok, imgId: imgId || null })) };
  }

  /* ---------------- Quiz controller ----------------
     Rule: every mutation is computed on a copy, persisted, and only then applied to in-memory state. */
  class Quiz {
    constructor(store, o) {
      o = o || {};
      this.store = store; this.uid = o.uid || defaultUid; this.now = o.now || Date.now; this.shuffle = o.shuffle || shuf;
      this.levels = []; this.records = []; this.cur = null; this.busy = false; this.retry = null; this.result = null;
    }
    async init() { this._set(await this.store.loadAll()); }
    _set(d) {
      this.levels = sortLevels(d.levels); this.records = d.records.slice().sort((a, b) => (a.date || 0) - (b.date || 0)); this.cur = d.session || null;
    }
    level(id) { return this.levels.find(l => l.id === id); }

    async _act(fn) {
      if (this.busy) return { ok: false, busy: true };
      this.busy = true;
      try { await fn(); this.retry = null; return { ok: true }; }
      catch (e) { this.retry = fn; return { ok: false, error: e }; }
      finally { this.busy = false; }
    }
    async retryLast() {
      const f = this.retry; if (!f) return { ok: false };
      return this._act(f);
    }

    /* levels & characters */
    mutateLevels(fn) {
      return this._act(async () => { const next = clone(this.levels); fn(next); await this.store.saveLevels(next); this.levels = sortLevels(next); });
    }

    /* sessions */
    startSession({ kind, levelId, mode, chars, parentId, confirm }) {
      const L = this.level(levelId);
      let cs = chars || (L ? L.chars : []);
      if (!chars && mode === 'exam') { if (cs.length < 20) return Promise.resolve({ ok: false, error: new Error('Need at least 20 characters') }); cs = this.shuffle(cs).slice(0, 20); }
      if (!cs.length) return Promise.resolve({ ok: false, error: new Error('No characters') });
      if (this.cur && !(confirm && confirm('有未完成的測驗，要放棄並開始新的嗎？'))) return Promise.resolve({ ok: false, cancelled: true });
      const s = { id: this.uid(), levelId, levelName: L ? L.name : '', kind, mode, parentId: parentId || null, started: this.now(), i: 0, phase: 'ask',
        items: this.shuffle(cs).map(c => ({ cid: c.id, c: c.c, jp: c.jp || '', w: c.w || '', wjp: c.wjp || '', ok: null, imgId: null })) };
      return this._act(async () => { await this.store.startSession(s, this.cur ? this.cur.id : null); this.cur = s; this.result = null; });
    }
    answerRead(ok) {
      return this._act(async () => {
        const s = this.cur; if (!s || s.kind !== 'read' || s.items[s.i].ok !== null) throw new Error('No open reading question');
        const n = clone(s); n.items[n.i].ok = ok; n.i++;
        if (n.i >= n.items.length) return this._complete(n);
        await this.store.saveSession(n); this.cur = n;
      });
    }
    answerWrite(data) {
      const id = 'img-' + this.uid(); // generated once so that retries do not create duplicates
      return this._act(async () => {
        const s = this.cur; if (!s || s.kind !== 'write' || s.phase !== 'ask') throw new Error('No open writing question');
        const n = clone(s); n.items[n.i].imgId = id; n.i++;
        if (n.i >= n.items.length) { n.phase = 'mark'; n.i = 0; }
        await this.store.saveSession(n, { id, sid: s.id, data });
        this.cur = n;
      });
    }
    setOk(k, v) {
      return this._act(async () => {
        const s = this.cur; if (!s || s.phase !== 'mark' || !s.items[k]) throw new Error('Not in marking phase');
        const n = clone(s); n.items[k].ok = v; await this.store.saveSession(n); this.cur = n;
      });
    }
    finishMarking() {
      return this._act(async () => {
        const s = this.cur; if (!s || s.phase !== 'mark' || s.items.some(x => x.ok === null)) throw new Error('Not all questions are marked');
        await this._complete(s);
      });
    }
    async _complete(s) {
      const rec = buildRecord(s, this.now());
      await this.store.completeSession(rec);       // record written + session removed atomically
      this.records.push(rec); this.cur = null; this.result = rec;
    }
    discard(confirm) {
      if (!this.cur) return Promise.resolve({ ok: true });
      if (!(confirm && confirm('確定放棄這次未完成的測驗？已作答的內容會被刪除。'))) return Promise.resolve({ ok: false, cancelled: true });
      const sid = this.cur.id;
      return this._act(async () => { await this.store.discardSession(sid); this.cur = null; });
    }

    /* backup */
    async exportBackup() {
      const all = await this.store.exportAll(); const im = new Map(all.images.map(i => [i.id, i.data])); let missing = 0;
      const records = all.records.slice().sort((a, b) => (a.date || 0) - (b.date || 0)).map(r => ({ ...r, items: r.items.map(x => {
        const { imgId, ...rest } = x;
        if (imgId) { const data = im.get(imgId); if (data) return { ...rest, img: data }; missing++; }
        return rest;
      }) }));
      return { missingImages: missing, json: { format: 'cq-backup', version: 1, exported: new Date(this.now()).toISOString(), data: { levels: sortLevels(all.levels), records } } };
    }
    /* mode: 'merge' | 'replace'. Throws ImportError (validation) before touching any data. */
    async importBackup(json, mode, confirm) {
      const data = validateBackup(json);
      if (mode === 'replace') {
        const msg = '這會取代目前所有資料' + (this.cur ? '，包括未完成的測驗' : '') + '。建議先匯出目前的資料。確定要取代嗎？';
        if (!(confirm && confirm(msg))) return { cancelled: true };
        const sp = splitImages(data.records);
        const ids = new Set(data.levels.map(l => l.id)), rids = new Set(data.records.map(r => r.id));
        const warnings = [];
        const nl = data.records.filter(r => !ids.has(r.levelId)).length, np = data.records.filter(r => r.parentId && !rids.has(r.parentId)).length;
        if (nl) warnings.push(nl + ' 個紀錄所屬的級別不在備份中（紀錄仍會保留）');
        if (np) warnings.push(np + ' 個溫習紀錄找不到原本的測驗紀錄（仍會保留）');
        await this.store.replaceAll({ levels: data.levels, records: sp.records, images: sp.images });
        this._set(await this.store.loadAll());
        return { mode, added: { levels: data.levels.length, chars: data.levels.reduce((n, l) => n + l.chars.length, 0), records: data.records.length }, conflicts: [], warnings, identical: 0 };
      }
      const plan = planMerge({ levels: this.levels, records: this.records }, data, this.now());
      await this.store.applyMerge({ levels: [...plan.newLevels, ...plan.updatedLevels], records: plan.newRecords, images: plan.images });
      this._set(await this.store.loadAll());
      return { mode, added: plan.added, conflicts: plan.conflicts, warnings: plan.warnings, identical: plan.identical };
    }
  }

  return { Quiz, ImportError, validateBackup, planMerge, splitImages, buildRecord, shuf, clone };
});
