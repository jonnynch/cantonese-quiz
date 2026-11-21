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
  const ATTEMPTS = 5, CORRECTION_MODES = ['practice', 'revision', 'exam'];
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
    const lvIds = new Set(), chIds = new Set(), rcIds = new Set(), sIds = new Set(), cIds = new Set();
    const levels = [], records = [];
    d.levels.forEach((l, i) => {
      const at = '第 ' + (i + 1) + ' 個級別';
      if (!isObj(l) || !isStr(l.id) || !l.id) return add(at + '沒有有效的編號');
      if (lvIds.has(l.id)) return add('級別編號重複：' + l.id);
      lvIds.add(l.id);
      if (!isStr(l.name) || !l.name.trim()) add(at + '沒有名稱');
      if (!optStr(l.desc)) add(at + '的說明格式不正確');
      if (l.hidden != null && typeof l.hidden !== 'boolean') add(at + '的隱藏標記格式不正確');
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
      levels.push({ id: l.id, name: str(l.name), desc: str(l.desc), ...(l.hidden === true ? { hidden: true } : {}), chars,
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
      if ((r.endedEarly != null && typeof r.endedEarly !== 'boolean') || (r.planned != null && !Number.isInteger(r.planned))) return add(at + '的提早結束資料不正確');
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
        parentId: r.parentId || null, ...(Number.isFinite(r.started) ? { started: r.started } : {}), date: r.date,
        ...(r.endedEarly === true ? { endedEarly: true, planned: Number.isInteger(r.planned) && r.planned >= items.length ? r.planned : items.length } : {}), items });
    });
    /* Optional (added after the first backups were made; an older backup simply has none of them): unfinished sessions,
       their handwriting drafts and writing-correction activities. Same version number: no separate format. */
    const sessions = [], drafts = [], corrections = [];
    const provided = { sessions: d.sessions !== undefined, drafts: d.drafts !== undefined, corrections: d.corrections !== undefined };
    const okImg = v => v == null || v === '' || (isStr(v) && v.length <= MAX_IMG && IMG_RE.test(v));
    if (provided.sessions && !Array.isArray(d.sessions)) add('未完成測驗的列表格式不正確');
    else (d.sessions || []).forEach((x, i) => {
      const at = '第 ' + (i + 1) + ' 個未完成的測驗';
      if (!isObj(x) || !isStr(x.id) || !x.id) return add(at + '沒有有效的編號');
      if (sIds.has(x.id) || rcIds.has(x.id)) return add('未完成的測驗編號重複：' + x.id);
      sIds.add(x.id);
      if (!isStr(x.levelId) || !x.levelId) return add(at + '沒有級別編號');
      if (!KINDS.includes(x.kind) || !MODES.includes(x.mode)) return add(at + '的類型不正確');
      if (!optStr(x.levelName) || !optStr(x.parentId)) return add(at + '的欄位格式不正確');
      if (x.started != null && !Number.isFinite(x.started)) return add(at + '的開始時間不正確');
      if (x.updatedAt != null && !Number.isFinite(x.updatedAt)) return add(at + '的更新時間不正確');
      if (!['ask', 'mark'].includes(x.phase) || (x.kind === 'read' && x.phase !== 'ask')) return add(at + '的進度狀態不正確');
      if (!Array.isArray(x.items) || !x.items.length) return add(at + '的題目列表格式不正確');
      if (!Number.isInteger(x.i) || x.i < 0 || x.i >= x.items.length) return add(at + '的目前題號不正確');
      if ((x.endedEarly != null && typeof x.endedEarly !== 'boolean') || (x.planned != null && !Number.isInteger(x.planned))) return add(at + '的提早結束資料不正確');
      const items = []; let ok = true;
      x.items.forEach((it, k) => {
        const lab = at + '第 ' + (k + 1) + ' 題';
        if (!isObj(it) || !isStr(it.cid) || !it.cid || !isStr(it.c) || !it.c) { ok = false; return add(lab + '資料有誤'); }
        if (it.ok !== null && typeof it.ok !== 'boolean') { ok = false; return add(lab + '的評分結果不正確'); }
        if (![it.jp, it.w, it.wjp].every(optStr)) { ok = false; return add(lab + '的欄位格式不正確'); }
        if (!okImg(it.img)) { ok = false; return add(lab + '的手寫圖片資料有誤'); }
        if (x.kind === 'read' && (it.ok !== null) !== (k < x.i)) { ok = false; return add(lab + '的作答與進度不一致'); }
        items.push({ cid: it.cid, c: it.c, jp: str(it.jp), w: str(it.w), wjp: str(it.wjp), ok: it.ok, img: it.img || null, ...(Number.isFinite(it.ms) && it.ms >= 0 ? { ms: it.ms } : {}) });
      });
      if (ok) sessions.push({ id: x.id, levelId: x.levelId, levelName: str(x.levelName), kind: x.kind, mode: x.mode, parentId: x.parentId || null,
        ...(Number.isFinite(x.started) ? { started: x.started } : {}), ...(Number.isFinite(x.updatedAt) ? { updatedAt: x.updatedAt } : {}),
        ...(x.endedEarly === true ? { endedEarly: true, planned: Number.isInteger(x.planned) && x.planned >= x.items.length ? x.planned : x.items.length } : {}), i: x.i, phase: x.phase, items });
    });
    if (provided.drafts && !Array.isArray(d.drafts)) add('手寫草稿的列表格式不正確');
    else (d.drafts || []).forEach((x, i) => {
      const at = '第 ' + (i + 1) + ' 個手寫草稿', s0 = isObj(x) && sessions.find(y => y.id === x.sid);
      if (!isObj(x) || !isStr(x.sid)) return add(at + '沒有所屬的測驗編號');
      if (!s0) { if (sIds.has(x.sid)) return; return add(at + '找不到所屬的未完成測驗'); }   // its session was already reported as invalid
      if (s0.kind !== 'write' || s0.phase !== 'ask' || x.qi !== s0.i || x.cid !== s0.items[s0.i].cid) return add(at + '與測驗目前的題目不符');
      if (!Number.isFinite(x.seq)) return add(at + '的序號不正確');
      if (x.data != null && (!isStr(x.data) || !okImg(x.data))) return add(at + '的圖片資料有誤');
      if (drafts.some(y => y.sid === x.sid)) return add(at + '重複');
      drafts.push({ sid: x.sid, qi: x.qi, cid: x.cid, seq: x.seq, data: x.data || null });
    });
    if (provided.corrections && !Array.isArray(d.corrections)) add('寫五次練習的列表格式不正確');
    else (d.corrections || []).forEach((x, i) => {
      const at = '第 ' + (i + 1) + ' 個寫五次練習';
      if (!isObj(x) || !isStr(x.id) || !x.id) return add(at + '沒有有效的編號');
      if (cIds.has(x.id)) return add('寫五次練習編號重複：' + x.id);
      cIds.add(x.id);
      if (!isStr(x.sourceId) || !x.sourceId || !isStr(x.levelId) || !x.levelId || x.sourceKind !== 'write' || !CORRECTION_MODES.includes(x.sourceMode)) return add(at + '的來源資料不正確');
      if (!optStr(x.levelName) || !Number.isFinite(x.createdAt) || !['open', 'done'].includes(x.state)) return add(at + '的欄位格式不正確');
      if (x.updatedAt != null && !Number.isFinite(x.updatedAt)) return add(at + '的更新時間不正確');
      if (x.state === 'done' ? !Number.isFinite(x.completedAt) : x.completedAt != null) return add(at + '的完成時間不正確');
      if (!Array.isArray(x.items) || !x.items.length) return add(at + '的字列表格式不正確');
      const items = []; let ok = true;
      x.items.forEach((it, k) => {
        const lab = at + '第 ' + (k + 1) + ' 個字';
        if (!isObj(it) || !isStr(it.cid) || !it.cid || !isStr(it.c) || !it.c || ![it.jp, it.w, it.wjp].every(optStr)) { ok = false; return add(lab + '資料有誤'); }
        if (!Array.isArray(it.attempts) || it.attempts.length !== ATTEMPTS || !it.attempts.every(a => a == null || (a !== '' && okImg(a)))) { ok = false; return add(lab + '的手寫次數資料有誤'); }
        if (x.state === 'done' && !it.attempts.every(Boolean)) { ok = false; return add(lab + '標示為已完成，但沒有五次手寫圖片'); }
        if (!okImg(it.pending) || (it.checking != null && typeof it.checking !== 'boolean') || (it.confirmed != null && typeof it.confirmed !== 'boolean')
          || (it.failed != null && !Number.isInteger(it.failed)) || (it.marks != null && !(Array.isArray(it.marks) && it.marks.length === ATTEMPTS && it.marks.every(m => m === null || typeof m === 'boolean')))) { ok = false; return add(lab + '的目前手寫資料有誤'); }
        const raw = { cid: it.cid, c: it.c, jp: str(it.jp), w: str(it.w), wjp: str(it.wjp), attempts: it.attempts.map(a => a || null), pending: x.state === 'done' ? null : (it.pending || null),
          ...(it.marks != null ? { marks: it.marks } : {}), ...(it.confirmed != null ? { confirmed: it.confirmed } : {}), ...(it.failed != null ? { failed: it.failed } : {}), ...(it.checking ? { checking: true } : {}) };
        items.push(x.state === 'done' ? { ...upgradeItem({ ...raw, marks: Array(ATTEMPTS).fill(true), confirmed: true }) } : upgradeItem(raw));
      });
      if (ok) corrections.push({ id: x.id, sourceId: x.sourceId, sourceKind: 'write', sourceMode: x.sourceMode, levelId: x.levelId, levelName: str(x.levelName), createdAt: x.createdAt,
        ...(Number.isFinite(x.updatedAt) ? { updatedAt: x.updatedAt } : {}), completedAt: x.state === 'done' ? x.completedAt : null, state: x.state, items });
    });
    if (errs.length) { if (errs.more) errs.push('還有更多錯誤未列出'); throw new ImportError(errs); }
    /* Optional adaptive statistics: derived data, so malformed entries are repaired or skipped (with a warning) rather than rejecting the file. */
    const stats = [], statWarn = [];
    if (d.stats !== undefined && !Array.isArray(d.stats)) statWarn.push('學習統計的格式不正確，已略過');
    else (d.stats || []).forEach(x => { const r = normStatsRow(x); if (!r || stats.some(y => y.cid === r.cid)) statWarn.push('略過一筆無效的學習統計'); else stats.push(r); });
    provided.stats = d.stats !== undefined && Array.isArray(d.stats);
    /* Optional mastery statuses: a manual label, so malformed entries are skipped with a warning (never a rejected file) */
    const mastery = [], mWarn = [];
    if (d.mastery !== undefined && !Array.isArray(d.mastery)) mWarn.push('級別掌握狀態的格式不正確，已略過');
    else (d.mastery || []).forEach(x => { const r = normMasteryRow(x); if (!r || mastery.some(y => y.levelId === r.levelId)) mWarn.push('略過一筆無效的級別掌握狀態'); else mastery.push(r); });
    provided.mastery = d.mastery !== undefined && Array.isArray(d.mastery);
    return { levels, records, sessions, drafts, corrections, stats, mastery, statWarnings: [...(statWarn.length ? [statWarn.length + ' 筆學習統計無效，已略過'] : []), ...(mWarn.length ? [mWarn.length + ' 筆級別掌握狀態無效，已略過'] : [])], provided };
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

  /* Same idea for unfinished sessions (item images) and writing-correction activities (attempt images). Drafts keep their data inline. */
  function splitSessionImages(sessions) {
    const images = [];
    const out = sessions.map(x => ({ ...x, items: x.items.map((it, k) => {
      const { img, ...rest } = it;
      if (img) { const id = 'imp-' + x.id + '-' + k; images.push({ id, sid: x.id, data: img }); return { ...rest, imgId: id }; }
      return { ...rest, imgId: null };
    }) }));
    return { sessions: out, images };
  }
  function splitCorrectionImages(corrections) {
    const images = [];
    const out = corrections.map(c => ({ ...c, items: c.items.map((it, ci) => ({ ...it, attempts: it.attempts.map((a, ai) => {
      if (!a) return null;
      const id = 'imp-' + c.id + '-' + ci + '-' + ai; images.push({ id, sid: c.id, data: a }); return id;
    }), pending: it.pending ? (() => { const id = 'imp-' + c.id + '-' + ci + '-p'; images.push({ id, sid: c.id, data: it.pending }); return id; })() : null })) }));
    return { corrections: out, images };
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

  function normSession(x, imgs) {
    return { levelId: x.levelId, levelName: str(x.levelName), kind: x.kind, mode: x.mode, parentId: x.parentId || null, started: Number.isFinite(x.started) ? x.started : null, i: x.i, phase: x.phase,
      items: x.items.map(it => ({ cid: it.cid, c: it.c, jp: str(it.jp), w: str(it.w), wjp: str(it.wjp), ok: it.ok === undefined ? null : it.ok,
        img: it.img || (it.imgId ? (imgs && imgs[it.imgId]) || ('<missing:' + it.imgId + '>') : null) })) };
  }
  function sessionDiffs(a, b) {
    const o = [];
    [['levelId', '級別'], ['kind', '類型'], ['mode', '模式'], ['parentId', '溫習來源'], ['started', '開始時間'], ['i', '目前題號'], ['phase', '進度狀態']].forEach(([k, n]) => { if (a[k] !== b[k]) o.push(n + '不同'); });
    if (a.items.length !== b.items.length) o.push('題目數量不同');
    for (let k = 0; k < Math.min(a.items.length, b.items.length); k++) {
      const x = a.items[k], y = b.items[k], n = '第 ' + (k + 1) + ' 題';
      if (x.cid !== y.cid || x.c !== y.c) o.push(n + '的字不同'); if (x.ok !== y.ok) o.push(n + '的作答不同'); if (x.img !== y.img) o.push(n + '的手寫圖片不同');
    }
    return o;
  }
  function normCorrection(x, imgs) {
    const im = id => (id ? (imgs && imgs[id]) || (/^data:/.test(id) ? id : '<missing:' + id + '>') : null);
    return { sourceId: x.sourceId, levelId: x.levelId, state: x.state, completedAt: x.completedAt || null,
      items: x.items.map(it => ({ cid: it.cid, c: it.c, attempts: it.attempts.map(im), pending: im(it.pending || null), marks: (it.marks || []).join(','), confirmed: !!it.confirmed, failed: it.failed | 0 })) };
  }
  function correctionDiffs(a, b) {
    const o = [];
    [['sourceId', '來源測驗'], ['levelId', '級別'], ['state', '完成狀態'], ['completedAt', '完成時間']].forEach(([k, n]) => { if (a[k] !== b[k]) o.push(n + '不同'); });
    if (a.items.length !== b.items.length) o.push('字數不同');
    for (let k = 0; k < Math.min(a.items.length, b.items.length); k++) {
      const x = a.items[k], y = b.items[k];
      if (x.cid !== y.cid) o.push('第 ' + (k + 1) + ' 個字不同'); else if (x.attempts.some((t, j) => t !== y.attempts[j]) || x.pending !== y.pending || x.marks !== y.marks || x.confirmed !== y.confirmed || x.failed !== y.failed) o.push('第 ' + (k + 1) + ' 個字的手寫次數不同');
    }
    return o;
  }

  /* Pure merge planner. Never overwrites existing data; every difference becomes a reported conflict.
     existingImages: { imgId: dataURL } for the existing records that share an ID with an incoming one. */
  function planMerge(existing, incoming, now, existingImages) {
    const P = { newLevels: [], updatedLevels: [], newRecords: [], newSessions: [], newDrafts: [], newCorrections: [], images: [], conflicts: [], warnings: [], identical: 0, added: { levels: 0, chars: 0, records: 0, sessions: 0, corrections: 0 } };
    existing = { ...existing, sessions: existing.sessions || [], corrections: existing.corrections || [], stats: existing.stats || [], mastery: existing.mastery || [] };
    P.newStats = []; P.newMastery = [];
    incoming = { ...incoming, sessions: incoming.sessions || [], drafts: incoming.drafts || [], corrections: incoming.corrections || [] };
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
    const fresh = [], sMap = new Map(existing.sessions.map(x => [x.id, x]));
    incoming.records.forEach(r => {
      const x = rcMap.get(r.id);
      if (!x && sMap.has(r.id)) { P.conflicts.push('測驗 (' + r.id + ')在備份中已經完成，但這裡仍然是未完成的版本，已保留現有的未完成測驗，沒有加入備份的紀錄'); return; }
      if (!x) { fresh.push(r); return; }
      const d = recordDiffs(normRecord(x, existingImages), normRecord(r, null));
      if (!d.length) P.identical++;
      else P.conflicts.push('紀錄 (' + r.id + ')（' + recLabel(x) + '）與備份不同：' + d.slice(0, 4).join('、') + (d.length > 4 ? '…' : '') + '。已保留現有紀錄');
    });
    const sp = splitImages(fresh);
    P.newRecords = sp.records; P.images = sp.images.slice(); P.added.records = sp.records.length;
    /* unfinished sessions: added only if absent; a session that is already a completed record here never comes back as unfinished */
    const keyOf = x => [x.kind, x.levelId, x.mode, x.parentId || ''].join('|'), taken = new Set(existing.sessions.map(keyOf)); let same = 0, done = 0; const freshS = [];
    incoming.sessions.forEach(x => {
      const e = sMap.get(x.id);
      if (rcMap.has(x.id)) { done++; return; }
      if (!e) { freshS.push(x); if (taken.has(keyOf(x))) same++; return; }
      const d = sessionDiffs(normSession(e, existingImages), normSession(x, null));
      if (!d.length) { P.identical++; freshS.push(null); } else P.conflicts.push('未完成的測驗 (' + x.id + ')（' + (KIND_NAME[e.kind] || e.kind) + (MODE_NAME[e.mode] || e.mode) + '，' + str(e.levelName) + '）與備份不同：' + d.slice(0, 4).join('、') + (d.length > 4 ? '…' : '') + '。已保留現有版本');
      // a handwriting draft is added only if this device has none for that session (putIfAbsent in the store)
    });
    const sp2 = splitSessionImages(freshS.filter(Boolean)), addIds = new Set(sp2.sessions.map(x => x.id));
    P.newSessions = sp2.sessions; P.images.push(...sp2.images); P.added.sessions = sp2.sessions.length;
    const sameIdsIdentical = new Set(incoming.sessions.filter(x => sMap.has(x.id) && !rcMap.has(x.id)).map(x => x.id));
    P.newDrafts = incoming.drafts.filter(x => addIds.has(x.sid) || sameIdsIdentical.has(x.sid));
    if (done) P.warnings.push(done + ' 個備份中的未完成測驗在這裡已經完成，沒有加入未完成的列表');
    if (same) P.warnings.push(same + ' 個未完成的測驗與現有未完成的測驗屬於同一級別和類型，兩者都已保留');
    const cMap = new Map(existing.corrections.map(x => [x.id, x]));
    const cs2 = [];
    incoming.corrections.forEach(x => {
      const e = cMap.get(x.id);
      if (!e) { cs2.push(x); return; }
      const d = correctionDiffs(normCorrection(e, existingImages), normCorrection(x, null));
      if (!d.length) P.identical++; else P.conflicts.push('寫五次練習 (' + x.id + ')（' + str(e.levelName) + '）與備份不同：' + d.slice(0, 4).join('、') + (d.length > 4 ? '…' : '') + '。已保留現有版本');
    });
    const sc = splitCorrectionImages(cs2); P.newCorrections = sc.corrections; P.images.push(...sc.images); P.added.corrections = sc.corrections.length;
    { const have = new Set(existing.stats.map(x => x.cid)); P.newStats = (incoming.stats || []).filter(x => !have.has(x.cid)); }   // statistics of this device always win (never overwritten)
    { const have = new Set(existing.mastery.map(x => x.levelId)); P.newMastery = (incoming.mastery || []).filter(x => !have.has(x.levelId)); }   // this learner's own setting always wins
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
  const fiveDistinct = it => Array.isArray(it.attempts) && it.attempts.length === ATTEMPTS && it.attempts.every(Boolean) && new Set(it.attempts).size === ATTEMPTS;   // five distinct saved images
  /* One character of a correction activity has a current SET of five attempts: 'write' (fewer than five submitted: no marking yet), 'mark' (all five
     submitted: each is marked individually), 'done' (the set was finished with all five marked correct). Any incorrect mark makes the finished set
     void: a completely new set is written. Items from before marking existed (no `marks` at all) with five saved attempts count as done. */
  const attemptsDone = it => fiveDistinct(it) && (it.confirmed === true || it.marks === undefined);
  const itemPhase = it => (attemptsDone(it) ? 'done' : fiveDistinct(it) ? 'mark' : 'write');
  /* Bring an item (from the database or a backup of an older version) to the current shape: attempts / marks (5 each) / pending / confirmed / failed.
     An older "streak" item (attempts = confirmed correct attempts so far, `checking` = submitted but unmarked) keeps every image: the streak becomes
     already-correct marks of the new set, and a submitted-unmarked drawing becomes the next submitted attempt. */
  function upgradeItem(it) {
    const out = { ...it }; delete out.checking;
    let att = (it.attempts || []).slice(0, ATTEMPTS); while (att.length < ATTEMPTS) att.push(null);
    let marks = Array.isArray(it.marks) ? it.marks.slice(0, ATTEMPTS).map(m => (m === true || m === false ? m : null)) : null, pending = it.pending || null;
    if (!marks) {
      if (att.every(Boolean)) { out.attempts = att; out.marks = Array(ATTEMPTS).fill(true); out.confirmed = true; out.pending = null; out.failed = nz(it.failed); return out; }   // older finished character
      marks = att.map(a => (a ? true : null));
      if (it.checking && pending) { const k = att.findIndex(a => !a); if (k >= 0) { att[k] = pending; marks[k] = null; pending = null; } }
    }
    while (marks.length < ATTEMPTS) marks.push(null);
    out.attempts = att; out.marks = marks.map((m, i) => (att[i] ? m : null)); out.pending = pending;
    out.confirmed = it.confirmed === true && fiveDistinct(out) && out.marks.every(m => m === true); out.failed = nz(it.failed);
    if (out.confirmed === false && itemPhase(out) === 'write' && out.pending && att.every(Boolean)) out.pending = null;
    return out;
  }
  const upgradeCorrection = c => (c && Array.isArray(c.items) ? { ...c, items: c.items.map(upgradeItem) } : c);
  /* The exact point to resume a correction activity at: the first character whose set is not finished, its phase, and where in that phase
     (write: the next empty attempt slot `ai`, 0-based; mark: the first unmarked attempt, or 5 when all five are marked). `saved` = attempts done so far. */
  function correctionPosition(c) {
    const total = c.items.length * ATTEMPTS, saved = c.items.reduce((t, x) => t + (attemptsDone(x) ? ATTEMPTS : x.attempts.filter(Boolean).length), 0), ci = c.items.findIndex(x => !attemptsDone(x));
    if (ci < 0) return { ci: Math.max(0, c.items.length - 1), ai: ATTEMPTS, phase: 'done', saved, total };
    const it = c.items[ci], phase = itemPhase(it);
    const ai = phase === 'write' ? it.attempts.findIndex(a => !a) : (() => { const k = (it.marks || []).findIndex(m => m === null || m === undefined); return k < 0 ? ATTEMPTS : k; })();
    return { ci, ai: ai < 0 ? ATTEMPTS : ai, phase, saved, total };
  }
  function buildCorrection(rec, now) {
    if (rec.kind !== 'write' || !CORRECTION_MODES.includes(rec.mode)) return null;
    const bad = rec.items.filter(x => x.ok === false);                     // final parent markings
    if (!bad.length) return null;
    return { id: 'corr-' + rec.id, sourceId: rec.id, sourceKind: rec.kind, sourceMode: rec.mode, levelId: rec.levelId, levelName: rec.levelName || '',
      createdAt: now, updatedAt: now, completedAt: null, state: 'open',
      items: bad.map(x => ({ cid: x.cid, c: x.c, jp: x.jp || '', w: x.w || '', wjp: x.wjp || '', attempts: Array(ATTEMPTS).fill(null), marks: Array(ATTEMPTS).fill(null), pending: null, confirmed: false, failed: 0 })) };
  }

  /* ---------------- Adaptive learning: per-character statistics, priority, weighted sampling ----------------
     Statistics are kept per character AND per skill (read / write are tracked separately), with practice (incl. revision) and exam apart.
     They are updated only when a session is COMPLETED (atomically with its record), so interrupted/unfinished sessions never count. */
  const ADAPT = {
    FAST_MS: 3000, SLOW_MS: 7000,            // < FAST_MS fast, > SLOW_MS slow, otherwise normal
    MAX_MS: 60000,                           // a single response time is capped (a long distraction must not skew the average)
    BASE: 100, PRACTICE_WRONG: 15, EXAM_WRONG: 25, SLOW_PENALTY: 5,
    MASTERY: { fast: 10, normal: 8, slow: 6, unknown: 8 },   // priority reduction earned by each correct answer of the current streak
    MIN: 10, MAX: 400,                       // priority is always within (0, ...]: every character keeps a chance, none dominates
    NEEDS: 130, MASTERED: 60,                // summary thresholds on the priority
  };
  const nz = v => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0), ts = v => (Number.isFinite(v) && v > 0 ? v : null);
  const normBucket = b => { b = b && typeof b === 'object' ? b : {}; const o = { attempts: nz(b.attempts), correct: nz(b.correct), incorrect: nz(b.incorrect), timedCorrect: nz(b.timedCorrect), totalCorrectTimeMs: nz(b.totalCorrectTimeMs) };
    if (o.correct + o.incorrect > o.attempts) o.attempts = o.correct + o.incorrect; if (o.timedCorrect > o.correct) o.timedCorrect = o.correct; return o; };
  const normSkill = k => { k = k && typeof k === 'object' ? k : {};
    return { practice: normBucket(k.practice), exam: normBucket(k.exam), consecutiveCorrect: nz(k.consecutiveCorrect), masteryPoints: nz(k.masteryPoints), lastAttemptAt: ts(k.lastAttemptAt), lastIncorrectAt: ts(k.lastIncorrectAt) }; };
  /* Safe for any input (missing / malformed / partial): always returns a complete row, or null when there is no usable character id. */
  function normStatsRow(x) {
    if (!x || typeof x !== 'object' || typeof x.cid !== 'string' || !x.cid) return null;
    return { cid: x.cid, c: typeof x.c === 'string' ? x.c : '', read: normSkill(x.read), write: normSkill(x.write) };
  }
  const classifyMs = ms => (!Number.isFinite(ms) || ms < 0 ? 'unknown' : ms < ADAPT.FAST_MS ? 'fast' : ms > ADAPT.SLOW_MS ? 'slow' : 'normal');
  /* One completed answer applied to one skill: returns a new skill object (input untouched). Revision counts as practice. */
  function applyAnswer(skill, mode, ok, ms, at) {
    const k = normSkill(skill), b = k[mode === 'exam' ? 'exam' : 'practice'], cls = classifyMs(ms);
    b.attempts++; k.lastAttemptAt = at || k.lastAttemptAt;
    if (ok) {
      b.correct++; k.consecutiveCorrect++; k.masteryPoints += ADAPT.MASTERY[cls];
      if (cls !== 'unknown') { b.timedCorrect++; b.totalCorrectTimeMs += Math.min(ms, ADAPT.MAX_MS); }   // only correct answers contribute to the average time
    } else { b.incorrect++; k.consecutiveCorrect = 0; k.masteryPoints = 0; k.lastIncorrectAt = at || k.lastIncorrectAt; }
    return k;
  }
  const averageCorrectMs = k => { const t = k.practice.timedCorrect + k.exam.timedCorrect; return t ? (k.practice.totalCorrectTimeMs + k.exam.totalCorrectTimeMs) / t : null; };
  /* priority = base + wrong answers (exam weighs more than practice) + slow-average penalty - mastery earned by the current correct streak, clamped to [MIN, MAX] */
  function priority(skill) {
    const k = normSkill(skill), avg = averageCorrectMs(k);
    const p = ADAPT.BASE + ADAPT.PRACTICE_WRONG * k.practice.incorrect + ADAPT.EXAM_WRONG * k.exam.incorrect + (avg !== null && avg > ADAPT.SLOW_MS ? ADAPT.SLOW_PENALTY : 0) - k.masteryPoints;
    return Math.min(ADAPT.MAX, Math.max(ADAPT.MIN, p));
  }
  /* 'new' | 'needs' | 'improving' | 'mastered' (used by the exam summary) */
  function learningStatus(skill) {
    const k = normSkill(skill); if (!k.practice.attempts && !k.exam.attempts) return 'new';
    const p = priority(k); return k.consecutiveCorrect === 0 || p >= ADAPT.NEEDS ? 'needs' : p <= ADAPT.MASTERED ? 'mastered' : 'improving';
  }
  /* Weighted random sampling WITHOUT replacement: every item with weight > 0 can be drawn, none twice. rand() in [0,1) is injectable. */
  function weightedSample(items, weights, n, rand) {
    const pool = items.map((it, i) => ({ it, w: Math.max(Number.isFinite(weights[i]) ? weights[i] : 0, 1e-9) })), out = [];
    while (out.length < n && pool.length) {
      let total = 0; pool.forEach(x => { total += x.w; });
      let r = rand() * total, k = 0;
      for (; k < pool.length - 1; k++) { r -= pool[k].w; if (r < 0) break; }
      out.push(pool.splice(k, 1)[0].it);
    }
    return out;
  }
  /* Statistics rebuilt from completed records (no response times exist for old records): used once for existing data and after replacing from an older backup. */
  function statsFromRecords(records) {
    const rows = new Map();
    records.slice().sort((a, b) => (a.date || 0) - (b.date || 0)).forEach(r => (r.items || []).forEach(it => {
      if (typeof it.ok !== 'boolean' || !it.cid || !KINDS.includes(r.kind)) return;
      const row = rows.get(it.cid) || { cid: it.cid, c: it.c || '', read: normSkill(), write: normSkill() };
      row[r.kind] = applyAnswer(row[r.kind], r.mode, it.ok, null, r.date); rows.set(it.cid, row);
    }));
    return [...rows.values()];
  }

  /* ---------------- Level mastery (per learner) ----------------
     The learner (or parent) marks each level as not started / learning / mastered. It is stored in the LEARNER's own data, never with the shared level, and it
     is only a label: it never creates records, scores or statistics and nothing is gated by it. Without a manual status the level shows 'learning' when this
     learner has any history for it, otherwise 'notStarted'. */
  const MASTERY = ['notStarted', 'learning', 'mastered'];
  function normMasteryRow(x) {
    if (!x || typeof x !== 'object' || typeof x.levelId !== 'string' || !x.levelId || !MASTERY.includes(x.status)) return null;
    return { levelId: x.levelId, status: x.status, at: Number.isFinite(x.at) && x.at > 0 ? x.at : null };
  }

  function buildRecord(s, now) {
    return { id: s.id, levelId: s.levelId, levelName: s.levelName || '', kind: s.kind, mode: s.mode, parentId: s.parentId || null,
      ...(Number.isFinite(s.started) ? { started: s.started } : {}), date: now,   // started = real session start, date = completion time
      ...(s.endedEarly ? { endedEarly: true, planned: s.planned } : {}),      // ended early: only the answered questions are in `items`; `planned` = how many were set
      items: s.items.map(({ cid, c, jp, w, wjp, ok, imgId }) => ({ cid, c, jp, w, wjp, ok, imgId: imgId || null })) };   // (response times are not part of the record: they only feed the statistics) started is the ORIGINAL start: pausing/resuming never resets it
  }

  /* ---------------- Topics ---------------- */
  const TOPIC = { LEARNED_STREAK: 2 };          // a character counts as "learned" after this many correct answers in a row (reading or writing)
  function normTopic(x) {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !x.id || typeof x.zh !== 'string' || !x.zh || !Array.isArray(x.charIds)) return null;
    const ids = []; x.charIds.forEach(i => { if (typeof i === 'string' && i && !ids.includes(i)) ids.push(i); });
    return { id: x.id, zh: x.zh, en: typeof x.en === 'string' ? x.en : '', icon: typeof x.icon === 'string' ? x.icon : '', ord: Number.isFinite(x.ord) ? x.ord : 0, charIds: ids };
  }
  const sortTopics = a => a.slice().sort((x, y) => (x.ord - y.ord) || (x.id < y.id ? -1 : 1));
  /* learned = the learner's latest answers for this character are correct often enough; it is read from the SAME per-character statistics the
     curriculum uses, so there is one progress record per character however it was learned */
  const charLearned = row => !!row && [row.read, row.write].some(k => k && k.consecutiveCorrect >= TOPIC.LEARNED_STREAK);

  /* ---------------- Shared content ----------------
     The learning content (levels with their characters/words) is shared by every learner and exists without any learner. It is kept in memory
     here and persisted through a provider ({ loadLevels, saveLevels, mergeLevels }); every Quiz of every learner reads the same object, so a change
     is immediately visible to all of them. Changes are serialised and persisted BEFORE they are applied to memory. */
  class SharedContent {
    constructor(provider, o) { o = o || {}; this.provider = provider; this.uid = o.uid || defaultUid; this.levels = []; this.topics = []; this._chain = Promise.resolve(); }
    level(id) { return this.levels.find(l => l.id === id); }
    async load() {
      this.levels = sortLevels(await this.provider.loadLevels());
      this.topics = this.provider.loadTopics ? sortTopics((await this.provider.loadTopics()).map(normTopic).filter(Boolean)) : [];
      return this;
    }
    /* ---- topics: shared, and they only REFERENCE the shared character records (a character may be in many topics) ---- */
    topic(id) { return this.topics.find(t => t.id === id); }
    /* the shared character records of a topic, in the topic's order; references that no longer resolve are skipped */
    topicChars(t) {
      const m = new Map(); this.levels.forEach(l => l.chars.forEach(c => { if (!m.has(c.id)) m.set(c.id, c); }));
      return (t ? t.charIds : []).map(id => m.get(id)).filter(Boolean);
    }
    /* Add the built-in packs that are not there yet (idempotent; run when Explore is first opened). Each entry is resolved to the shared record with the
       same glyph (curriculum levels first, then the topic library); only an entry found nowhere is created, once, in the hidden library level. */
    ensureTopics(T, now) {
      return this._run(async () => {
        const have = new Set(this.topics.map(t => t.id)), missing = T.PACKS.filter(p => !have.has(p.id)); if (!missing.length) return;
        const byGlyph = new Map(); this.levels.forEach(l => l.chars.forEach(c => { if (!byGlyph.has(c.c)) byGlyph.set(c.c, c.id); }));
        const add = [];
        const rows = missing.map(p => ({ id: p.id, zh: p.zh, en: p.en, icon: p.icon, ord: p.ord, charIds: p.items.map(([c, jp, w, wjp]) => {
          let id = byGlyph.get(c); if (!id) { id = T.libId(c); byGlyph.set(c, id); add.push({ id, c, jp, w, wjp, m: '' }); } return id; }) }));
        if (add.length) {
          const next = clone(this.levels), t = now === undefined ? Date.now() : now;
          let lib = next.find(l => l.id === T.LIB_LEVEL_ID); if (!lib) { lib = { id: T.LIB_LEVEL_ID, name: T.LIB_LEVEL_NAME, desc: '', hidden: true, chars: [], created: t, modified: t }; next.push(lib); }
          add.forEach(c => { if (!lib.chars.some(x => x.id === c.id)) lib.chars.push(c); }); lib.modified = t;
          next.forEach((l, i) => { l.ord = i; }); await this.provider.saveLevels(next); this.levels = sortLevels(next);
        }
        await this.provider.putTopics(rows); this.topics = sortTopics(this.topics.concat(rows));
      });
    }
    replaceTopics(rows) { return this._run(async () => { const next = rows.map(normTopic).filter(Boolean); await this.provider.saveTopics(next); this.topics = sortTopics(next); }); }
    mergeTopics(rows) { return this._run(async () => { const have = new Set(this.topics.map(t => t.id)), add = rows.map(normTopic).filter(x => x && !have.has(x.id)); if (add.length) await this.provider.putTopics(add); this.topics = sortTopics(this.topics.concat(add)); }); }
    _run(fn) {                      // serialised; never leaves memory and storage out of step
      const r = this._chain.then(async () => { try { await fn(); return { ok: true }; } catch (error) { return { ok: false, error }; } });
      this._chain = r.then(() => { }); return r;
    }
    mutate(fn) { return this._run(async () => { const next = clone(this.levels); fn(next); next.forEach((l, i) => { l.ord = i; }); await this.provider.saveLevels(next); this.levels = sortLevels(next); }); }
    replace(levels) { return this._run(async () => { const next = clone(levels); next.forEach((l, i) => { l.ord = i; }); await this.provider.saveLevels(next); this.levels = sortLevels(next); }); }
    merge(plan) { return this._run(async () => { await this.provider.mergeLevels(plan); this.levels = sortLevels(await this.provider.loadLevels()); }); }
  }

  /* ---------------- Quiz controller ----------------
     Rule: every mutation is computed on a copy, persisted, and only then applied to in-memory state. */
  class Quiz {
    constructor(store, o) {
      o = o || {};
      this.store = store; this.content = o.content || null; this.uid = o.uid || defaultUid; this.now = o.now || Date.now; this.shuffle = o.shuffle || shuf; this.random = o.random || Math.random;
      this._lv = []; this.records = []; this.sessions = []; this.stats = new Map(); this.mastery = new Map(); this._q = null; this.cur = null; this.busy = false; this.retry = null; this.result = null;
      this.draftDelay = o.draftDelay == null ? 400 : o.draftDelay;
      this.onDraftError = null; this.onDraftOk = null; this.draftError = null;
      this._pend = null; this._timer = null; this._flushing = null; this._flushRunning = false; this.closed = false; this._lastAct = Promise.resolve(); this._cq = Promise.resolve(); this.corrections = []; this._seq = Date.now() * 1000;
    }
    /* the levels are the SHARED content when a content object is given (the app), otherwise the learner store's own (stand-alone/legacy use) */
    get levels() { return this.content ? this.content.levels : this._lv; }
    set levels(v) { if (!this.content) this._lv = v; }
    async init() {
      if (this.content) await this.content.load();
      this._set(await this.store.loadAll());
      // One-time start for data that existed before the statistics: build them from the completed records (counts only, no times).
      if (!this.stats.size && this.records.length && !(await this.store.getMeta('statsInit'))) {
        const rows = statsFromRecords(this.records); await this.store.putStats(rows); await this.store.setMeta('statsInit', 1); rows.forEach(r => this.stats.set(r.cid, r));
      } else if (!(await this.store.getMeta('statsInit'))) await this.store.setMeta('statsInit', 1);
    }
    _set(d) {
      if (!this.content) this.levels = sortLevels(d.levels); this.records = d.records.slice().sort((a, b) => (a.date || 0) - (b.date || 0));
      this.sessions = (d.sessions || (d.session ? [d.session] : [])).slice();   // every unfinished session, newest first
      this.cur = (this.cur && this.sessions.find(x => x.id === this.cur.id)) || this.sessions[0] || null;   // cur = the session being worked on / most recent
      this.corrections = (d.corrections || []).map(upgradeCorrection).sort((a, b) => a.createdAt - b.createdAt);
      this.stats = new Map((d.stats || []).map(normStatsRow).filter(Boolean).map(r => [r.cid, r]));   // malformed rows can never crash the app
      this.mastery = new Map((d.mastery || []).map(normMasteryRow).filter(Boolean).map(r => [r.levelId, r]));
    }
    /* this learner's progress in a topic: how many of its characters are learned (from the per-character statistics) */
    topicProgress(topic) {
      const chars = (this.content ? this.content.topicChars(topic) : []).map(c => ({ ...c, learned: charLearned(this.stats.get(c.id)) }));
      return { total: chars.length, learned: chars.filter(c => c.learned).length, chars };
    }
    /* { status: 'notStarted' | 'learning' | 'mastered', manual } for a level of THIS learner */
    masteryOf(levelId) {
      const r = this.mastery.get(levelId); if (r) return { status: r.status, manual: true };
      const seen = this.records.some(x => x.levelId === levelId) || this.sessions.some(x => x.levelId === levelId);
      return { status: seen ? 'learning' : 'notStarted', manual: false };
    }
    /* set the manual status (null = back to automatic). Only the learner's mastery row is written: history, statistics and the level are untouched. */
    setMastery(levelId, status) {
      return this._serial(async () => {
        if (typeof levelId !== 'string' || !levelId) throw new Error('No such level');
        if (status === null) { await this.store.deleteMastery(levelId); this.mastery.delete(levelId); return; }
        if (!MASTERY.includes(status)) throw new Error('Invalid mastery status');
        const row = { levelId, status, at: this.now() }; await this.store.setMastery(row); this.mastery.set(levelId, row);
      });
    }
    skillStats(kind, cid) { const r = this.stats.get(cid); return normSkill(r && KINDS.includes(kind) ? r[kind] : null); }
    priorityOf(kind, cid) { return priority(this.skillStats(kind, cid)); }
    statusOf(kind, cid) { return learningStatus(this.skillStats(kind, cid)); }
    /* exam selection: weighted random sampling without replacement by adaptive priority (higher = likelier, none impossible) */
    pickExam(kind, chars, n) { return weightedSample(chars, chars.map(c => this.priorityOf(kind, c.id)), n, this.random); }
    /* response time of the question being shown: active time only (pausable), capped; null when it was not timed */
    qStart(key) { const t = this.now(); if (this._q && this._q.key === key) { if (this._q.since == null) this._q.since = t; } else this._q = { key, acc: 0, since: t }; }
    qPause() { if (this._q && this._q.since != null) { this._q.acc += Math.max(0, this.now() - this._q.since); this._q.since = null; } }
    qElapsed(key) { const q = this._q; if (!q || q.key !== key) return null; return Math.min(ADAPT.MAX_MS, q.acc + (q.since != null ? Math.max(0, this.now() - q.since) : 0)); }
    level(id) { return this.levels.find(l => l.id === id); }
    /* all unfinished sessions, most recently active first */
    unfinished() { return this.sessions.slice().sort((a, b) => ((b.updatedAt || b.started || 0) - (a.updatedAt || a.started || 0)) || (a.id < b.id ? -1 : 1)); }
    /* every mutation of a session: persisted first by the caller, then applied here (stamping the last-updated time is done by the caller on its copy) */
    _putSession(n) { const i = this.sessions.findIndex(x => x.id === n.id); if (i < 0) this.sessions.push(n); else this.sessions[i] = n; this.cur = n; }

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
      const d = await this.store.getDraft(s.id);
      return d && d.sid === s.id && d.qi === s.i && d.cid === s.items[s.i].cid ? d : null;
    }

    /* levels & characters */
    mutateLevels(fn) {
      if (this.content) return this._act(async () => { const r = await this.content.mutate(fn); if (!r.ok) throw r.error; });
      return this._act(async () => { const next = clone(this.levels); fn(next); next.forEach((l, i) => { l.ord = i; }); await this.store.saveLevels(next); this.levels = sortLevels(next); });
    }

    /* sessions */
    /* Starting an exercise never touches other unfinished sessions. Only an unfinished session of the SAME level, kind, mode (and
       revision source) counts as a duplicate: it is neither replaced nor duplicated unless the caller passes a `confirm` that agrees
       to replace it; otherwise { ok:false, duplicate:true, existing:<id> } tells the UI to resume it instead. */
    startSession({ kind, levelId, mode, chars, parentId, confirm, levelName }) {
      const L = this.level(levelId);
      let cs = chars || (L ? L.chars : []);
      if (!chars && mode === 'exam') { if (cs.length < 20) return Promise.resolve({ ok: false, error: new Error('Need at least 20 characters') }); cs = this.pickExam(kind, cs, 20); }
      if (!cs.length) return Promise.resolve({ ok: false, error: new Error('No characters') });
      const dup = this.sessions.find(x => x.kind === kind && x.levelId === levelId && x.mode === mode && (x.parentId || null) === (parentId || null));
      if (dup && !(confirm && confirm('這個練習已經有未完成的進度，要放棄舊的並重新開始嗎？'))) return Promise.resolve({ ok: false, duplicate: true, existing: dup.id });
      const t = this.now();
      const s = { id: this.uid(), levelId, levelName: levelName || (L ? L.name : ''), kind, mode, parentId: parentId || null, started: t, updatedAt: t, i: 0, phase: 'ask',
        items: this.shuffle(cs).map(c => ({ cid: c.id, c: c.c, jp: c.jp || '', w: c.w || '', wjp: c.wjp || '', ok: null, imgId: null })) };
      return this._act(async () => {
        await this.flushDraft();                                          // the drawing of the session being left is saved first
        await this.store.startSession(s, dup ? dup.id : null);
        this._dropDraft(); this.sessions = this.sessions.filter(x => !dup || x.id !== dup.id); this._putSession(s); this.result = null;
      });
    }
    /* Make an existing unfinished session the current one (its drawing draft is restored by loadDraft). */
    open(id) {
      return this._act(async () => {
        const s = this.sessions.find(x => x.id === id); if (!s) throw new Error('Unfinished session not found');
        if (this.cur && this.cur.id !== id) await this.flushDraft();      // pending drawing of the session being left
        this.cur = s; this.result = null;
      });
    }
    answerRead(ok) {
      return this._act(async () => {
        const s = this.cur; if (!s || s.kind !== 'read' || s.items[s.i].ok !== null) throw new Error('No open reading question');
        const n = clone(s), ms = this.qElapsed(s.id + ':' + s.i); n.items[n.i].ok = ok; if (ms !== null) n.items[n.i].ms = ms; n.i++; n.updatedAt = this.now();
        if (n.i >= n.items.length) return this._complete(n);
        await this.store.saveSession(n); this._putSession(n);
      });
    }
    answerWrite(data) {
      const id = 'img-' + this.uid(); // generated once so that retries do not create duplicates
      return this._act(async () => {
        const s = this.cur; if (!s || s.kind !== 'write' || s.phase !== 'ask') throw new Error('No open writing question');
        await this.flushDraft();                 // pending handwriting autosave must succeed first
        const n = clone(s), ms = this.qElapsed(s.id + ':' + s.i); n.items[n.i].imgId = id; if (ms !== null) n.items[n.i].ms = ms; n.i++; n.updatedAt = this.now();
        if (n.i >= n.items.length) { n.phase = 'mark'; n.i = 0; }
        await this.store.saveSession(n, { id, sid: s.id, data });   // also deletes this session's draft in the same transaction
        this._dropDraft(); this._putSession(n);
      });
    }
    setOk(k, v) {
      return this._act(async () => {
        const s = this.cur; if (!s || s.phase !== 'mark' || !s.items[k]) throw new Error('Not in marking phase');
        const n = clone(s); n.items[k].ok = v; n.updatedAt = this.now(); await this.store.saveSession(n); this._putSession(n);
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
      const rows = new Map();                                                       // statistics of every answered question, in order
      s.items.forEach(it => { if (typeof it.ok !== 'boolean') return;
        const row = rows.get(it.cid) || { ...(this.stats.get(it.cid) || { cid: it.cid, c: it.c, read: normSkill(), write: normSkill() }), c: it.c };
        row[s.kind] = applyAnswer(row[s.kind], s.mode, it.ok, it.ms, rec.date); rows.set(it.cid, normStatsRow(row)); });
      await this.store.completeSession(rec, corr, [...rows.values()]);   // record + statistics + (optional) correction written and session removed atomically
      rows.forEach((r, k) => this.stats.set(k, r)); this._q = null;
      this.records.push(rec); if (corr) this.corrections.push(corr); this._dropDraft(); this.sessions = this.sessions.filter(x => x.id !== s.id); this.cur = null; this.result = rec;
    }
    /* End the current question session early. The answered questions are finalised; the unanswered ones are dropped and NEVER counted as wrong.
       Reading: the result is created at once (same completion path as a finished session). Writing: the answered answers go to the usual parent
       marking and the result is created when marking is finished. Nothing answered: there is nothing to record, so the session is just removed.
       A session that already awaits marking has no unanswered question and is not ended this way. Ending is final: it can never be resumed as a question session. */
    endEarly() {
      return this._act(async () => {
        const s = this.cur; if (!s || s.phase !== 'ask') throw new Error('No question session to end');
        if (!s.i) {
          await this.store.discardSession(s.id);
          this._dropDraft(); this.sessions = this.sessions.filter(x => x.id !== s.id); this.cur = null; this.result = null; this._q = null; return;
        }
        const n = clone(s); n.planned = s.items.length; n.endedEarly = true; n.items = n.items.slice(0, s.i); n.updatedAt = this.now();
        if (s.kind === 'read') { await this._complete(n); return; }
        n.phase = 'mark'; n.i = 0;
        await this.store.saveSession(n);                                   // also removes this session's unsubmitted drawing
        this._dropDraft(); this._putSession(n); this._q = null;
      });
    }
    /* Discarding is always an explicit, confirmed action on ONE session (default: the current one); other sessions are untouched. */
    discard(confirm, id) {
      const t = id ? this.sessions.find(x => x.id === id) : this.cur;
      if (!t) return Promise.resolve({ ok: true });
      if (!(confirm && confirm('確定放棄這次未完成的測驗？已作答的內容會被刪除。'))) return Promise.resolve({ ok: false, cancelled: true });
      const sid = t.id;
      return this._act(async () => {
        await this.store.discardSession(sid);
        if (this.cur && this.cur.id === sid) { this._dropDraft(); this.cur = null; }
        this.sessions = this.sessions.filter(x => x.id !== sid);
      });
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
    /* ---- the correction of one character: write five, then mark five ---- */
    _corrItem(corrId, ci, phase) {
      const c = this.correction(corrId); if (!c || c.state !== 'open') throw new Error('Correction activity is not open');
      const it = c.items[ci]; if (!it) throw new Error('No such character');
      if (phase && itemPhase(it) !== phase) throw new Error('Not in the ' + phase + ' phase');
      return { c, it, n: clone(c) };
    }
    _putCorr(n, image, drop) { return this.store.saveCorrection(n, image, drop).then(() => { this.corrections = this.corrections.map(x => (x.id === n.id ? n : x)); }); }
    /* WRITING phase: store (or, with null, clear) the image of attempt slot `ai`. Marking does not exist yet, and a finished set of five can no longer be rewritten. */
    saveAttempt(corrId, ci, ai, data) {
      const imgId = data ? 'cimg-' + this.uid() : null;
      return this._serial(async () => {
        const { c, n } = this._corrItem(corrId, ci, 'write');
        if (!Number.isInteger(ai) || ai < 0 || ai >= ATTEMPTS) throw new Error('No such attempt');
        if (data != null && !(typeof data === 'string' && /^data:image\//.test(data))) throw new Error('Invalid handwriting image');
        const x = n.items[ci], old = x.attempts[ai]; x.attempts[ai] = imgId; x.marks[ai] = null; n.updatedAt = this.now();
        await this._putCorr(n, data ? { id: imgId, sid: c.id, data } : null, old);
      });
    }
    /* the drawing of the attempt being written (saved while drawing, so it survives leaving or refreshing); it counts only once submitted */
    savePending(corrId, ci, data) {
      const imgId = data ? 'cimg-' + this.uid() : null;
      return this._serial(async () => {
        const { c, it, n } = this._corrItem(corrId, ci, 'write');
        if (data != null && !(typeof data === 'string' && /^data:image\//.test(data))) throw new Error('Invalid handwriting image');
        n.items[ci].pending = imgId; n.updatedAt = this.now();
        await this._putCorr(n, data ? { id: imgId, sid: c.id, data } : null, it.pending || null);
      });
    }
    /* submit the pending drawing as the next attempt of the set (a blank canvas can never be submitted); the fifth one opens the marking phase */
    submitAttempt(corrId, ci) {
      return this._serial(async () => {
        const { it, n } = this._corrItem(corrId, ci, 'write'); if (!it.pending) throw new Error('Nothing written yet');
        const k = it.attempts.findIndex(a => !a); if (k < 0) throw new Error('The set is complete');
        const x = n.items[ci]; x.attempts[k] = x.pending; x.marks[k] = null; x.pending = null; n.updatedAt = this.now();
        await this._putCorr(n, null, null);
      });
    }
    /* MARKING phase (all five submitted): mark one attempt correct (true) or incorrect (false); it can be changed until the set is finished */
    markAttempt(corrId, ci, ai, ok) {
      return this._serial(async () => {
        const { n } = this._corrItem(corrId, ci, 'mark');
        if (!Number.isInteger(ai) || ai < 0 || ai >= ATTEMPTS || typeof ok !== 'boolean') throw new Error('No such attempt');
        n.items[ci].marks[ai] = ok; n.updatedAt = this.now(); await this._putCorr(n, null, null);
      });
    }
    /* Finish the marked set. All five correct: the character is done. Otherwise the consecutive-correct count is back at zero: the whole set (images
       included) is discarded and a completely new set of five must be written. The original record and score are never touched. */
    finishSet(corrId, ci) {
      return this._serial(async () => {
        const { it, n } = this._corrItem(corrId, ci, 'mark');
        if (it.marks.some(m => m === null || m === undefined)) throw new Error('Mark all five attempts first');
        const x = n.items[ci]; n.updatedAt = this.now();
        if (x.marks.every(m => m === true)) { x.confirmed = true; await this._putCorr(n, null, null); return; }
        const drop = x.attempts.filter(Boolean); if (x.pending) drop.push(x.pending);
        x.attempts = Array(ATTEMPTS).fill(null); x.marks = Array(ATTEMPTS).fill(null); x.pending = null; x.confirmed = false; x.failed = (x.failed | 0) + 1;
        await this._putCorr(n, null, drop);
      });
    }
    completeCorrection(corrId) {
      return this._serial(async () => {
        const c = this.correction(corrId); if (!c || c.state !== 'open') throw new Error('Correction activity is not open');
        if (!c.items.every(attemptsDone)) throw new Error('Not every character has five saved attempts');
        const n = clone(c); n.state = 'done'; n.completedAt = this.now(); n.updatedAt = n.completedAt;
        await this.store.saveCorrection(n, null, null);
        this.corrections = this.corrections.map(x => (x.id === corrId ? n : x));
      });
    }

    /* backup: one format (cq-backup, version 1). `sessions`, `drafts` and `corrections` are optional additions: an older file
       without them still imports, and a file with them is still a valid version-1 file. */
    async exportBackup() {
      const all = await this.store.exportAll(); const im = new Map(all.images.map(i => [i.id, i.data])); let missing = 0;
      const inline = x => { const { imgId, ...rest } = x; if (imgId) { const data = im.get(imgId); if (data) return { ...rest, img: data }; missing++; } return rest; };
      const records = all.records.slice().sort((a, b) => (a.date || 0) - (b.date || 0)).map(r => ({ ...r, items: r.items.map(inline) }));
      const stats = (all.stats || []).map(normStatsRow).filter(Boolean).sort((a, b) => (a.cid < b.cid ? -1 : 1));
      const mastery = (all.mastery || []).map(normMasteryRow).filter(Boolean).sort((a, b) => (a.levelId < b.levelId ? -1 : 1));
      const sessions = (all.sessions || []).map(x => ({ ...x, items: x.items.map(inline) }));
      const drafts = (all.drafts || []).filter(d => { const x = sessions.find(y => y.id === d.sid); return x && x.kind === 'write' && x.phase === 'ask' && x.i === d.qi && x.items[x.i].cid === d.cid; });   // never export an orphan/stale draft
      const inl = a => { if (!a) return null; const data = im.get(a); if (data) return data; missing++; return null; };
      const corrections = (all.corrections || []).map(upgradeCorrection).sort((a, b) => a.createdAt - b.createdAt).map(c => ({ ...c, items: c.items.map(it => ({ ...it, attempts: it.attempts.map(inl), pending: inl(it.pending) })) }));
      return { missingImages: missing, json: { format: 'cq-backup', version: 1, exported: new Date(this.now()).toISOString(), data: { levels: this.content ? [] : sortLevels(all.levels), records, sessions, drafts, corrections, stats, mastery } } };
    }
    /* mode: 'merge' | 'replace'. Throws ImportError (validation) before touching any data. */
    async importBackup(json, mode, confirm, opts) {
      const data = validateBackup(json);
      if (this.content && data.levels.length) throw new ImportError(['學習內容是所有學習者共用的，必須另外匯入，不能和學習進度一起匯入']);
      const ss = splitSessionImages(data.sessions), cc = splitCorrectionImages(data.corrections);
      if (mode === 'replace') {
        const openCorr = !data.provided.corrections && this.openCorrections().length;
        const msg = '這會取代目前所有資料' + (this.sessions.length ? '，包括' + (data.provided.sessions ? '' : '（備份中沒有未完成的測驗）') + '未完成的測驗' : '') + (data.provided.corrections ? '' : (openCorr ? '（未完成的寫五次練習會保留）' : '')) + '。建議先匯出目前的資料。確定要取代嗎？';
        if (!(confirm && confirm(msg))) return { cancelled: true };
        const sp = splitImages(data.records);
        const ids = new Set(data.levels.map(l => l.id)), rids = new Set(data.records.map(r => r.id));
        const warnings = [...data.statWarnings];
        const nl = data.records.filter(r => !ids.has(r.levelId)).length, np = data.records.filter(r => r.parentId && !rids.has(r.parentId)).length;
        if (nl) warnings.push(nl + ' 個紀錄所屬的級別不在備份中（紀錄仍會保留）');
        if (np) warnings.push(np + ' 個溫習紀錄找不到原本的測驗紀錄（仍會保留）');
        await this.store.replaceAll({ levels: data.levels, records: sp.records, images: [...sp.images, ...ss.images, ...cc.images], sessions: ss.sessions, drafts: data.drafts,
          corrections: data.provided.corrections ? cc.corrections : undefined,
          stats: data.provided.stats ? data.stats : statsFromRecords(sp.records), mastery: data.provided.mastery ? data.mastery : undefined });      // an older backup has none: rebuilt from its records
        this.cur = null; this._set(await this.store.loadAll());
        return { mode, added: { levels: data.levels.length, chars: data.levels.reduce((n, l) => n + l.chars.length, 0), records: data.records.length, sessions: data.sessions.length, corrections: data.corrections.length }, conflicts: [], warnings, identical: 0 };
      }
      const incoming = new Set(data.records.map(r => r.id)), imgIds = [];
      this.records.filter(r => incoming.has(r.id)).forEach(r => r.items.forEach(x => { if (x.imgId) imgIds.push(x.imgId); }));
      const inS = new Set(data.sessions.map(x => x.id)), inC = new Set(data.corrections.map(x => x.id));
      this.sessions.filter(x => inS.has(x.id)).forEach(x => x.items.forEach(it => { if (it.imgId) imgIds.push(it.imgId); }));
      this.corrections.filter(x => inC.has(x.id)).forEach(x => x.items.forEach(it => { it.attempts.forEach(a => { if (a) imgIds.push(a); }); if (it.pending) imgIds.push(it.pending); }));
      const imgs = imgIds.length ? await this.store.getImages(imgIds) : {};
      const plan = planMerge({ levels: this.levels, records: this.records, sessions: this.sessions, corrections: this.corrections, stats: [...this.stats.values()], mastery: [...this.mastery.values()] }, data, this.now(), imgs);
      const none = { levels: 0, chars: 0, records: 0, sessions: 0, corrections: 0 };
      // Any conflict stops the merge: nothing is applied, so the data is never left half-merged.
      if (plan.conflicts.length && !(opts && opts.allowPartial)) return { mode, aborted: true, added: none, conflicts: plan.conflicts, warnings: plan.warnings, identical: plan.identical };
      await this.store.applyMerge({ newLevels: plan.newLevels, updatedLevels: plan.updatedLevels, records: plan.newRecords, images: plan.images, sessions: plan.newSessions, drafts: plan.newDrafts, corrections: plan.newCorrections, stats: plan.newStats, mastery: plan.newMastery });
      this._set(await this.store.loadAll());
      return { mode, added: plan.added, conflicts: plan.conflicts, warnings: [...data.statWarnings, ...plan.warnings], identical: plan.identical };
    }
  }

  return { Quiz, SharedContent, TOPIC, normTopic, charLearned, MASTERY, normMasteryRow, ADAPT, normStatsRow, applyAnswer, priority, learningStatus, weightedSample, statsFromRecords, classifyMs, ImportError, validateBackup, planMerge, splitImages, splitSessionImages, splitCorrectionImages, buildRecord, buildCorrection, correctionPosition, attemptsDone, itemPhase, upgradeCorrection, formatDuration, durationOf, ATTEMPTS, shuf, clone };
});
