/* Backup: shared content and per-learner progress are separate parts of one file (cq-backup, schemaVersion 2).

   {
     format: 'cq-backup', schemaVersion: 2, exportedAt: ISO,
     content:  { levels: [ { id, name, desc, chars: [ { id, c, jp, w, wjp, m } ], created, modified } ] },   // ONCE; characters carry their word data
     profiles: [ { profileId, profileName, avatar, data: { records, sessions, drafts, corrections, stats } } ]   // one entry per learner
   }

   Either part may be absent: content only, progress only, or both; no learner is needed to export or import content.
   Legacy files (format cq-backup, version 1: one learner's levels AND progress together) are still read: their levels become the content
   and their progress an unnamed learner that is NEVER assigned to anyone automatically. */
(function (root, factory) {
  const m = factory((typeof module === 'object' && module.exports) ? require('./core.js') : root.CQCore, (typeof module === 'object' && module.exports) ? require('./profiles.js') : root.CQProfiles);
  if (typeof module === 'object' && module.exports) module.exports = m; else root.CQBackup = m;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, P) {
  const FORMAT = 'cq-backup', SCHEMA = 2, PROGRESS_KEYS = ['records', 'sessions', 'drafts', 'corrections', 'stats'];
  const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
  const wrap = data => ({ format: FORMAT, version: 1, exported: '', data });
  const fail = list => { throw new C.ImportError(list); };

  /* ---------------- export ---------------- */
  /* opts: { includeContent (default true), profileIds ([] = no progress), getQuiz(id) -> an already open Quiz of that learner, or null } */
  async function buildExport(mgr, content, opts) {
    opts = opts || {}; await content.load();
    const out = { format: FORMAT, schemaVersion: SCHEMA, exportedAt: new Date(mgr.now()).toISOString() };
    if (opts.includeContent !== false) out.content = { levels: content.levels.map(({ ord, ...l }) => l) };
    out.profiles = []; let missing = 0;
    const all = await mgr.list('all');
    for (const id of opts.profileIds || []) {
      const p = all.find(x => x.id === id); if (!p) continue;
      let q = opts.getQuiz && opts.getQuiz(id), opened = false;
      if (!q) { opened = !mgr.stores.has(id); q = new C.Quiz(await mgr.openStore(id, { allowArchived: true }), { content }); await q.init(); }
      try {
        const r = await q.exportBackup(); missing += r.missingImages;
        const { levels, ...data } = r.json.data;                              // the content is never repeated inside a learner
        out.profiles.push({ profileId: p.id, profileName: p.name, avatar: p.avatar, data });
      } finally { if (opened) mgr.closeStore(id); }
    }
    return { json: out, missingImages: missing };
  }

  /* ---------------- parse + validate (nothing is changed) ---------------- */
  function summary(v) { return { records: v.records.length, sessions: v.sessions.length, corrections: v.corrections.length, stats: v.stats.length }; }
  const hasProgress = s => s.records || s.sessions || s.corrections || s.stats;
  function parse(json) {
    if (!isObj(json) || json.format !== FORMAT) fail(['這不是有效的備份檔']);
    if (json.schemaVersion === 2) {
      const content = json.content === undefined || json.content === null ? null : json.content;
      let levels = null;
      if (content !== null) {
        if (!isObj(content) || !Array.isArray(content.levels)) fail(['備份的學習內容格式不正確']);
        levels = C.validateBackup(wrap({ levels: content.levels, records: [] })).levels;
      }
      if (!Array.isArray(json.profiles)) fail(['備份缺少學習者的列表']);
      const profiles = [], ids = new Set();
      json.profiles.forEach((p, i) => {
        const at = '第 ' + (i + 1) + ' 位學習者';
        if (!isObj(p) || typeof p.profileId !== 'string' || !p.profileId) fail([at + '沒有有效的編號']);
        if (ids.has(p.profileId)) fail(['學習者編號重複：' + p.profileId]);
        ids.add(p.profileId);
        if (!isObj(p.data)) fail([at + '沒有學習進度資料']);
        const data = { levels: [], records: [], ...p.data };
        PROGRESS_KEYS.forEach(k => { if (p.data[k] === undefined) delete data[k]; });
        if (data.records === undefined) data.records = [];
        let v; try { v = C.validateBackup(wrap({ ...data, levels: [] })); } catch (e) { fail((e.list || [e.message]).map(m => '「' + (typeof p.profileName === 'string' ? p.profileName : at) + '」：' + m)); }
        profiles.push({ profileId: p.profileId, profileName: typeof p.profileName === 'string' && p.profileName.trim() ? p.profileName.trim() : at, avatar: P.AVATARS.includes(p.avatar) ? p.avatar : null,
          legacy: false, summary: summary(v), json: wrap({ ...data, levels: [] }) });
      });
      return { schema: 2, content: levels, profiles };
    }
    if (json.version === 1) {                                               // legacy: one learner's levels and progress in one file
      const v = C.validateBackup(json), s = summary(v), d = { ...json.data, levels: [] };
      return { schema: 1, content: v.levels.length ? v.levels : null,
        profiles: hasProgress(s) ? [{ profileId: null, profileName: null, avatar: null, legacy: true, summary: s, json: wrap(d) }] : [] };
    }
    return fail(['不支援的備份版本']);
  }

  /* default choice for each learner in the file: the local learner with the SAME stable id, otherwise skip. Never guessed from a name. */
  function suggestTargets(parsed, localProfiles) {
    return parsed.profiles.map(p => (p.profileId && localProfiles.some(l => l.id === p.profileId) ? 'p:' + p.profileId : 'skip'));
  }

  /* ---------------- apply ---------------- */
  /* opts: { content: 'merge'|'replace'|'skip', targets: ['skip'|'new'|'p:<id>', ...] aligned with parsed.profiles, getQuiz(id) }
     Nothing is changed if the choices are invalid or the content merge finds conflicts. Learners are imported independently of each other. */
  async function apply(mgr, content, parsed, opts) {
    const mode = opts.content || 'skip', targets = opts.targets || parsed.profiles.map(() => 'skip');
    if (targets.length !== parsed.profiles.length) fail(['學習者的對應選擇不正確']);
    const chosen = targets.filter(t => t !== 'skip');
    const ids = chosen.filter(t => t.startsWith('p:')).map(t => t.slice(2));
    if (new Set(ids).size !== ids.length) fail(['不能把兩位備份中的學習者匯入到同一位學習者，以免進度混在一起']);
    for (const t of chosen) if (t !== 'new' && !(t.startsWith('p:') && await mgr.get(t.slice(2)))) fail(['找不到要匯入的學習者']);
    await content.load();
    const rep = { content: { status: 'skipped', added: { levels: 0, chars: 0 }, identical: 0, conflicts: [], warnings: [] }, profiles: [] };

    if (parsed.content && mode !== 'skip') {
      if (mode === 'replace') {
        const r = await content.replace(parsed.content); if (!r.ok) throw r.error;
        rep.content = { status: 'replaced', added: { levels: parsed.content.length, chars: parsed.content.reduce((n, l) => n + l.chars.length, 0) }, identical: 0, conflicts: [], warnings: [] };
      } else {
        const plan = C.planMerge({ levels: content.levels, records: [] }, { levels: parsed.content, records: [] }, mgr.now(), {});
        if (plan.conflicts.length) { rep.content = { status: 'aborted', added: { levels: 0, chars: 0 }, identical: plan.identical, conflicts: plan.conflicts, warnings: plan.warnings }; rep.aborted = true; return rep; }
        const r = await content.merge({ newLevels: plan.newLevels, updatedLevels: plan.updatedLevels }); if (!r.ok) throw r.error;
        rep.content = { status: 'merged', added: { levels: plan.added.levels, chars: plan.added.chars }, identical: plan.identical, conflicts: [], warnings: plan.warnings };
      }
    }

    for (let i = 0; i < parsed.profiles.length; i++) {
      const bp = parsed.profiles[i], t = targets[i], name = bp.profileName || '匯入的學習者', row = { name, target: t, status: 'skipped' };
      rep.profiles.push(row); if (t === 'skip') continue;
      let id = null, opened = false;
      try {
        if (t === 'new') { const p = await mgr.create({ name: [...name].slice(0, P.MAX_NAME).join(''), avatar: bp.avatar || P.AVATARS[0] }); id = p.id; row.created = true; } else id = t.slice(2);
        let q = opts.getQuiz && opts.getQuiz(id);
        if (!q) { opened = !mgr.stores.has(id); q = new C.Quiz(await mgr.openStore(id, { allowArchived: true }), { content }); await q.init(); }
        const r = await q.importBackup(JSON.parse(JSON.stringify(bp.json)), 'merge');
        Object.assign(row, { profileId: id, status: r.aborted ? 'aborted' : 'imported', added: r.added, conflicts: r.conflicts, warnings: r.warnings, identical: r.identical });
      } catch (e) { Object.assign(row, { profileId: id, status: 'failed', error: e.list ? e.list.join('；') : (e.message || String(e)) }); }
      finally { if (opened && id) mgr.closeStore(id); }
    }
    return rep;
  }

  return { FORMAT, SCHEMA, buildExport, parse, suggestTargets, apply };
});
