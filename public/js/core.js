/* DOM-free application logic: levels, sessions (persist-before-advance), backup validation and merge. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.CQCore = m;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const defaultUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clone = x => JSON.parse(JSON.stringify(x));
  function shuf(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  const ordOf = l => (Number.isFinite(l.ord) ? l.ord : Infinity);
  const sortLevels = ls => ls.slice().sort((a, b) => (ordOf(a) === ordOf(b) ? 0 : ordOf(a) < ordOf(b) ? -1 : 1) || (a.created || 0) - (b.created || 0) || (a.id < b.id ? -1 : 1));

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
        parentId: r.parentId || null, ...(Number.isFinite(r.started) ? { started: r.started } : {}), date: r.date, items });
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

  /* ---- deep comparison used for merge conflict detection ---- */
  const KIND_NAME = { read: '讀字', write: '寫字' }, MODE_NAME = { practice: '練習', revision: '溫習', exam: '考試' };
  const recLabel = r => (KIND_NAME[r.kind] || r.kind) + (MODE_NAME[r.mode] || r.mode) + '，' + new Date(r.date).toLocaleString('zh-HK');
  const show = v => '「' + str(v) + '」';
  const CHAR_FIELDS = [['c', '字'], ['jp', '粵拼'], ['w', '詞語'], ['wjp', '詞語粵拼'], ['m', '意思']];
  function charDiffs(a, b) { return CHAR_FIELDS.filter(([k]) => str(a[k]) !== str(b[k])).map(([k, n]) => n + '（現有' + show(a[k]) + '／備份' + show(b[k]) + '）'); }
  function levelDiffs(a, b) {
    const o = [];
    if (a.name !== b.name) o.push('名稱（現有' + show(a.name) + '／備份' + show(b.name) + '）');
    if (str(a.desc) !== str(b.desc)) o.push('說明（現有' + show(a.desc) + '／備份' + show(b.desc) + '）');
    if (a.created && b.created && a.created !== b.created) o.push('建立時間');
    return o;
  }
  /* Both sides normalised to the same shape, with handwriting as its full image content. */
  function normRecord(r, imgs) {
    return { levelId: r.levelId, levelName: str(r.levelName), kind: r.kind, mode: r.mode, parentId: r.parentId || null, date: r.date, started: Number.isFinite(r.started) ? r.started : null,
      items: r.items.map(x => ({ cid: x.cid, c: x.c, jp: str(x.jp), w: str(x.w), wjp: str(x.wjp), ok: x.ok,
        img: x.img || (x.imgId ? (imgs && imgs[x.imgId]) || ('<missing:' + x.imgId + '>') : null) })) };
  }
  function recordDiffs(a, b) {   // a = existing, b = incoming (both normalised)
    const o = [];
    [['levelId', '級別'], ['levelName', '級別名稱'], ['kind', '類型'], ['mode', '模式'], ['parentId', '溫習來源'], ['date', '日期']].forEach(([k, n]) => { if (a[k] !== b[k]) o.push(n + '不同'); });
    if (a.started != null && b.started != null && a.started !== b.started) o.push('開始時間不同');
    if (a.items.length !== b.items.length) o.push('題目數量不同（現有 ' + a.items.length + '／備份 ' + b.items.length + '）');
    for (let k = 0; k < Math.min(a.items.length, b.items.length); k++) {
      const x = a.items[k], y = b.items[k], n = '第 ' + (k + 1) + ' 題';
      if (x.cid !== y.cid || x.c !== y.c) o.push(n + '的字不同（現有' + show(x.c) + '／備份' + show(y.c) + '）');
      if (x.ok !== y.ok) o.push(n + '的評分不同');
      if (x.img !== y.img) o.push(n + '的手寫圖片不同');
      if (x.jp !== y.jp || x.w !== y.w || x.wjp !== y.wjp) o.push(n + '的詞語或粵拼不同');
    }
    return o;
  }

  /* Pure merge planner. Never overwrites existing data; every difference becomes a reported conflict.
     existingImages: { imgId: dataURL } for the existing records that share an ID with an incoming one. */
  function planMerge(existing, incoming, now, existingImages) {
    const P = { newLevels: [], updatedLevels: [], newRecords: [], images: [], conflicts: [], warnings: [], identical: 0, added: { levels: 0, chars: 0, records: 0 } };
    const lvMap = new Map(existing.levels.map(l => [l.id, l]));
    const owner = new Map(); existing.levels.forEach(l => l.chars.forEach(c => owner.set(c.id, { lid: l.id, c })));
    const elsewhere = (c, L) => '字 (' + c.id + ')「' + c.c + '」已經在另一個級別，沒有加入「' + L.name + '」';
    incoming.levels.forEach(L => {
      const e = lvMap.get(L.id);
      if (!e) {
        const chars = [];
        L.chars.forEach(c => { if (owner.has(c.id)) P.conflicts.push(elsewhere(c, L)); else { chars.push(c); owner.set(c.id, { lid: L.id, c }); } });
        P.newLevels.push({ ...L, chars }); P.added.levels++; P.added.chars += chars.length; return;
      }
      const ld = levelDiffs(e, L);
      if (ld.length) P.conflicts.push('級別 (' + L.id + ')「' + e.name + '」的' + ld.join('、') + '不同，已保留現有版本');
      const merged = clone(e); let added = 0;
      L.chars.forEach(c => {
        const o = owner.get(c.id);
        if (!o) { merged.chars.push(c); owner.set(c.id, { lid: L.id, c }); added++; }
        else if (o.lid !== L.id) P.conflicts.push(elsewhere(c, L));
        else { const cd = charDiffs(o.c, c); if (!cd.length) P.identical++; else P.conflicts.push('字 (' + c.id + ')「' + o.c.c + '」的' + cd.join('、') + '不同，已保留現有版本'); }
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
      const d = recordDiffs(normRecord(x, existingImages), normRecord(r, null));
      if (!d.length) P.identical++;
      else P.conflicts.push('紀錄 (' + r.id + ')（' + recLabel(x) + '）與備份不同：' + d.slice(0, 4).join('、') + (d.length > 4 ? '…' : '') + '。已保留現有紀錄');
    });
    const sp = splitImages(fresh);
    P.newRecords = sp.records; P.images = sp.images; P.added.records = sp.records.length;
    const noLevel = fresh.filter(r => !levelIds.has(r.levelId)).length, noParent = fresh.filter(r => r.parentId && !recIds.has(r.parentId)).length;
    if (noLevel) P.warnings.push(noLevel + ' 個紀錄所屬的級別不在資料中（紀錄仍會保留，以當時的級別名稱顯示）');
    if (noParent) P.warnings.push(noParent + ' 個溫習紀錄找不到原本的測驗紀錄（仍會保留）');
    return P;
  }

  /* Elapsed wall-clock time between the stored start and completion timestamps, in Traditional Chinese.
     Returns null (= unavailable) for missing/invalid timestamps or a completion earlier than the start: never invented, never negative. */
  function formatDuration(started, completed) {
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return null;
    const t = Math.floor((completed - started) / 1000), m = Math.floor(t / 60), sec = t % 60;
    return m ? m + ' 分 ' + sec + ' 秒' : sec + ' 秒';
  }
  const durationOf = r => formatDuration(r && r.started, r && r.date);

  /* ---- writing correction: write each wrongly written character five times ---- */
  const ATTEMPTS = 5, CORRECTION_MODES = ['practice', 'revision', 'exam'];
  const attemptsDone = it => it.attempts.length === ATTEMPTS && it.attempts.every(Boolean) && new Set(it.attempts).size === ATTEMPTS;   // five distinct saved images
  function buildCorrection(rec, now) {
    if (rec.kind !== 'write' || !CORRECTION_MODES.includes(rec.mode)) return null;
    const bad = rec.items.filter(x => x.ok === false);                     // final parent markings
    if (!bad.length) return null;
    return { id: 'corr-' + rec.id, sourceId: rec.id, sourceKind: rec.kind, sourceMode: rec.mode, levelId: rec.levelId, levelName: rec.levelName || '',
      createdAt: now, completedAt: null, state: 'open',
      items: bad.map(x => ({ cid: x.cid, c: x.c, jp: x.jp || '', w: x.w || '', wjp: x.wjp || '', attempts: Array(ATTEMPTS).fill(null) })) };
  }

  function buildRecord(s, now) {
    return { id: s.id, levelId: s.levelId, levelName: s.levelName || '', kind: s.kind, mode: s.mode, parentId: s.parentId || null,
      ...(Number.isFinite(s.started) ? { started: s.started } : {}), date: now,   // started = real session start, date = completion time
      items: s.items.map(({ cid, c, jp, w, wjp, ok, imgId }) => ({ cid, c, jp, w, wjp, ok, imgId: imgId || null })) };
  }

  /* ---------------- Quiz controller ----------------
     Rule: every mutation is computed on a copy, persisted, and only then applied to in-memory state. */
  class Quiz {
    constructor(store, o) {
      o = o || {};
      this.store = store; this.uid = o.uid || defaultUid; this.now = o.now || Date.now; this.shuffle = o.shuffle || shuf;
      this.levels = []; this.records = []; this.cur = null; this.busy = false; this.retry = null; this.result = null;
      this.draftDelay = o.draftDelay == null ? 400 : o.draftDelay;
      this.onDraftError = null; this.onDraftOk = null; this.draftError = null;
      this._pend = null; this._timer = null; this._flushing = null; this._flushRunning = false; this.closed = false; this._lastAct = Promise.resolve(); this._cq = Promise.resolve(); this.corrections = []; this._seq = Date.now() * 1000;
    }
    async init() { this._set(await this.store.loadAll()); }
    _set(d) {
      this.levels = sortLevels(d.levels); this.records = d.records.slice().sort((a, b) => (a.date || 0) - (b.date || 0)); this.cur = d.session || null; this.corrections = (d.corrections || []).slice().sort((a, b) => a.createdAt - b.createdAt);
    }
    level(id) { return this.levels.find(l => l.id === id); }

    _act(fn) {
      if (this.closed) return Promise.resolve({ ok: false, error: new Error('This learner session is closed') });
      if (this.busy) return Promise.resolve({ ok: false, busy: true });
      this.busy = true;
      const p = (async () => {
        try { await fn(); this.retry = null; return { ok: true }; }
        catch (e) { this.retry = fn; return { ok: false, error: e }; }
        finally { this.busy = false; }
      })();
      this._lastAct = p.then(() => { }, () => { });
      return p;
    }
    /* Called when switching learner: save the pending drawing, wait for any save in flight, then refuse all further actions.
       Returns { ok:false, error } if the pending drawing could not be saved (the caller decides whether to continue). */
    async close() {
      let error = null;
      try { await this.flushDraft(); } catch (e) { error = e; }
      await this._lastAct; await this._cq;
      this._dropDraft(); this.closed = true;
      return error ? { ok: false, error } : { ok: true };
    }
    async retryLast() {
      const f = this.retry; if (!f) return { ok: false };
      return this._act(f);
    }

    /* ---- handwriting autosave (draft of the question being written) ----
       scheduleDraft(get): `get()` returns the current canvas as a data URL (or null if blank). It is evaluated when the write
       happens, so the latest strokes win. Writes are serialised (never overlapping), coalesced (only the newest pending
       drawing is written) and carry an increasing seq so an old write can never replace a newer one in IndexedDB. */
    scheduleDraft(get, o) {
      if (this.closed) return;
      const s = this.cur; if (!s || s.kind !== 'write' || s.phase !== 'ask') return;
      this._pend = { sid: s.id, qi: s.i, cid: s.items[s.i].cid, get };
      clearTimeout(this._timer); this._timer = null;
      if (o && o.immediate) this.flushDraft().catch(() => { });
      else this._timer = setTimeout(() => { this._timer = null; this.flushDraft().catch(() => { }); }, this.draftDelay);
    }
    flushDraft() {
      clearTimeout(this._timer); this._timer = null;
      if (this._flushing && this._flushRunning) return this._flushing;
      this._flushRunning = true;
      this._flushing = (async () => {
        try {
          while (this._pend) {
            const p = this._pend; this._pend = null;
            const s = this.cur;
            if (!s || s.id !== p.sid || s.i !== p.qi || s.phase !== 'ask') continue;      // question already left: stale
            const data = p.data !== undefined ? p.data : p.get();
            const d = { sid: p.sid, qi: p.qi, cid: p.cid, seq: ++this._seq, data: data || null };
            try { await this.store.saveDraft(d); }
            catch (e) { if (!this._pend) this._pend = { ...p, data: d.data }; throw e; }   // keep the drawing for a retry
          }
          if (this.draftError) { this.draftError = null; if (this.onDraftOk) this.onDraftOk(); }
        } catch (e) { this.draftError = e; if (this.onDraftError) this.onDraftError(e); throw e; }
        finally { this._flushRunning = false; }   // cleared synchronously when the loop ends, so a new pending write always starts a new loop
      })();
      return this._flushing;
    }
    _dropDraft() { this._pend = null; clearTimeout(this._timer); this._timer = null; }
    /* The saved draft for the current question only (null if none / for another question or session). */
    async loadDraft() {
      const s = this.cur; if (!s || s.kind !== 'write' || s.phase !== 'ask') return null;
      const d = await this.store.getDraft();
      return d && d.sid === s.id && d.qi === s.i && d.cid === s.items[s.i].cid ? d : null;
    }

    /* levels & characters */
    mutateLevels(fn) {
      return this._act(async () => { const next = clone(this.levels); fn(next); next.forEach((l, i) => { l.ord = i; }); await this.store.saveLevels(next); this.levels = sortLevels(next); });
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
      return this._act(async () => { await this.store.startSession(s, this.cur ? this.cur.id : null); this._dropDraft(); this.cur = s; this.result = null; });
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
        await this.flushDraft();                 // pending handwriting autosave must succeed first
        const n = clone(s); n.items[n.i].imgId = id; n.i++;
        if (n.i >= n.items.length) { n.phase = 'mark'; n.i = 0; }
        await this.store.saveSession(n, { id, sid: s.id, data });   // also deletes the draft in the same transaction
        this._dropDraft(); this.cur = n;
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
      const rec = buildRecord(s, this.now()), corr = buildCorrection(rec, this.now());
      await this.store.completeSession(rec, corr);   // record + (optional) correction written and session removed atomically
      this.records.push(rec); if (corr) this.corrections.push(corr); this._dropDraft(); this.cur = null; this.result = rec;
    }
    discard(confirm) {
      if (!this.cur) return Promise.resolve({ ok: true });
      if (!(confirm && confirm('確定放棄這次未完成的測驗？已作答的內容會被刪除。'))) return Promise.resolve({ ok: false, cancelled: true });
      const sid = this.cur.id;
      return this._act(async () => { await this.store.discardSession(sid); this._dropDraft(); this.cur = null; });
    }

    /* writing-correction activities (separate from the records they came from; never change any score) */
    correction(id) { return this.corrections.find(c => c.id === id) || null; }
    correctionFor(recordId) { return this.correction('corr-' + recordId); }
    openCorrections() { return this.corrections.filter(c => c.state === 'open'); }
    /* Attempts for different canvases arrive close together, so these run strictly one after another (read-modify-write never interleaves). */
    _serial(fn) {
      const run = this._cq.then(async () => {
        if (this.closed) return { ok: false, error: new Error('This learner session is closed') };
        try { await fn(); return { ok: true }; } catch (e) { return { ok: false, error: e }; }
      });
      this._cq = run.then(() => { }, () => { }); return run;
    }
    /* data = image of one attempt, or null to clear it. Saved (image + activity, one transaction) before the in-memory state changes. */
    saveAttempt(corrId, ci, ai, data) {
      const imgId = data ? 'cimg-' + this.uid() : null;
      return this._serial(async () => {
        const c = this.correction(corrId); if (!c || c.state !== 'open') throw new Error('Correction activity is not open');
        if (!c.items[ci] || !Number.isInteger(ai) || ai < 0 || ai >= ATTEMPTS) throw new Error('No such attempt');
        if (data != null && !(typeof data === 'string' && /^data:image\//.test(data))) throw new Error('Invalid handwriting image');
        const n = clone(c), old = n.items[ci].attempts[ai]; n.items[ci].attempts[ai] = imgId;
        await this.store.saveCorrection(n, data ? { id: imgId, sid: c.id, data } : null, old);
        this.corrections = this.corrections.map(x => (x.id === corrId ? n : x));
      });
    }
    completeCorrection(corrId) {
      return this._serial(async () => {
        const c = this.correction(corrId); if (!c || c.state !== 'open') throw new Error('Correction activity is not open');
        if (!c.items.every(attemptsDone)) throw new Error('Not every character has five saved attempts');
        const n = clone(c); n.state = 'done'; n.completedAt = this.now();
        await this.store.saveCorrection(n, null, null);
        this.corrections = this.corrections.map(x => (x.id === corrId ? n : x));
      });
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
    async importBackup(json, mode, confirm, opts) {
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
      const incoming = new Set(data.records.map(r => r.id)), imgIds = [];
      this.records.filter(r => incoming.has(r.id)).forEach(r => r.items.forEach(x => { if (x.imgId) imgIds.push(x.imgId); }));
      const imgs = imgIds.length ? await this.store.getImages(imgIds) : {};
      const plan = planMerge({ levels: this.levels, records: this.records }, data, this.now(), imgs);
      // Any conflict stops the merge: nothing is applied, so the data is never left half-merged.
      if (plan.conflicts.length && !(opts && opts.allowPartial)) return { mode, aborted: true, added: { levels: 0, chars: 0, records: 0 }, conflicts: plan.conflicts, warnings: plan.warnings, identical: plan.identical };
      await this.store.applyMerge({ newLevels: plan.newLevels, updatedLevels: plan.updatedLevels, records: plan.newRecords, images: plan.images });
      this._set(await this.store.loadAll());
      return { mode, added: plan.added, conflicts: plan.conflicts, warnings: plan.warnings, identical: plan.identical };
    }
  }

  return { Quiz, ImportError, validateBackup, planMerge, splitImages, buildRecord, buildCorrection, attemptsDone, formatDuration, durationOf, ATTEMPTS, shuf, clone };
});
