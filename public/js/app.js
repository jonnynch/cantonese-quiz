/* UI layer. All persistence goes through CQCore.Quiz -> CQStorage (IndexedDB). */
let corrId = null, corrIdx = 0, corrSum = false, cs = [], cTimers = {}, cFail = new Set(), autoKey = null, speechUnlocked = false;
let Q, store, mgr, CT, bk = null, profile = null, pview = 'pick', tab = 'levels', lid = null, rid = null, inS = false, res = null, cv, cx, drawing = false, dirty = false;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lv = id => (Q || CT).level(id);
const UID = () => (Q || CT).uid();
const fd = t => new Date(t).toLocaleString('zh-HK');
const NAME = { read: { practice: '讀字練習', revision: '讀字溫習', exam: '讀字考試' }, write: { practice: '聽音寫字', revision: '寫字溫習', exam: '寫字考試' } };
const LB = r => NAME[r.kind][r.mode];
function toast(t) { let e = $('#toast'); if (!e) { e = document.createElement('div'); e.id = 'toast'; document.body.appendChild(e); } e.textContent = t; e.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => e.hidden = true, 2600); }
const reason = e => !e ? '' : e.code === 'quota' ? '儲存空間不足' : e.code === 'unavailable' ? '無法使用儲存空間' : '寫入時發生錯誤';

/* ---------- save error banner ---------- */
function showBar(html, retry) {
  let b = $('#errbar'); if (!b) { b = document.createElement('div'); b.id = 'errbar'; document.body.appendChild(b); }
  b.innerHTML = `<div>${html}</div><div class="row"><button class="b p" onclick="${retry}()">重試</button><button class="b" onclick="hideErr()">關閉</button></div>`;
  b.hidden = false;
}
function showSaveError(what, e) { showBar(`<b>${esc(what)}沒有儲存成功。</b>（${esc(reason(e))}）你的作答仍然保留在畫面上，請按「重試」。`, 'retrySave'); }
function showDraftError(e) { showBar(`<b>筆跡未能自動儲存。</b>（${esc(reason(e))}）畫面上的筆跡仍然保留，請按「重試」。儲存成功之前，這一題不能完成。`, 'retryDraft'); }
function retryDraft() { const q = Q; q.flushDraft().then(() => { if (q === Q) hideErr(); }, () => { }); }
function hideErr() { const b = $('#errbar'); if (b) b.hidden = true; }
let lastWhat = '';
function after(r, what, q) {   // r = result of a Quiz action; q = the Quiz (learner) it was started for
  if (r.busy || (q && q !== Q)) return;   // learner was switched meanwhile: never touch the new learner's screen
  if (!r.ok) { lastWhat = what; showSaveError(what, r.error); return; }
  hideErr();
  if (Q.result) { res = Q.result; Q.result = null; inS = true; }
  render(); autoSpeak();
}
async function retrySave() { const q = Q; if (q.busy) return; after(await q.retryLast(), lastWhat, q); }

const AV = a => (CQProfiles.AVATAR_EMOJI[a] || '🙂');
function render() {
  if (!Q) { $('#nav').innerHTML = ''; ({ manage: vManage, content: vLevels, backup: vBackup }[pview] || vPickProfile)($('#main')); return; }
  $('#nav').innerHTML = `<button class="who" onclick="switchLearner()" aria-label="切換學習者"><span class="av1">${AV(profile.avatar)}</span> ${esc(profile.name)} <small>切換學習者</small></button>` + [['levels', '級別管理'], ['practice', '練習'], ['exam', '考試'], ['topics', '探索'], ['stories', '故事'], ['hist', '學習紀錄'], ['set', '設定']].map(([k, t]) => `<button class="${tab === k && !inS ? 'on' : ''}" onclick="${k === 'topics' ? 'tid=null;' : ''}go('${k}')">${t}</button>`).join('');
  const m = $('#main'); if (corrId) { vCorrection(m); return; }
  if (inS) { sess(m); hydrate(m); return; }
  ({ levels: vLevels, practice: vPick, exam: vPick, topics: vTopics, stories: vStories, hist: vHist, set: vSet, backup: vBackup })[tab](m); hydrate(m);
}
function hydrate(root) {
  const st0 = store;
  root.querySelectorAll('img[data-img]').forEach(async im => {
    try { const r = await st0.getImage(im.dataset.img); if (r) im.src = r.data; else im.replaceWith('圖片無法顯示'); } catch (e) { im.replaceWith('圖片無法顯示'); }
  });
}
/* Leaving a writing question: make sure the drawing is saved first; if that is impossible, ask before discarding it. */
async function safeToLeave() {
  if (corrId) { await flushCorr(); return !cFail.size || confirm('有筆跡未能儲存，離開後這些筆跡會遺失。確定離開？'); }
  if (!inS || !dirty) return true;
  try { await Q.flushDraft(); return true; }
  catch (e) { return confirm('筆跡未能儲存，離開後這一題的筆跡會遺失。確定離開？'); }
}
async function go(t) {
  if (!(await safeToLeave())) return;
  silence(); hideErr(); inS = false; res = null; corrId = null; corrSum = false; tab = t; lid = null; rid = null; dirty = false; render();
}
/* ---------- forms ---------- */
function form(title, fields, vals, cb) {
  const d = document.createElement('div'); d.className = 'modal';
  d.innerHTML = `<form class="card"><h3>${title}</h3>${fields.map(([k, l]) => `<label>${l}<input name="${k}" value="${esc(vals[k])}" autocomplete="off"></label>`).join('')}<div class="warn err"></div><div class="row"><button type="button" class="b" id="x">取消</button><button class="b p" id="ok">儲存</button></div></form>`;
  document.body.appendChild(d); const f = d.querySelector('form');
  d.querySelector('#x').onclick = () => d.remove();
  f.onsubmit = async e => {
    e.preventDefault(); const btn = d.querySelector('#ok'); if (btn.disabled) return;
    const o = Object.fromEntries(new FormData(f)); for (const k in o) o[k] = o[k].trim();
    btn.disabled = true; d.querySelector('.err').textContent = '';
    try { if ((await cb(o)) !== false) d.remove(); }
    catch (err) { d.querySelector('.err').textContent = '儲存失敗（' + reason(err) + '），資料沒有改動。請重試。'; }
    btn.disabled = false;
  };
}
async function commitLevels(fn) { const q = Q, r = await (q ? q.mutateLevels(fn) : CT.mutate(fn)); if (r.busy) throw Object.assign(new Error('busy'), { code: 'busy' }); if (!r.ok) throw r.error; if (q === Q) render(); }
/* ---------- level management ---------- */
function vLevels(m) {
  if (lid && lv(lid)) {
    const L = lv(lid);
    m.innerHTML = `<div class="row"><button class="b" onclick="lid=null;render()">返回</button><h2 style="margin:0">${esc(L.name)} <small>${L.chars.length} 字</small></h2></div>${L.desc ? `<p>${esc(L.desc)}</p>` : ''}<div class="row"><button class="b p" onclick="charForm()">新增字</button></div><div class="grid">` +
      L.chars.map(c => `<div class="card"><div class="han mid">${esc(c.c)}</div><div>${esc(c.jp)}</div><div>${esc(c.w)} <small>${esc(c.wjp)}</small></div><div><small>${esc(c.m)}</small></div><div class="row"><button class="b" onclick="charForm('${c.id}')">編輯</button><button class="b r" onclick="delChar('${c.id}')">刪除</button></div></div>`).join('') + '</div>' + (L.chars.length ? '' : '<p>這個級別還沒有字。</p>'); return;
  }
  m.innerHTML = `<div class="row">${Q ? '' : `<button class="b" onclick="pview='pick';render()">返回</button>`}<h2 style="margin:0">級別管理</h2><button class="b p" onclick="addLevel()">新增級別</button></div><p><small>學習內容由所有學習者共用，修改後每位學習者都會看到。</small></p>` +
    ((Q || CT).levels.map(L => `<div class="card"><h3>${esc(L.name)} <small>${L.chars.length} 字</small>${L.hidden ? ' <small>（主題用的字庫，不在練習和考試的級別列表中）</small>' : ''}</h3>${L.desc ? `<p>${esc(L.desc)}</p>` : ''}<div class="row"><button class="b p" onclick="lid='${L.id}';render()">查看</button><button class="b" onclick="renLevel('${L.id}')">重新命名</button><button class="b r" onclick="delLevel('${L.id}')">刪除</button></div></div>`).join('') || '<p>還沒有級別，請先新增。</p>');
}
function addLevel() { form('新增級別', [['name', '名稱'], ['desc', '說明（可選）']], {}, o => { if (!o.name) return false; const t = Date.now(); return commitLevels(ls => ls.push({ id: UID(), name: o.name, desc: o.desc, chars: [], created: t, modified: t })); }) }
function renLevel(id) { const L = lv(id); form('重新命名', [['name', '名稱'], ['desc', '說明（可選）']], L, o => { if (!o.name) return false; return commitLevels(ls => { const x = ls.find(l => l.id === id); x.name = o.name; x.desc = o.desc; x.modified = Date.now(); }); }) }
async function delLevel(id) {
  if (!confirm('刪除這個級別和裏面所有的字？此動作無法復原。（已有的學習紀錄和未完成的測驗會保留。）')) return;
  try { await commitLevels(ls => { ls.splice(ls.findIndex(l => l.id === id), 1); }); } catch (e) { alert('刪除失敗（' + reason(e) + '），資料沒有改動。'); }
}
function charForm(id) {
  const L = lv(lid), c = id ? L.chars.find(x => x.id === id) : {};
  form(id ? '編輯字' : '新增字', [['c', '字'], ['jp', '粵拼'], ['w', '詞語'], ['wjp', '詞語粵拼'], ['m', '意思']], c, o => {
    if ([...o.c].length !== 1) { alert('「字」欄位請輸入一個繁體字'); return false; }
    return commitLevels(ls => { const x = ls.find(l => l.id === lid); if (id) Object.assign(x.chars.find(y => y.id === id), o); else x.chars.push({ id: UID(), ...o }); x.modified = Date.now(); });
  });
}
async function delChar(id) {
  if (!confirm('刪除這個字？')) return;
  try { await commitLevels(ls => { const x = ls.find(l => l.id === lid); x.chars = x.chars.filter(c => c.id !== id); x.modified = Date.now(); }); } catch (e) { alert('刪除失敗（' + reason(e) + '），資料沒有改動。'); }
}
/* ---------- practice / exam picker ---------- */
function vPick(m) {
  const ex = tab === 'exam', md = ex ? 'exam' : 'practice', lab = ex ? ['讀字考試', '寫字考試'] : ['讀字練習', '聽音寫字']; let h = '';
  // every unfinished session of this tab (exams here, practice and revision on the practice tab), each independently resumable or discardable
  Q.unfinished().filter(s => (s.mode === 'exam') === ex).forEach(s => {
    const prog = s.phase === 'mark' ? '評分中' : '第 ' + (s.i + 1) + ' / ' + s.items.length + ' 題';
    h += `<div class="card"><b>有未完成的${LB(s)}</b>（${esc(s.levelName)}，${prog}）<div><small>上次作答：${fd(s.updatedAt || s.started || 0)}</small></div><div class="row"><button class="b p" data-id="${esc(s.id)}" onclick="resume(this.dataset.id)">繼續</button><button class="b r" data-id="${esc(s.id)}" onclick="discard(this.dataset.id)">放棄</button></div></div>`;
  });
  Q.openCorrections().forEach(c => { const p = CQCore.correctionPosition(c);
    h += `<div class="card"><b>有未完成的寫五次練習</b>（${esc(c.levelName)}，第 ${p.ci + 1} / ${c.items.length} 個字，${p.phase === 'mark' ? '評分中' : '寫第 ' + Math.min(p.ai + 1, 5) + ' 次'}，${p.saved} / ${p.total}）<div><small>上次作答：${fd(c.updatedAt || c.createdAt)}</small></div><div class="row"><button class="b p" data-id="${esc(c.id)}" onclick="openCorrection(this.dataset.id)">繼續</button></div></div>`; });
  /* every level can always be started, whatever its mastery status: mastery is only this learner's own label (never a lock or a reward) */
  h += Q.levels.filter(L => !L.hidden).map(L => { const n = L.chars.length, low = ex && n < 20, ok = n && !low, ms = Q.masteryOf(L.id).status;
    return `<div class="card lvl ${ms}"><h3>${esc(L.name)} <small>${n} 字</small> <span class="mst ${ms}" role="status">${MS[ms][0]} ${MS[ms][1]}</span></h3>${low ? '<div class="warn">需要至少 20 個字才可以考試。</div>' : ''}<div class="row"><button class="b p" ${ok ? '' : 'disabled'} onclick="start('read','${L.id}','${md}')">${lab[0]}</button><button class="b p" ${ok ? '' : 'disabled'} onclick="start('write','${L.id}','${md}')">${lab[1]}</button></div>` +
      `<div class="seg" role="group" aria-label="${esc(L.name)} 的掌握狀態">${['notStarted', 'learning', 'mastered'].map(s => `<button class="b seg-b ${ms === s ? 'on' : ''}" aria-pressed="${ms === s}" data-lid="${esc(L.id)}" onclick="setMastery(this.dataset.lid, '${s}')">${MS[s][0]} ${MS[s][1]}</button>`).join('')}</div></div>`; }).join('') || '<p>請先到「級別管理」新增級別和字。</p>';
  m.innerHTML = `<h2>${ex ? '考試' : '練習'}</h2>` + h;
}
const MS = { notStarted: ['⚪', '未開始'], learning: ['📖', '學習中'], mastered: ['⭐', '已掌握'] };
/* change this learner's own mastery status of a level; nothing else changes (history, scores and statistics are untouched) */
async function setMastery(levelId, status) {
  const q = Q, r = await q.setMastery(levelId, status); if (q !== Q || r.busy) return;
  if (!r.ok) { showBar(`<b>掌握狀態沒有儲存成功。</b>（${esc(reason(r.error))}）`, 'hideErr'); return; }
  hideErr(); render();
}
/* Continue an unfinished session (id) or, without an id, the current one. Nothing is spoken again and nothing is reset. */
async function resume(id) {
  const q = Q;
  if (id && !(q.cur && q.cur.id === id)) { const r = await q.open(id); if (q !== Q || r.busy) return; if (!r.ok) { alert('無法繼續這次測驗（' + (reason(r.error) || r.error.message) + '）。進度沒有改動。'); return; } }
  inS = true; res = null; dirty = false; mkIdx = null; render();
}
async function discard(id) { const q = Q, r = await q.discard(confirm, id); if (q !== Q || r.busy || r.cancelled) return; if (!r.ok) { alert('放棄失敗（' + reason(r.error) + '），未完成的測驗仍然保留。'); return; } render(); }
async function start(kind, levelId, mode) {
  unlockSpeech();
  const q = Q, r = await q.startSession({ kind, levelId, mode });
  if (q !== Q || r.busy) return;
  if (r.duplicate) { toast('這個練習已有未完成的進度，繼續上次的進度'); return resume(r.existing); }   // never a second copy, never a silent discard
  if (!r.ok) { alert('無法開始測驗（' + (reason(r.error) || r.error.message) + '）。'); return; }
  inS = true; res = null; dirty = false; render(); autoSpeak();
}
/* ---------- topics (Explore): free exploration; no level has to be finished or mastered first ---------- */
let tid = null, tOnly = false, topicsTried = false, topicsErr = null;
function vTopics(m) {
  if (!topicsTried) {                           // the built-in packs are added to the shared content the first time (idempotent, instant afterwards)
    topicsTried = true; topicsErr = null; m.innerHTML = '<p>載入主題…</p>';
    CT.ensureTopics(CQTopics).then(r => { if (!r.ok) topicsErr = r.error; if (Q && tab === 'topics' && !inS && !corrId) render(); }); return;
  }
  if (!CT.topics.length) { m.innerHTML = `<h2>探索主題</h2><p class="warn">${topicsErr ? '主題載入失敗（' + esc(reason(topicsErr)) + '）。' : '暫時沒有主題。'}</p><div class="row"><button class="b p" onclick="topicsTried=false;render()">重試</button></div>`; return; }
  const t = tid && CT.topic(tid); if (t) return vTopic(m, t);
  tid = null;
  m.innerHTML = `<h2>探索主題</h2><p><small>想學甚麼就選甚麼，不需要先完成任何級別。</small></p><div class="grid topics">` + CT.topics.map(t => {
    const p = Q.topicProgress(t), pct = p.total ? Math.round(p.learned * 100 / p.total) : 0;
    return `<button class="card topic" data-tid="${esc(t.id)}" onclick="openTopic(this.dataset.tid)" aria-label="${esc(t.zh)} ${esc(t.en)}，${p.total} 個字，已學會 ${p.learned} / ${p.total}"><div class="ticon" aria-hidden="true">${esc(t.icon)}</div><h3>${esc(t.zh)} <small>${esc(t.en)}</small></h3><div>${p.total} 個字</div><div class="tbar" aria-hidden="true"><i style="width:${pct}%"></i></div><div class="tprog">${p.learned} / ${p.total} 學會${p.total && p.learned === p.total ? ' 🎉' : ''}</div></button>`; }).join('') + '</div>';
}
function openTopic(id) { tid = id; tOnly = false; render(); }
function vTopic(m, t) {
  const p = Q.topicProgress(t), un = p.chars.filter(c => !c.learned), done = p.total > 0 && !un.length;
  m.innerHTML = `<div class="row"><button class="b" onclick="tid=null;render()">返回主題</button><h2 style="margin:0">${esc(t.icon)} ${esc(t.zh)} <small>${esc(t.en)}</small></h2></div>` +
    `<p><b>${p.learned} / ${p.total} 學會</b>${done ? '　🎉 全部學會了！隨時可以再練習。' : '　按一下字可以聽發音。'}</p>` +
    `<div class="grid">${p.chars.map(c => `<button class="card tchar ${c.learned ? 'learned' : ''}" data-c="${esc(c.id)}" onclick="sayChar(this.dataset.c)" aria-label="${esc(c.c)}，${c.learned ? '已學會' : '未學會'}，按一下聽發音"><div class="han big">${esc(c.c)}</div><div>${esc(c.w)}</div><small>${esc(c.jp)}</small>${c.learned ? ' <span class="g" aria-hidden="true">✓</span>' : ''}</button>`).join('')}</div>` +
    (!done && un.length < p.total ? `<label class="line"><input type="checkbox" ${tOnly ? 'checked' : ''} onchange="tOnly=this.checked;render()" style="width:auto;min-height:0"> <span>只練未學會的字（${un.length} 個）</span></label>` : '') +
    `<div class="row"><button class="b p" ${p.total ? '' : 'disabled'} onclick="startTopic('read')">${done ? '再練習・讀字' : '讀字練習'}</button><button class="b p" ${p.total ? '' : 'disabled'} onclick="startTopic('write')">${done ? '再練習・寫字' : '聽音寫字'}</button></div>`;
}
function sayChar(cid) { const t = tid && CT.topic(tid), c = t && Q.topicProgress(t).chars.find(x => x.id === cid); if (c) { unlockSpeech(); speak(autoText(c)); } }
/* A topic practice is the ordinary practice engine on the topic's shared characters: same questions, marking, results and per-character statistics. */
async function startTopic(kind) {
  unlockSpeech(); const t = tid && CT.topic(tid); if (!t) return;
  const q = Q; let cs = q.topicProgress(t).chars; if (tOnly) { const un = cs.filter(c => !c.learned); if (un.length) cs = un; }
  if (!cs.length) { toast('這個主題暫時沒有字'); return; }
  const r = await q.startSession({ kind, levelId: 'topic:' + t.id, levelName: '主題：' + t.zh, mode: 'practice', chars: cs.map(({ id, c, jp, w, wjp }) => ({ id, c, jp, w, wjp })) });
  if (q !== Q || r.busy) return;
  if (r.duplicate) { toast('這個練習已有未完成的進度，繼續上次的進度'); return resume(r.existing); }
  if (!r.ok) { alert('無法開始練習（' + (reason(r.error) || r.error.message) + '）。'); return; }
  inS = true; res = null; dirty = false; render(); autoSpeak();
}
/* ---------- story reading: a separate reading activity (no records, statistics, mastery or exam results are written) ---------- */
const SDIFF = { 1: '初級', 2: '中級', 3: '高級' };
let sid = null, sPhase = 'read', sPage = 0, sShowJp = false, sShowEn = false, sSel = { diff: null, topic: null }, sBusy = false, sPlaying = -1, sChar = null, sSince = null, sq = null, sLast = null;
const pageSize = st => (st.difficulty === 1 ? 5 : 4), storyPages = st => Math.ceil(st.sentences.length / pageSize(st));
const topicLabel = id => { const p = CQTopics.PACKS.find(x => x.id === id); return p ? `${p.icon} ${p.zh}` : ''; };
const readTime = ms => (ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + ' 秒' : Math.round(ms / 60000) + ' 分鐘');
/* reading time = time the story is on screen and the page visible; saved when leaving, pausing, hiding the page or finishing */
function storyFlush() {
  if (!sid || sSince === null || !Q) return;
  const ms = Math.min(Date.now() - sSince, 10 * 60000); sSince = null;
  return ms > 0 ? Q.updateStory(sid, st => (st.completedAt ? {} : { readMs: st.readMs + ms })) : undefined;
}
function storyResume() { const st = sid && Q && Q.story(sid); if (st && !st.completedAt && sSince === null) sSince = Date.now(); }
function vStories(m) {
  if (sid) return vReader(m);
  const diff = sSel.diff || CQStory.suggestDifficulty(Q.knownGlyphs().size), done = Q.storyList().filter(x => x.completedAt).length;
  m.innerHTML = `<h2>故事閱讀</h2><p><small>用你已經認識的字讀小故事。已讀完 ${done} 個故事。</small></p>` +
    `<div class="card"><h3>新故事</h3><p><small>難度</small></p><div class="seg" role="group" aria-label="難度">${[1, 2, 3].map(d => `<button class="b seg-b ${diff === d ? 'on' : ''}" aria-pressed="${diff === d}" onclick="sSel.diff=${d};render()">${SDIFF[d]}</button>`).join('')}</div>` +
    `<p><small>主題（可以不選）</small></p><div class="row chips" role="group" aria-label="主題"><button class="b chip ${sSel.topic ? '' : 'on'}" aria-pressed="${!sSel.topic}" onclick="sSel.topic=null;render()">不指定</button>` +
    CQTopics.PACKS.map(p => `<button class="b chip ${sSel.topic === p.id ? 'on' : ''}" aria-pressed="${sSel.topic === p.id}" data-t="${esc(p.id)}" onclick="sSel.topic=this.dataset.t;render()">${esc(p.icon)} ${esc(p.zh)}</button>`).join('') + `</div>` +
    `<div class="row"><button class="b p" id="sgen" onclick="newStory()">✨ 產生故事</button></div><div id="smsg"></div></div>` +
    (Q.storyList().length ? `<h3>我的故事</h3>` + Q.storyList().map(st => {
      const P = storyPages(st), status = st.completedAt ? `<span class="g">✓ 已讀完</span> ${fd(st.completedAt)}${st.comprehension ? '・理解題 ' + st.comprehension.score + ' / ' + st.comprehension.total : ''}` : st.startedAt ? `讀到第 ${Math.min(st.page + 1, P)} / ${P} 頁` : '還沒有開始';
      return `<div class="card story"><b class="han">${esc(st.title.zh)}</b> <small>${SDIFF[st.difficulty]}${st.topic ? '・' + esc(topicLabel(st.topic)) : ''}</small><div>${status}</div><div class="row"><button class="b p" data-id="${esc(st.id)}" onclick="openStory(this.dataset.id)">${st.completedAt ? '再讀一次' : st.startedAt ? '繼續閱讀' : '開始閱讀'}</button></div></div>`; }).join('') : '');
}
async function newStory() {
  if (sBusy || !Q) return; sBusy = true; const q = Q; let row;
  try {
    const topicId = sSel.topic, diff = sSel.diff || CQStory.suggestDifficulty(q.knownGlyphs().size);
    if (topicId && !CT.topic(topicId)) await CT.ensureTopics(CQTopics);
    const t = topicId && CT.topic(topicId), topic = t ? { id: t.id, chars: new Set(CT.topicChars(t).map(c => c.c)) } : null;
    const st = CQStory.generate({ known: q.knownGlyphs(), difficulty: diff, topic, recent: q.recentStories(3) });
    row = { id: q.uid(), ...st, createdAt: Date.now(), startedAt: null, completedAt: null, readMs: 0, page: 0, audioUsed: false, comprehension: null };
    const r = await q.saveStory(row); if (q !== Q) return;
    if (!r.ok) { showBar(`<b>故事沒有儲存成功。</b>（${esc(reason(r.error))}）`, 'hideErr'); return; }
  } catch (e) { const el = $('#smsg'); if (el) el.innerHTML = '<p class="warn">暫時未能產生故事，請再試一次。</p>'; return; }
  finally { sBusy = false; }
  hideErr(); await openStory(row.id);
}
async function openStory(id) {
  const q = Q, st = q.story(id); if (!st) return; silence();
  sid = id; sChar = null; sPlaying = -1; sLast = null; sPage = Math.min(st.page, storyPages(st) - 1); sPhase = 'read'; sq = null;
  if (!st.startedAt) { const r = await q.updateStory(id, s => (s.startedAt ? {} : { startedAt: Date.now() })); if (q !== Q) return; if (!r.ok) showBar(`<b>閱讀進度沒有儲存成功。</b>（${esc(reason(r.error))}）`, 'hideErr'); }
  sSince = null; storyResume(); render();
}
function storyBack() { storyFlush(); silence(); sid = null; sPhase = 'read'; sPlaying = -1; sChar = null; render(); }
function vReader(m) {
  const st = Q.story(sid); if (!st) { sid = null; return render(); }
  if (sPhase === 'done') return vStoryDone(m, st); if (sPhase === 'quiz') return vStoryQuiz(m, st); if (sPhase === 'score') return vStoryScore(m, st);
  storyResume();
  const P = storyPages(st), a = sPage * pageSize(st), last = sPage >= P - 1, nw = new Set(st.newChars);
  const tk = (t, i, k) => { if (!t[1]) return `<span class="pn">${esc(t[0])}</span>`;
    return `<span class="tk"><span class="cj">${[...t[0]].map((c, j) => `<span class="ch ${nw.has(c) ? 'nw' : ''} ${sChar && sChar.s === i && sChar.t === k && sChar.k === j ? 'sel' : ''}" data-s="${i}" data-t="${k}" data-k="${j}" onclick="tapChar(event,${i},${k},${j})">${esc(c)}</span>`).join('')}</span><span class="jp">${esc(t[1])}</span></span>`; };
  m.innerHTML = `<div class="bar"><button class="b" onclick="storyBack()">返回故事</button><span class="pg" role="status">第 ${sPage + 1} / ${P} 頁</span></div>` +
    `<div class="tbar" aria-hidden="true"><i style="width:${Math.round((sPage + 1) * 100 / P)}%"></i></div>` +
    `<h2 class="stitle">${esc(st.title.zh)}${sShowEn ? ` <small>${esc(st.title.en)}</small>` : ''}</h2>` +
    `<div class="row sctl"><button class="b p" onclick="playStory()" aria-label="播放全文">▶ 播放全文</button><button class="b" onclick="stopStory()" aria-label="停止">■ 停止</button><button class="b" onclick="replayLast()" aria-label="重播">🔁 重播</button></div>` +
    `<div class="row sopt"><label class="tog"><input type="checkbox" ${sShowJp ? 'checked' : ''} onchange="sShowJp=this.checked;render()"> 粵拼</label><label class="tog"><input type="checkbox" ${sShowEn ? 'checked' : ''} onchange="sShowEn=this.checked;render()"> English</label></div>` +
    `<div class="story ${sShowJp ? 'showjp' : ''} ${sShowEn ? 'showen' : ''}">` + st.sentences.slice(a, a + pageSize(st)).map((sn, o) => { const i = a + o;
      return `<div class="sent ${sPlaying === i ? 'playing' : ''}" data-i="${i}" onclick="playSentence(${i})" role="button" aria-label="播放第 ${i + 1} 句"><span class="tks">${sn.tokens.map((t, k) => tk(t, i, k)).join('')}</span><div class="en">${esc(sn.en)}</div></div>`; }).join('') + `</div>` +
    `<div id="sinfo" class="sinfo" role="status">${charInfo(st)}</div>` +
    `<div class="row snav"><button class="b" ${sPage ? '' : 'disabled'} onclick="storyPage(-1)">上一頁</button>${last ? '<button class="b p" onclick="finishStory()">我讀完了 ✓</button>' : '<button class="b p" onclick="storyPage(1)">下一頁</button>'}</div>`;
}
/* the word (with its meaning) and, when the word has the same number of syllables as characters, the syllable of the tapped character */
function charInfo(st) {
  if (!sChar) return '<small>按一下字可以聽發音，按一下句子可以聽整句。</small>';
  const t = st.sentences[sChar.s] && st.sentences[sChar.s].tokens[sChar.t]; if (!t) return '';
  const c = [...t[0]][sChar.k], syl = t[1] ? t[1].split(' ') : [], one = syl.length === [...t[0]].length ? syl[sChar.k] : '';
  return `<span class="han big">${esc(c)}</span> ${one ? `<b>${esc(one)}</b>` : ''}${[...t[0]].length > 1 ? `　詞語：<span class="han">${esc(t[0])}</span> <small>${esc(t[1] || '')}${t[2] ? '・' + esc(t[2]) : ''}</small>` : (t[2] ? `　<small>${esc(t[2])}</small>` : '')}`;
}
function markAudio() { const st = sid && Q.story(sid); if (st && !st.audioUsed) Q.updateStory(sid, s => (s.audioUsed ? {} : { audioUsed: true })); }
function tapChar(ev, i, k, j) {
  ev.stopPropagation(); const st = Q.story(sid); if (!st) return; sChar = { s: i, t: k, k: j };
  document.querySelectorAll('.ch.sel').forEach(e => e.classList.remove('sel')); ev.currentTarget.classList.add('sel');
  const info = $('#sinfo'); if (info) info.innerHTML = charInfo(st);
  unlockSpeech(); markAudio(); speak([...st.sentences[i].tokens[k][0]][j]);
}
function setPlaying(i) { sPlaying = i; document.querySelectorAll('.sent').forEach(e => e.classList.toggle('playing', +e.dataset.i === i)); }
function playSentence(i) {
  const st = Q.story(sid); if (!st || !st.sentences[i]) return; unlockSpeech(); markAudio(); sLast = i;
  speakList([st.sentences[i].zh], { onStart: () => setPlaying(i), onEnd: () => setPlaying(-1) });
}
function playStory() {
  const st = Q.story(sid); if (!st) return; unlockSpeech(); markAudio();
  speakList(st.sentences.map(x => x.zh), { onStart: j => { sLast = j; const p = Math.floor(j / pageSize(st)); if (p !== sPage) { sPage = p; render(); } setPlaying(j); }, onEnd: () => setPlaying(-1) });
}
function stopStory() { silence(); setPlaying(-1); }
function replayLast() { if (sLast !== null) playSentence(sLast); else playStory(); }
function storyPage(d) {
  const st = Q.story(sid); if (!st) return; sPage = Math.min(Math.max(sPage + d, 0), storyPages(st) - 1); sChar = null;
  if (!st.completedAt) Q.updateStory(sid, s => (s.completedAt ? {} : { page: sPage })); render();
}
async function finishStory() {
  const q = Q, st = q.story(sid); if (!st) return; silence(); await storyFlush();                    // the reading time is saved first, then the completion on top of it
  if (!st.completedAt) { const r = await q.updateStory(sid, s => (s.completedAt ? {} : { completedAt: Date.now(), page: sPage })); if (q !== Q) return; if (!r.ok) { showBar(`<b>閱讀紀錄沒有儲存成功。</b>（${esc(reason(r.error))}）`, 'hideErr'); return; } }
  hideErr(); sPhase = 'done'; sSince = null; sPlaying = -1; render();
}
function vStoryDone(m, st) {
  m.innerHTML = `<div class="stage"><h2>🎉 讀完了！</h2><p class="han big">${esc(st.title.zh)}</p><p>用了 ${readTime(st.readMs || 0)}</p>` +
    (st.newChars.length ? `<p>故事裏的新字：<span class="han">${st.newChars.map(esc).join(' ')}</span></p>` : '<p>故事裏的字你都認識！</p>') +
    `<div class="row">${st.questions.length ? '<button class="b p" onclick="startQuiz()">試試理解題</button>' : ''}<button class="b" data-id="${esc(st.id)}" onclick="openStory(this.dataset.id)">再讀一次</button><button class="b" onclick="storyBack()">返回故事</button></div></div>`;
}
/* optional comprehension questions: only after reading, immediate feedback, a final score; kept apart from the exam system */
function startQuiz() { sq = { i: 0, picked: null, correct: 0 }; sPhase = 'quiz'; render(); }
function vStoryQuiz(m, st) {
  const q = st.questions[sq.i], n = st.questions.length, p = sq.picked;
  m.innerHTML = `<div class="bar"><span class="pg" role="status">理解題 ${sq.i + 1} / ${n}</span></div><div class="stage"><p class="han big qtext">${esc(q.zh)}</p><button class="b spk" onclick="speak(Q.story(sid).questions[sq.i].zh)" aria-label="讀出問題">🔊</button>` +
    `<div class="qopts">${q.options.map((o, i) => `<button class="b qopt ${p === null ? '' : i === q.answer ? 'right' : i === p ? 'wrong' : ''}" ${p === null ? '' : 'disabled'} onclick="pickAns(${i})">${esc(o)}</button>`).join('')}</div>` +
    (p === null ? '' : `<p class="${p === q.answer ? 'g' : 'warn'}" role="status"><b>${p === q.answer ? '答對了！👏' : '再想想！正確答案是「' + esc(q.options[q.answer]) + '」'}</b></p><div class="row"><button class="b p" onclick="nextQ()">${sq.i + 1 < n ? '下一題' : '看分數'}</button></div>`) + `</div>`;
}
function pickAns(i) { const st = Q.story(sid); if (!st || !sq || sq.picked !== null) return; sq.picked = i; if (i === st.questions[sq.i].answer) sq.correct++; render(); }
async function nextQ() {
  const q = Q, st = q.story(sid); if (!st || !sq) return;
  if (sq.i + 1 < st.questions.length) { sq.i++; sq.picked = null; render(); return; }
  const r = await q.updateStory(sid, () => ({ comprehension: { score: sq.correct, total: st.questions.length } })); if (q !== Q) return;
  if (!r.ok) showBar(`<b>分數沒有儲存成功。</b>（${esc(reason(r.error))}）`, 'hideErr'); sPhase = 'score'; render();
}
function vStoryScore(m, st) {
  const c = st.comprehension || { score: sq ? sq.correct : 0, total: st.questions.length };
  m.innerHTML = `<div class="stage"><h2>理解題分數</h2><p class="han big">${c.score} / ${c.total}</p><p>${c.score === c.total ? '全部答對！🌟' : '很好，再讀一次故事會更清楚！'}</p><div class="row"><button class="b" data-id="${esc(st.id)}" onclick="openStory(this.dataset.id)">再讀一次故事</button><button class="b" onclick="startQuiz()">再做一次</button><button class="b p" onclick="storyBack()">返回故事</button></div></div>`;
}

/* ---------- session ---------- */
function sess(m) {
  if (res) return result(m);
  const s = Q.cur; if (!s) { inS = false; return render(); }
  if (s.phase === 'mark') return marking(m, s);
  const it = s.items[s.i], n = s.items.length;
  Q.qStart(s.id + ':' + s.i);                                  // response time of this question (idempotent on rerender; paused when leaving/hidden)
  const head = `<div class="bar"><span class="row" style="gap:14px;flex-wrap:nowrap"><button class="b endb" onclick="askEnd()" aria-label="提早結束，結束後不能再繼續">結束</button><span>${s.i + 1} / ${n}</span></span><button class="b" onclick="leave()" aria-label="暫停並離開，進度會保留">⏸ 暫停（保留進度）</button></div>`;
  if (s.kind === 'read') {
    m.innerHTML = head + `<div class="stage"><div class="big han">${esc(it.c)}</div><div class="row"><button class="b r" style="min-width:150px;min-height:72px" onclick="mark(false)">錯誤</button><button class="b p" style="min-width:150px;min-height:72px" onclick="mark(true)">正確</button></div></div>`; return;
  }
  m.innerHTML = head + `<div class="stage"><div class="row"><button class="b spk" onclick="say('c')" aria-label="單字發音">🔊 單字</button><button class="b spk" onclick="say('w')" ${it.w ? '' : 'disabled'} aria-label="詞語發音">🔊 詞語</button></div>` +
    (s.mode === 'exam' ? '' : `<div class="row"><button class="b" id="rv" onclick="rev()">顯示答案</button><span id="ans" class="han ans"></span></div>`) +
    `<canvas id="cv" width="640" height="640"></canvas><div class="row"><button class="b" id="clrbtn" onclick="clr()">清除</button><button class="b p" onclick="done()">${s.i + 1 < n ? '下一題' : '完成'}</button></div></div>`;
  initCv();
}
async function leave() {
  if (!(await safeToLeave())) return;
  silence(); Q.qPause(); hideErr(); inS = false; dirty = false; render(); toast('進度和筆跡已保留，可以稍後繼續');
}
async function mark(ok) { const q = Q; after(await q.answerRead(ok), '這一題的答案', q); }
function say(k) { const it = Q.cur.items[Q.cur.i]; speak(k === 'w' ? it.w : it.c); }
/* Speak ONE utterance (zh-HK voice when available). cancel() first: never two voices at once. silence() stops speech when leaving a question.
   quiet = automatic speech: never show messages, never throw. */
function silence() { listTok++; try { const ss = window.speechSynthesis; if (ss) ss.cancel(); } catch (e) { } }
/* the speech service with a Cantonese voice if there is one (quiet = never show messages) */
function ttsStart(quiet) {
  const ss = window.speechSynthesis; if (!ss || !window.SpeechSynthesisUtterance) { if (!quiet) toast('這部裝置不支援語音'); return null; }
  const v = ss.getVoices().find(x => /zh[-_]HK|yue/i.test(x.lang)); if (!v && !quiet) toast('找不到廣東話語音，發音可能不準確');
  return { ss, v };
}
const utt = (t, v) => { const u = new SpeechSynthesisUtterance(t); u.lang = 'zh-HK'; if (v) u.voice = v; u.rate = .8; return u; };
function speak(t, quiet) {
  if (!t) return; const x = ttsStart(quiet); if (!x) return;
  try { x.ss.cancel(); x.ss.speak(utt(t, x.v)); } catch (e) { if (!quiet) toast('無法播放語音'); }
}
/* Several phrases in a row (a story): all queued at once, so the speech service plays them back to back with no timers and no gaps of our own.
   onStart(i) fires as phrase i begins (to highlight it), onEnd() when the last one ends or fails. A newer call or silence() makes older callbacks harmless. */
let listTok = 0;
function speakList(parts, h) {
  parts = parts.filter(Boolean); if (!parts.length) return false;
  const x = ttsStart(false); if (!x) return false; const my = ++listTok;
  try {
    x.ss.cancel();
    parts.forEach((t, i) => { const u = utt(t, x.v); u.onstart = () => { if (listTok === my && h && h.onStart) h.onStart(i); };
      u.onend = u.onerror = () => { if (listTok === my && i === parts.length - 1 && h && h.onEnd) h.onEnd(); }; x.ss.speak(u); });
    return true;
  } catch (e) { toast('無法播放語音'); return false; }
}
/* iOS only allows speech that was started from a tap: prime it synchronously inside the tap handler, before any await. */
function unlockSpeech() {
  try { const ss = window.speechSynthesis; if (!speechUnlocked && ss && window.SpeechSynthesisUtterance) { const u = new SpeechSynthesisUtterance(''); u.volume = 0; ss.speak(u); speechUnlocked = true; } } catch (e) { }
}
/* Automatic pronunciation: ONE utterance, "character。word嘅character" (e.g. 左。左右嘅左); the full stop gives the natural pause, so no second
   utterance and no timers are needed. Only the character if the existing data has no valid compound word. Nothing is shown on screen.
   Called only when a question is newly entered (session start / after an answer advanced), never from render or resume, and remembered per session+question. */
const autoText = it => it.c + (it.w && it.w !== it.c ? '。' + it.w + '嘅' + it.c : '');
function autoSpeak() {
  const s = Q && Q.cur; if (!s || s.kind !== 'write' || s.phase !== 'ask' || corrId) return;
  const key = s.id + ':' + s.i; if (autoKey === key) return; autoKey = key;
  speak(autoText(s.items[s.i]), true);
}
function rev() { const a = $('#ans'), b = $('#rv'); if (a.textContent) { a.textContent = ''; b.textContent = '顯示答案'; } else { a.textContent = Q.cur.items[Q.cur.i].c; b.textContent = '隱藏答案'; } }
function initCv() {
  cv = $('#cv'); cx = cv.getContext('2d'); cx.lineWidth = 10; cx.lineCap = cx.lineJoin = 'round'; cx.strokeStyle = '#111'; clr(true);
  const pt = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * 640 / r.width, (e.clientY - r.top) * 640 / r.height]; };
  cv.onpointerdown = e => { e.preventDefault(); cv.setPointerCapture(e.pointerId); drawing = true; dirty = true; const [x, y] = pt(e); cx.beginPath(); cx.moveTo(x, y); cx.lineTo(x + .01, y); cx.stroke(); cx.beginPath(); cx.moveTo(x, y); };
  cv.onpointermove = e => { if (!drawing) return; e.preventDefault(); const [x, y] = pt(e); cx.lineTo(x, y); cx.stroke(); cx.beginPath(); cx.moveTo(x, y); };
  cv.onpointerup = cv.onpointercancel = () => { if (!drawing) return; drawing = false; Q.scheduleDraft(draftData); };
  restoreDraft();
}
const draftData = () => (dirty ? snap() : null);   // evaluated when the autosave actually runs
function clr(silent) { cx.fillStyle = '#fff'; cx.fillRect(0, 0, 640, 640); dirty = false; if (silent !== true) Q.scheduleDraft(draftData, { immediate: true }); }
async function restoreDraft() {
  const s = Q.cur; if (!s) return; const sid = s.id, i = s.i, c = cv; let d;
  try { d = await Q.loadDraft(); } catch (e) { return; }
  if (!d || !d.data || dirty || !Q.cur || Q.cur.id !== sid || Q.cur.i !== i || cv !== c) return;
  const img = new Image();
  img.onload = () => { if (dirty || cv !== c) return; cx.drawImage(img, 0, 0, 640, 640); dirty = true; };
  img.src = d.data;
}
function snap() { const t = document.createElement('canvas'); t.width = t.height = 360; t.getContext('2d').drawImage(cv, 0, 0, 360, 360); return t.toDataURL('image/jpeg', .75); }
async function done() {
  const q = Q; if (q.busy) return; unlockSpeech();
  if (!dirty && !confirm('還沒有寫字，確定完成這一題？')) return;
  const r = await q.answerWrite(snap());   // canvas is NOT cleared; it is only replaced after a confirmed save
  if (q !== Q) return;
  if (r.ok) dirty = false;
  after(r, '這一題的手寫答案', q);
}
/* Parent marking of a writing session: ONE answer at a time (progress n / total), large character and handwriting, large 正確 / 錯誤 buttons.
   Marking saves that answer only and moves on; the learner can go back and change any mark; the result is built only when "完成評分" is pressed
   with every answer marked. mkIdx === n is the final review step. */
let mkIdx = null, mkBusy = false;
function marking(m, s) {
  const n = s.items.length, un = s.items.filter(x => x.ok === null).length;
  if (mkIdx === null) { const f = s.items.findIndex(x => x.ok === null); mkIdx = f < 0 ? n : f; }   // (re)start at the first unmarked answer
  mkIdx = Math.min(Math.max(mkIdx, 0), n);
  const bar = `<div class="bar"><h2>家長評分</h2><button class="b" onclick="leave()" aria-label="暫停並離開，進度會保留">⏸ 暫停（保留進度）</button></div>` + (s.endedEarly ? `<p><small>已提早結束：只評分已作答的 ${n} / ${s.planned || n} 題，沒有作答的題目不會計算。</small></p>` : '');
  if (mkIdx >= n) {
    m.innerHTML = bar + `<div class="stage mkone"><div class="mkprog" role="status">${n - un} / ${n} 題已評分</div>` +
      `<div class="grid">${s.items.map((it, k) => `<button class="b mkchip ${it.ok === true ? 'p' : it.ok === false ? 'r' : ''}" onclick="goMk(${k})" aria-label="第 ${k + 1} 題，${it.ok === true ? '正確' : it.ok === false ? '錯誤' : '未評分'}"><span class="han">${esc(it.c)}</span> ${it.ok === true ? '✓' : it.ok === false ? '✗' : '－'}</button>`).join('')}</div>` +
      (un ? `<p class="warn">還有 ${un} 題未評分</p><div class="row"><button class="b p" onclick="goMk(${s.items.findIndex(x => x.ok === null)})">去評分未評分的題目</button></div>`
          : `<p class="g">全部評分完成。按一下字可以修改評分。</p>`) +
      `<div class="row"><button class="b" onclick="goMk(${n - 1})">上一題</button><button class="b p" ${un ? 'disabled' : ''} onclick="finish()">完成評分</button></div></div>`;
    return;
  }
  const it = s.items[mkIdx];
  m.innerHTML = bar + `<div class="stage mkone"><div class="mkprog" role="status">${mkIdx + 1} / ${n}</div>` +
    `<div class="han" style="font-size:min(26vw,16vh,150px);line-height:1.1">${esc(it.c)}</div><div class="han mid">${esc(it.w)} <small>${esc(it.wjp)}</small></div>` +
    (it.imgId ? `<img class="mkimg" data-img="${esc(it.imgId)}" alt="學習者的手寫答案">` : '<div class="warn">沒有手寫圖片</div>') +
    `<div class="row mkrow"><button class="b r ${it.ok === false ? 'on' : ''}" onclick="markOne(false)">錯誤</button><button class="b p ${it.ok === true ? 'on' : ''}" onclick="markOne(true)">正確</button></div>` +
    `<div class="row"><button class="b" ${mkIdx ? '' : 'disabled'} onclick="goMk(${mkIdx - 1})">上一題</button><button class="b" ${it.ok === null ? 'disabled' : ''} onclick="goMk(${mkIdx + 1})">下一題</button></div></div>`;
}
function goMk(k) { mkIdx = k; render(); }
/* mark the shown answer, then go to the next one (the last one leads to the review step). mkBusy only ignores a second tap while this answer is being
   saved; it is released BEFORE the next question is rendered, and the rendering never depends on it, so every question starts with usable buttons. */
async function markOne(v) {
  if (mkBusy || !Q || !Q.cur || Q.cur.phase !== 'mark') return;
  const q = Q, k = mkIdx; let r; mkBusy = true;
  try { r = await q.setOk(k, v); } finally { mkBusy = false; }
  if (q !== Q || r.busy) return; if (!r.ok) { after(r, '評分', q); return; }
  hideErr(); mkIdx = k + 1; render();
}
/* End the session early: always confirmed. "繼續" (the default and the larger target) returns to the question; ending is separate from the pause button. */
let endBusy = false;
function askEnd() {
  const s = Q && Q.cur; if (!s || s.phase !== 'ask' || !inS || document.querySelector('.modal')) return;
  const n = s.items.length, done = s.i, d = document.createElement('div'); d.className = 'modal'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-labelledby', 'endt');
  d.innerHTML = `<div class="card" style="width:min(480px,100%)"><h3 id="endt">提早結束這次${LB(s)}？</h3><p>已完成 ${done} / ${n} 題。</p>` +
    `<p><b>結束後，這次${LB(s)}不能再繼續。</b>沒有作答的 ${n - done} 題不會計算，也不算錯。</p>` +
    (done ? (s.kind === 'write' ? '<p>已作答的題目會進入家長評分。</p>' : '<p>會顯示已完成題目的結果。</p>') : '<p class="warn">還沒有完成任何一題，結束後不會留下紀錄。</p>') +
    `<p><small>只是想休息一下？請按「繼續」，再用「暫停」保留進度。</small></p><div class="row"><button class="b p" id="endno" style="flex:2;min-height:64px">繼續</button><button class="b r" id="endyes" style="flex:1;min-height:64px">結束</button></div></div>`;
  d.onkeydown = e => { if (e.key === 'Escape') d.remove(); };
  document.body.appendChild(d); d.querySelector('#endno').onclick = () => d.remove(); d.querySelector('#endyes').onclick = () => { d.remove(); endNow(); }; d.querySelector('#endno').focus();
}
async function endNow() {
  if (endBusy || !Q || !Q.cur || Q.cur.phase !== 'ask') return;
  endBusy = true; const q = Q; silence();
  try {
    const r = await q.endEarly(); if (q !== Q || r.busy) return;
    if (!r.ok) { after(r, '提早結束', q); return; }
    mkIdx = null; dirty = false; hideErr();
    if (!q.cur && !q.result) { inS = false; res = null; render(); toast('沒有完成任何一題，所以沒有留下紀錄'); return; }
    after(r, '提早結束', q);                                         // reading: the result; writing: the parent marking of the answered questions
  } finally { endBusy = false; }
}
async function setOk(k, v) { const q = Q; after(await q.setOk(k, v), '評分', q); }
async function finish() { const q = Q; mkIdx = null; after(await q.finishMarking(), '評分結果', q); }
function agg(rs) { let t = 0, o = 0; rs.forEach(r => r.items.forEach(x => { t++; if (x.ok) o++; })); return { t, o, p: t ? Math.round(o / t * 100) : 0 }; }
function freq(rs) { const m = {}; rs.forEach(r => r.items.forEach(x => { if (!x.ok) m[x.c] = (m[x.c] || 0) + 1; })); return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8); }
const durText = r => CQCore.durationOf(r) || '未有資料';
function corrButton(r) {
  const c = Q.correctionFor(r.id); if (!c) return '';
  return c.state === 'done' ? '<span class="g"><b>已完成寫五次練習</b></span>' : `<button class="b p" onclick="openCorrection('${c.id}')">寫五次練習（${c.items.length} 個字）</button>`;
}
function result(m) {
  const r = res, a = agg([r]), bad = r.items.filter(x => !x.ok);
  m.innerHTML = `<h2>${LB(r)}結果</h2><div class="card"><div class="line"><span>級別</span><b>${esc(r.levelName)}</b></div><div class="line"><span>類型</span><b>${LB(r)}</b></div><div class="line"><span>用時</span><b>${durText(r)}</b></div><div class="line"><span>題數</span><b>${a.t}</b></div>${r.endedEarly ? `<div class="line"><span>完成</span><b>${a.t} / ${r.planned || a.t} 題（提早結束）</b></div>` : ''}<div class="line"><span>正確</span><b class="g">${a.o}</b></div><div class="line"><span>錯誤</span><b class="rd">${a.t - a.o}</b></div><div class="line"><span>準確率</span><b>${a.p}%</b></div></div>` +
    (bad.length ? `<div class="card"><h3>錯誤的字</h3><div class="han mid">${bad.map(x => esc(x.c)).join(' ')}</div></div>` : '<p class="g"><b>全部正確！</b></p>') +
    examSummary(r) +
    `<div class="row">${corrButton(r)}${bad.length ? `<button class="b p" onclick="revise()">重新溫習</button>` : ''}<button class="b" onclick="go('${String(r.levelId).startsWith('topic:') ? 'topics' : r.mode === 'exam' ? 'exam' : 'practice'}')">返回</button></div>`;
}
/* Exam only: where this exam's characters stand now (after the statistics were updated): needs more practice / improving / mastered. */
function examSummary(r) {
  if (r.mode !== 'exam') return '';
  const g = { needs: [], improving: [], mastered: [] };
  r.items.forEach(x => { const st = Q.statusOf(r.kind, x.cid); if (g[st]) g[st].push(x.c); });
  const row = (t, a) => a.length ? `<div class="line"><span>${t}</span><span class="han">${a.map(esc).join(' ')}</span></div>` : '';
  const h = row('需要多練習', g.needs) + row('進步中', g.improving) + row('已掌握', g.mastered);
  return h ? `<div class="card"><h3>學習進度</h3>${h}</div>` : '';
}
async function revise() {
  unlockSpeech();
  const q = Q, r = res, rr = await q.startSession({ kind: r.kind, levelId: r.levelId, levelName: r.levelName, mode: 'revision', parentId: r.id, chars: r.items.filter(x => !x.ok).map(x => ({ id: x.cid, c: x.c, jp: x.jp, w: x.w, wjp: x.wjp })) });
  if (q !== Q || rr.busy) return;
  if (rr.duplicate) { toast('這次溫習已有未完成的進度，繼續上次的進度'); return resume(rr.existing); }
  if (!rr.ok) { alert('無法開始溫習（' + reason(rr.error) + '）。'); return; }
  res = null; inS = true; dirty = false; render(); autoSpeak();
}
/* ---------- history ---------- */
function vHist(m) {
  if (rid) { const r = Q.records.find(x => x.id === rid); if (r) {
    m.innerHTML = `<button class="b" onclick="rid=null;render()">返回</button><h2>${LB(r)}・${esc(r.levelName)}</h2><p>${fd(r.date)}　用時 ${durText(r)}${r.parentId ? '（溫習）' : ''}${r.endedEarly ? `（提早結束：${r.items.length} / ${r.planned || r.items.length} 題）` : ''}</p><div class="grid">` + r.items.map(x => `<div class="card"><div class="han mid">${esc(x.c)}</div><div>${esc(x.w)}</div><b class="${x.ok ? 'g' : 'rd'}">${x.ok ? '正確' : '錯誤'}</b>${x.imgId ? `<img data-img="${esc(x.imgId)}" alt="">` : ''}</div>`).join('') + '</div>'; return; } }
  const ids = [...new Set([...Q.levels.filter(l => !l.hidden).map(l => l.id), ...Q.records.map(r => r.levelId)])];
  m.innerHTML = '<h2>學習紀錄</h2>' + (ids.map(id => {
    const rs = Q.records.filter(r => r.levelId === id), nm = lv(id) ? lv(id).name : (rs[0] ? rs[0].levelName : '');
    const blocks = ['read', 'write'].map(k => { const kr = rs.filter(r => r.kind === k), a = agg(kr), f = freq(kr);
      return `<div class="card"><h4>${k === 'read' ? '讀字' : '寫字'}　${a.t ? a.o + ' / ' + a.t + '（' + a.p + '%）' : '未有紀錄'}</h4>` +
        ['practice', 'revision', 'exam'].map(md => { const x = kr.filter(r => r.mode === md), g = agg(x); return `<div class="line"><span>${NAME[k][md]}</span><span>${x.length} 次　${g.t ? g.p + '%' : '—'}</span></div>`; }).join('') +
        (f.length ? `<p>常錯：${f.map(([c, n]) => `<span class="han">${esc(c)}</span>×${n}`).join('　')}</p>` : '') + '</div>'; }).join('');
    const list = rs.slice().reverse().slice(0, 10).map(r => { const a = agg([r]); return `<button class="b line" onclick="rid='${r.id}';render()"><span>${fd(r.date)}　${LB(r)}${r.endedEarly ? '・提早結束' : ''}</span><span>${a.o}/${a.t}（${a.p}%）</span></button>`; }).join('');
    return `<h3>${esc(nm)}</h3><div class="grid">${blocks}</div>${list ? `<div class="card">${list}</div>` : ''}`; }).join('') || '<p>還沒有紀錄。</p>');
}
/* ---------- settings: backup ---------- */
function vSet(m) {
  m.innerHTML = `<h2>設定</h2><div class="card"><h3>學習者：${AV(profile.avatar)} ${esc(profile.name)}</h3><div class="row"><button class="b p" onclick="switchLearner()">切換學習者</button><button class="b" onclick="manageLearners()">管理學習者</button></div></div><div class="card"><h3>安裝到主畫面</h3><p><small>iPad／iPhone：在 Safari 按「分享」，再選「加入主畫面」。Android／Chrome：選單 →「安裝應用程式」。安裝後，打開過一次的應用程式可以在沒有網絡時使用，所有資料都儲存在這部裝置上。</small></p></div><div class="card"><h3>內容與備份</h3><p><small>學習內容（級別和字）由所有學習者共用；學習進度屬於各自的學習者。可以分開匯出和匯入。</small></p><div class="row"><button class="b p" onclick="openBackup()">開啟</button></div></div>`;
}
/* ---------- content & backup (shared content and per-learner progress are separate; works with or without a learner) ---------- */
const list = (a, n) => a.slice(0, n).map(x => `<li>${esc(x)}</li>`).join('') + (a.length > n ? `<li>…還有 ${a.length - n} 項</li>` : '');
async function openBackup() { bk = null; if (Q) { await go('backup'); } else { pview = 'backup'; render(); } }
function bkBack() { bk = null; if (Q) go('set'); else { pview = 'pick'; render(); } }
function vBackup(m) {
  Promise.all([mgr.list('all'), CT.load()]).then(([ps]) => {
    if ((Q ? tab !== 'backup' : pview !== 'backup')) return;
    const nL = CT.levels.length, nC = CT.levels.reduce((n, l) => n + l.chars.length, 0);
    m.innerHTML = `<div class="row"><button class="b" onclick="bkBack()">返回</button><h2 style="margin:0">內容與備份</h2></div>` +
      `<div class="card"><h3>匯出</h3><p><small>學習內容只會匯出一次；學習進度按學習者分開匯出。沒有學習者也可以匯出學習內容。</small></p>` +
      `<label class="line"><input type="checkbox" id="xc" checked style="width:auto;min-height:0"> <span>學習內容（${nL} 個級別、${nC} 個字）</span></label>` +
      ps.map(p => `<label class="line"><input type="checkbox" class="xp" value="${esc(p.id)}" ${p.archivedAt ? '' : 'checked'} style="width:auto;min-height:0"> <span>${AV(p.avatar)} ${esc(p.name)} 的學習進度${p.archivedAt ? '（已封存）' : ''}</span></label>`).join('') +
      `<div class="row"><button class="b p" onclick="bkExport()">匯出</button></div><div id="emsg"></div></div>` +
      `<div class="card"><h3>匯入</h3><p><small>先選擇檔案，再決定要匯入的內容和進度。舊版備份檔也可以匯入。</small></p><input type="file" id="fi" accept=".json,application/json"><div id="imsg">${bk ? bkOptions(ps) : ''}</div></div>`;
    $('#fi').onchange = e => { if (e.target.files[0]) bkLoad(e.target.files[0]); e.target.value = ''; };
  }).catch(e => { m.innerHTML = `<p class="warn">無法讀取資料（${esc(reason(e))}）。</p>`; });
}
async function bkExport() {
  try {
    const ids = [...document.querySelectorAll('.xp:checked')].map(x => x.value), withContent = $('#xc').checked;
    if (!withContent && !ids.length) { $('#emsg').innerHTML = '<span class="warn">請至少選擇一項要匯出的資料。</span>'; return; }
    const { json, missingImages } = await CQBackup.buildExport(mgr, CT, { includeContent: withContent, profileIds: ids, getQuiz: id => (Q && profile && profile.id === id ? Q : null) });
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(json)], { type: 'application/json' }));
    a.download = '識字備份-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); a.remove();
    $('#emsg').innerHTML = missingImages ? `<span class="warn">有 ${missingImages} 張手寫圖片找不到，備份中沒有包括這些圖片。</span>` : '<span class="g">已匯出。</span>';
  } catch (e) { $('#emsg').innerHTML = `<span class="warn">匯出失敗（${esc(reason(e))}）。</span>`; }
}
async function bkLoad(f) {
  const msg = $('#imsg'); let json, parsed;
  try { json = JSON.parse(await f.text()); } catch (e) { msg.innerHTML = '<p class="warn">匯入失敗：檔案已損毀或格式不正確。現有資料沒有改動。</p>'; return; }
  try { parsed = CQBackup.parse(json); } catch (e) { msg.innerHTML = e.list ? `<p class="warn">匯入失敗，現有資料沒有改動：</p><ul class="warn">${list(e.list, 10)}</ul>` : `<p class="warn">匯入失敗（${esc(reason(e))}）。現有資料沒有改動。</p>`; return; }
  if (!parsed.content && !parsed.profiles.length) { msg.innerHTML = '<p class="warn">這個備份沒有可以匯入的內容或進度。</p>'; return; }
  const ps = await mgr.list('all');
  bk = { parsed, content: parsed.content ? 'merge' : 'skip', targets: CQBackup.suggestTargets(parsed, ps) }; msg.innerHTML = bkOptions(ps);
}
function bkOptions(ps) {
  const P = bk.parsed, nC = P.content ? P.content.reduce((n, l) => n + l.chars.length, 0) : 0;
  let h = '';
  if (P.content) h += `<div class="card"><h3>學習內容</h3><p>備份中有 ${P.content.length} 個級別、${nC} 個字。匯入後所有學習者（包括之後新增的）都會使用。</p>` +
    [['merge', '合併（保留現有內容，只加入新的）'], ['replace', '取代現有的學習內容'], ['skip', '不匯入學習內容']].map(([v, t]) => `<label class="line"><input type="radio" name="bc" value="${v}" ${bk.content === v ? 'checked' : ''} onchange="bk.content=this.value" style="width:auto;min-height:0"> <span>${t}</span></label>`).join('') + '</div>';
  if (P.profiles.length) h += `<div class="card"><h3>學習進度</h3><p><small>每位學習者的進度只會匯入到你選擇的學習者；預設只匯入編號相同的學習者，其他的會略過。</small></p>` +
    P.profiles.map((p, i) => { const s = p.summary, t = bk.targets[i], matched = p.profileId && ps.some(l => l.id === p.profileId);
      return `<div class="card"><b>${p.legacy ? '舊版備份中的學習進度' : esc(p.profileName)}</b> <small>（${s.records} 筆紀錄${s.corrections ? '、' + s.corrections + ' 個寫五次練習' : ''}${s.sessions ? '、' + s.sessions + ' 個未完成的測驗' : ''}）${matched ? '・本機有相同編號的學習者' : p.legacy ? '・舊版檔案沒有記錄屬於哪位學習者' : '・本機沒有這位學習者'}</small>` +
        `<select onchange="bk.targets[${i}]=this.value" aria-label="匯入到">` + `<option value="skip" ${t === 'skip' ? 'selected' : ''}>略過（不匯入進度）</option>` +
        ps.map(l => `<option value="p:${esc(l.id)}" ${t === 'p:' + l.id ? 'selected' : ''}>匯入到「${esc(l.name)}」</option>`).join('') + `<option value="new" ${t === 'new' ? 'selected' : ''}>新增學習者${p.legacy ? '' : '「' + esc(p.profileName) + '」'}並匯入</option></select></div>`; }).join('') + '</div>';
  return h + `<div class="row"><button class="b p" onclick="bkRun()">開始匯入</button><button class="b" onclick="bk=null;render()">取消</button></div>`;
}
async function bkRun() {
  const msg = $('#imsg'), b = bk; if (!b) return;
  if (b.content === 'replace' && !confirm('這會取代所有學習者共用的學習內容（級別和字）。學習進度不會被刪除。建議先匯出目前的資料。確定要取代嗎？')) return;
  let r;
  try { r = await CQBackup.apply(mgr, CT, b.parsed, { content: b.content, targets: b.targets, getQuiz: id => (Q && profile && profile.id === id ? Q : null) }); }
  catch (e) { msg.innerHTML = e.list ? `<p class="warn">匯入失敗，現有資料沒有改動：</p><ul class="warn">${list(e.list, 10)}</ul>` : `<p class="warn">匯入失敗（${esc(reason(e))}）。</p>`; return; }
  bk = null;
  if (r.aborted) { msg.innerHTML = `<p class="warn">沒有匯入任何資料：學習內容發現 ${r.content.conflicts.length} 項衝突，現有資料沒有改動。</p><ul class="warn">${list(r.content.conflicts, 10)}</ul><p><small>可以選擇「取代現有的學習內容」或「不匯入學習內容」後再試。</small></p>`; return; }
  const c = r.content, ST = { imported: '已匯入', aborted: '沒有匯入（有衝突）', failed: '匯入失敗', skipped: '已略過' };
  let h = c.status === 'skipped' ? '' : `<p class="g">學習內容${c.status === 'replaced' ? '已取代' : '已合併'}：${c.added.levels} 個級別、${c.added.chars} 個字${c.identical ? `（${c.identical} 項已存在，已略過）` : ''}。所有學習者都可以使用。</p>`;
  h += r.profiles.map(p => `<p class="${p.status === 'imported' ? 'g' : p.status === 'skipped' ? '' : 'warn'}"><b>${esc(p.name)}</b>：${ST[p.status]}${p.created ? '（已新增學習者）' : ''}${p.status === 'imported' ? `（新增紀錄 ${p.added.records}${p.added.sessions ? '、未完成的測驗 ' + p.added.sessions : ''}${p.added.corrections ? '、寫五次練習 ' + p.added.corrections : ''}${p.identical ? '；' + p.identical + ' 項已存在' : ''}）` : ''}${p.error ? '（' + esc(p.error) + '）' : ''}</p>` +
    (p.conflicts && p.conflicts.length ? `<ul class="warn">${list(p.conflicts, 6)}</ul>` : '') + (p.warnings && p.warnings.length ? `<ul class="warn">${list(p.warnings, 6)}</ul>` : '')).join('');
  msg.innerHTML = h || '<p>沒有匯入任何資料。</p>';
}
/* ---------- startup ---------- */
function fatal(title, detail, legacy) {
  $('#nav').innerHTML = '';
  $('#main').innerHTML = `<div class="card"><h2>${esc(title)}</h2><p>${detail}</p><div class="row"><button class="b p" onclick="location.reload()">重試</button>${legacy ? '<button class="b" onclick="dumpLegacy()">下載原有資料（備份）</button>' : ''}</div></div>`;
}
function dumpLegacy() {
  try { const raw = localStorage.getItem(CQStorage.LEGACY_KEY); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([raw], { type: 'application/json' })); a.download = '識字原有資料.json'; document.body.appendChild(a); a.click(); a.remove(); } catch (e) { alert('無法讀取原有資料。'); }
}
/* ---------- writing correction: five separate attempts for every wrongly written character ---------- */
function openCorrection(id) {
  const c = Q.correction(id); if (!c) return;
  const i = c.items.findIndex(x => !CQCore.attemptsDone(x));
  corrId = id; corrIdx = i < 0 ? 0 : i; corrSum = c.state === 'done'; cFeed = ''; cmIdx = null; inS = false; res = null; hideErr(); render();
}
/* Writing correction of one character, in two phases. WRITING: five separate attempts, each on its own large canvas, submitted one by one; nothing can
   be marked yet. MARKING (only after the fifth is submitted): the five saved writings are marked one at a time (correct / incorrect, changeable), then the
   set is finished: all five correct = the character is done; any incorrect = counting restarts at 0 and a completely new set of five is written.
   The app never judges handwriting itself, and the original result is never touched. */
let cFeed = '', cBusy = false, ccv = null, cmIdx = null;
function vCorrection(m) {
  const c = Q.correction(corrId); if (!c) { corrId = null; return render(); }
  if (corrSum || c.state === 'done') {
    const n = c.items.length;
    m.innerHTML = `<h2>寫五次練習完成</h2><div class="card"><div class="line"><span>級別</span><b>${esc(c.levelName)}</b></div><div class="line"><span>字數</span><b>${n}</b></div><div class="line"><span>已完成</span><b class="g">${n * 5} / ${n * 5}</b></div></div><div class="card"><div class="han mid">${c.items.map(x => esc(x.c)).join(' ')}</div></div><div class="row"><button class="b p" onclick="leaveCorr()">返回</button></div>`;
    return;
  }
  if (CQCore.attemptsDone(c.items[corrIdx])) { const nx = c.items.findIndex(x => !CQCore.attemptsDone(x)); if (nx < 0) { finishCorr(); return; } corrIdx = nx; cmIdx = null; }
  const it = c.items[corrIdx], n = c.items.length, ph = CQCore.itemPhase(it), total = CQCore.correctionPosition(c).saved;
  const head = `<div class="bar"><span id="cprog">第 ${corrIdx + 1} / ${n} 個字　總進度 ${total} / ${n * 5}</span><button class="b" onclick="leaveCorr()" aria-label="暫停並離開，進度會保留">⏸ 暫停（保留進度）</button></div>`;
  const target = `<div class="row"><div class="han" style="font-size:min(${ph === 'write' ? '22vw,14vh,130px' : '16vw,10vh,96px'});line-height:1">${esc(it.c)}</div><div>${it.w ? `<div class="han mid">${esc(it.w)}${it.wjp ? ` <small>${esc(it.wjp)}</small>` : ''}</div>` : ''}` +
    `<div class="row"><button class="b spk" onclick="sayC('c')" aria-label="單字發音">🔊 單字</button>${it.w ? '<button class="b spk" onclick="sayC(\'w\')" aria-label="詞語發音">🔊 詞語</button>' : ''}</div></div></div>`;
  if (ph === 'write') {
    const k = it.attempts.filter(Boolean).length;                                      // submitted so far; the attempt on the canvas is number k + 1
    m.innerHTML = head + `<div class="stage corr1"><p class="phase"><b>① 寫字階段</b>　呢個字未寫正確，請連續寫五次。五次都寫完後，才會開始評分。</p>` + target +
      `<div id="cstreak" class="streak" role="status" aria-live="polite"><b>寫字 ${k + 1} / 5</b> <span aria-hidden="true">${[0, 1, 2, 3, 4].map(j => `<span class="dot ${j < k ? 'on' : ''}"></span>`).join('')}</span></div>` +
      `<div id="cfb" class="fb" role="status">${esc(cFeed)}</div><canvas id="cc" width="600" height="600" aria-label="寫字區"></canvas>` +
      `<div class="row mkrow"><button class="b" onclick="clrAttempt()">清除</button><button class="b p" id="csub" onclick="submitAttempt()" disabled>提交第 ${k + 1} 次</button></div></div>`;
    initCanvas(c); return;
  }
  // marking phase: the five saved writings, one at a time
  const marks = it.marks, firstUn = marks.findIndex(x => x === null), idx = cmIdx === null ? (firstUn < 0 ? 5 : firstUn) : Math.min(Math.max(cmIdx, 0), 5);
  const chips = `<div class="row">${marks.map((mk, j) => `<button class="b mkchip ${mk === true ? 'p' : mk === false ? 'r' : ''} ${j === idx ? 'on' : ''}" onclick="goCm(${j})" aria-label="第 ${j + 1} 次，${mk === true ? '正確' : mk === false ? '錯誤' : '未評分'}">${j + 1} ${mk === true ? '✓' : mk === false ? '✗' : '－'}</button>`).join('')}</div>`;
  if (idx >= 5) {
    const bad = marks.filter(x => x === false).length, un = marks.filter(x => x === null).length;
    m.innerHTML = head + `<div class="stage corr1 mkone"><p class="phase"><b>② 評分階段</b></p>` + target + `<div class="mkprog" role="status">五次已評分：${5 - un} / 5</div>${chips}` +
      (un ? `<p class="warn">還有 ${un} 次未評分</p><div class="row"><button class="b p" onclick="goCm(${firstUn})">去評分</button></div>`
          : bad ? `<p class="warn"><b>有 ${bad} 次寫得不正確。</b>連續正確次數重新計算（0 / 5），需要重新寫五次，之前寫的不會重用。</p><div class="row mkrow"><button class="b" onclick="goCm(4)">修改評分</button><button class="b r" onclick="finishSetUI()">重新寫五次</button></div>`
                : `<p class="g"><b>五次都寫得正確！</b></p><div class="row mkrow"><button class="b" onclick="goCm(4)">修改評分</button><button class="b p" onclick="finishSetUI()">完成這個字</button></div>`) +
      `<div id="cfb" class="fb" role="status">${esc(cFeed)}</div></div>`;
    return;
  }
  m.innerHTML = head + `<div class="stage corr1 mkone"><p class="phase"><b>② 評分階段</b>　逐次評分這五次寫字。</p>` + target + `<div class="mkprog" role="status">評分 ${idx + 1} / 5</div>` +
    `<img class="mkimg" data-img="${esc(it.attempts[idx])}" alt="第 ${idx + 1} 次寫字">` +
    `<div class="row mkrow"><button class="b r ${marks[idx] === false ? 'on' : ''}" onclick="markAtt(false)">錯誤</button><button class="b p ${marks[idx] === true ? 'on' : ''}" onclick="markAtt(true)">正確</button></div>` +
    `<div class="row"><button class="b" ${idx ? '' : 'disabled'} onclick="goCm(${idx - 1})">上一次</button><button class="b" onclick="goCm(${idx + 1})">下一次</button></div>${chips}<div id="cfb" class="fb" role="status">${esc(cFeed)}</div></div>`;
  hydrate(m);
}
function goCm(k) { cmIdx = k; cFeed = ''; render(); }
/* mark the shown attempt, then move on (the last one shows the summary). cBusy only ignores a second tap while saving; it is released BEFORE rendering. */
async function markAtt(ok) {
  if (cBusy || !Q || !corrId) return;
  const q = Q, id = corrId, ci = corrIdx, c0 = q.correction(id), it0 = c0 && c0.items[ci]; if (!it0) return;
  const idx = cmIdx === null ? Math.max(0, it0.marks.findIndex(x => x === null)) : cmIdx; let r; cBusy = true;
  try { r = await q.markAttempt(id, ci, idx, ok); } finally { cBusy = false; }
  if (q !== Q || id !== corrId) return;
  if (!r.ok) { showBar(`<b>評分沒有儲存成功。</b>（${esc(reason(r.error))}）請再評分一次。`, 'hideErr'); return; }
  hideErr(); cFeed = ''; const marks = q.correction(id).items[ci].marks, un = marks.findIndex(x => x === null);
  cmIdx = idx + 1 < 5 ? idx + 1 : (un < 0 ? 5 : un); render();
}
/* finish the marked set: all correct = the character is done (next one / the whole activity); otherwise a completely new set of five */
async function finishSetUI() {
  if (cBusy || !Q || !corrId) return;
  const q = Q, id = corrId, ci = corrIdx; let r; cBusy = true;
  try { r = await q.finishSet(id, ci); } finally { cBusy = false; }
  if (q !== Q || id !== corrId) return;
  if (!r.ok) { showBar(`<b>沒有儲存成功。</b>（${esc(reason(r.error))}）已寫的字都保留，請再按一次。`, 'hideErr'); return; }
  hideErr(); cmIdx = null; const c = q.correction(id), it = c.items[ci];
  if (!CQCore.attemptsDone(it)) { cFeed = '有寫得不正確，連續正確次數重新計算（0 / 5）。請重新寫五次。'; render(); return; }
  const nx = c.items.findIndex(x => !CQCore.attemptsDone(x));
  if (nx < 0) return finishCorr();
  corrIdx = nx; cFeed = `「${it.c}」完成了！請繼續下一個字。`; render();
}
function sayC(k) { const c = Q.correction(corrId), it = c && c.items[corrIdx]; if (it) speak(k === 'w' ? it.w : it.c); }
function initCanvas(c) {
  Object.values(cTimers).forEach(clearTimeout); cTimers = {}; cFail.clear();
  const it = c.items[corrIdx], id = corrId, q = Q, st0 = store, el = $('#cc'), x = el.getContext('2d'), S = 600;
  const slot = { cv: el, cx: x, dirty: false, drawing: false }; cs = [slot]; ccv = slot;
  x.lineWidth = 12; x.lineCap = x.lineJoin = 'round'; x.strokeStyle = '#111'; x.fillStyle = '#fff'; x.fillRect(0, 0, S, S);
  const pt = e => { const r = el.getBoundingClientRect(); return [(e.clientX - r.left) * S / (r.width || S), (e.clientY - r.top) * S / (r.height || S)]; };
  const enable = () => { const b = $('#csub'); if (b) b.disabled = !slot.dirty; };
  {
    el.onpointerdown = e => { e.preventDefault(); el.setPointerCapture(e.pointerId); slot.drawing = true; slot.dirty = true; enable(); const [px, py] = pt(e); x.beginPath(); x.moveTo(px, py); x.lineTo(px + .01, py); x.stroke(); x.beginPath(); x.moveTo(px, py); };
    el.onpointermove = e => { if (!slot.drawing) return; e.preventDefault(); const [px, py] = pt(e); x.lineTo(px, py); x.stroke(); x.beginPath(); x.moveTo(px, py); };
    el.onpointerup = el.onpointercancel = () => { if (!slot.drawing) return; slot.drawing = false; schedPend(); };
  }
  if (it.pending) st0.getImage(it.pending).then(r => {                   // restore the unfinished / submitted drawing (refresh / resume)
    if (!r || q !== Q || corrId !== id || ccv !== slot || slot.dirty) return;
    const img = new Image(); img.onload = () => { if (ccv !== slot || slot.dirty) return; x.drawImage(img, 0, 0, S, S); slot.dirty = true; enable(); }; img.src = r.data;
  }).catch(() => { });
}
function schedPend() { clearTimeout(cTimers.p); cTimers.p = setTimeout(() => { delete cTimers.p; savePend(); }, 400); }
async function savePend() {            // a blank canvas is saved as "nothing written": it can never be submitted or counted
  const q = Q, id = corrId, ci = corrIdx, slot = ccv; if (!slot) return true;
  clearTimeout(cTimers.p); delete cTimers.p;
  const r = await q.savePending(id, ci, slot.dirty ? slot.cv.toDataURL('image/jpeg', .75) : null);
  if (q !== Q || id !== corrId || ci !== corrIdx) return false;
  if (!r.ok) { cFail.add('p'); showBar(`<b>這次的手寫答案沒有儲存成功。</b>（${esc(reason(r.error))}）筆跡仍然保留在畫面上，請按「重試」。`, 'retryCorr'); return false; }
  cFail.delete('p'); if (!cFail.size) hideErr(); return true;
}
function retryCorr() { savePend(); }
async function flushCorr() { if (cTimers.p) await savePend(); }
function clrAttempt() { const s = ccv; if (!s) return; s.cx.fillStyle = '#fff'; s.cx.fillRect(0, 0, 600, 600); s.dirty = false; const b = $('#csub'); if (b) b.disabled = true; savePend(); }
async function submitAttempt() {                      // submit the drawing as the next of the five attempts (never a blank canvas)
  if (cBusy || !ccv || !ccv.dirty) return;
  const q = Q, id = corrId, ci = corrIdx; cBusy = true; let r;
  try {
    if (!(await savePend())) return;
    r = await q.submitAttempt(id, ci);
  } finally { cBusy = false; }
  if (q !== Q || id !== corrId) return;
  if (!r.ok) { showBar(`<b>提交沒有成功。</b>（${esc(reason(r.error))}）筆跡仍然保留，請按「重試」。`, 'submitAttempt'); return; }
  hideErr(); cmIdx = null;
  const it = q.correction(id).items[ci]; cFeed = it.attempts.every(Boolean) ? '五次都寫完了！現在逐次評分。' : '';
  render();
}
async function finishCorr() {
  const q = Q, id = corrId, r = await q.completeCorrection(id); if (q !== Q) return;
  if (!r.ok) { showBar(`<b>寫五次練習的完成紀錄沒有儲存成功。</b>（${esc(reason(r.error))}）所有筆跡都已保留，請按「重試」。`, 'finishCorr'); return; }
  hideErr(); corrSum = true; cFeed = ''; render();
}
async function leaveCorr() {
  if (!(await safeToLeave())) return;
  silence(); corrId = null; corrSum = false; cs = []; ccv = null; cFeed = ''; cmIdx = null; hideErr(); render(); toast('進度已保留，可以稍後繼續');
}

/* ---------- app updates (service worker): applied only when the learner chooses AND nothing is in progress ---------- */
function updateSafe() {   // no question being answered, no marking, no unsaved or failing save
  if (Q && (Q.busy || Q.draftError)) return false;
  if (cFail.size || Object.keys(cTimers).length) return false;
  if (corrId) return corrSum;
  if (inS) return !!res;                                  // the result screen is fine: everything is already saved
  return true;
}
function showUpdateBar() {
  let b = $('#updbar'); if (!b) { b = document.createElement('div'); b.id = 'updbar'; document.body.appendChild(b); }
  b.innerHTML = '<div><b>有新版本可以使用。</b>更新前會先確定所有筆跡和進度都已儲存。正在作答或評分時請先完成或離開，再更新。</div><div class="row"><button class="b p" onclick="applyUpdate()">立即更新</button><button class="b" onclick="hideUpdate()">稍後</button></div>';
  b.hidden = false;
}
function hideUpdate() { const b = $('#updbar'); if (b) b.hidden = true; }
async function applyUpdate() {
  if (!updateSafe()) { toast('請先完成或離開目前這一題，才可以更新'); return; }
  try { if (Q && Q.cur) await Q.flushDraft(); if (corrId) await flushCorr(); }
  catch (e) { toast('有筆跡未能儲存，暫時不更新'); return; }
  if (!updateSafe()) { toast('請先完成或離開目前這一題，才可以更新'); return; }   // the screen may have changed while saving
  if (!CQPwa.applyUpdate()) hideUpdate();
}

/* ---------- learners: picking, switching, managing ---------- */
const ACTIVE_KEY = 'cq-active-profile';   // sessionStorage: survives a page refresh in this tab, forgotten when the tab/app is closed
function resetLearnerState() {            // nothing of the previous learner may stay in memory or on screen
  bk = null; sid = null; sPhase = 'read'; sq = null; sChar = null; sPlaying = -1; sSince = null; sSel = { diff: null, topic: null }; sBusy = false; tid = null; tOnly = false; mkIdx = null; mkBusy = false; endBusy = false; tab = 'levels'; lid = null; rid = null; inS = false; res = null; dirty = false; drawing = false; cv = cx = null;
  corrId = null; corrSum = false; cs = []; ccv = null; cFeed = ''; cmIdx = null; cBusy = false; Object.values(cTimers).forEach(clearTimeout); cTimers = {}; cFail.clear(); autoKey = null;
  silence(); storyFlush(); if (Q) Q.qPause(); hideErr(); document.querySelectorAll('.modal').forEach(d => d.remove());
  const t = $('#toast'); if (t) t.hidden = true;
  $('#main').innerHTML = '';
}
async function leaveLearner() {           // returns false if the user decided to stay
  if (!Q) return true;
  if (!(await safeToLeave())) return false;
  const q = Q, r = await q.close();       // flushes the drawing, waits for in-flight saves, then refuses any further action
  if (!r.ok && !confirm('筆跡未能儲存，切換後這一題的筆跡會遺失。確定切換？')) { q.closed = false; return false; }
  const id = profile.id; Q = null; store = null; profile = null; resetLearnerState();
  try { sessionStorage.removeItem(ACTIVE_KEY); } catch (e) { }
  mgr.closeStore(id);
  return true;
}
async function switchLearner() { if (!(await leaveLearner())) return; pview = 'pick'; render(); }
async function manageLearners() { if (!(await leaveLearner())) return; pview = 'manage'; render(); }
async function selectProfile(id) {
  if (Q && profile.id === id) return;
  if (!(await leaveLearner())) return;
  let st, p, q;
  try {
    p = await mgr.get(id); if (!p) throw new Error('missing');
    st = await mgr.openStore(id); q = new CQCore.Quiz(st, { content: CT }); await q.init();
  } catch (e) { pview = 'pick'; pmsg = `<p class="warn">無法開啟這個學習者的資料（${esc(reason(e))}）。資料沒有被改動。</p>`; render(); return; }
  store = st; profile = p; Q = q; resetLearnerState();
  q.onDraftError = e => { if (q === Q) showDraftError(e); }; q.onDraftOk = () => { if (q === Q) hideErr(); };
  try { sessionStorage.setItem(ACTIVE_KEY, id); } catch (e) { }
  const un = q.unfinished(); if (un.length) { tab = un[0].mode === 'exam' ? 'exam' : 'practice'; toast(un.length > 1 ? '有 ' + un.length + ' 個未完成的測驗，可以繼續或放棄' : '有未完成的測驗，可以繼續或放棄'); }
  render();
}
let pmsg = '';
function vPickProfile(m) {
  mgr.list('active').then(ps => {
    if (Q || pview !== 'pick') return;
    m.innerHTML = pmsg + `<h2>選擇學習者</h2><div class="grid">` + ps.map(p => `<button class="card pick" onclick="selectProfile('${p.id}')"><div class="av">${AV(p.avatar)}</div><div class="nm">${esc(p.name)}</div></button>`).join('') +
      `<button class="card pick add" onclick="profileForm()"><div class="av">＋</div><div class="nm">新增學習者</div></button></div>` +
      (ps.length ? '' : '<p>還沒有學習者，請先新增。</p>') + `<div class="row"><button class="b" onclick="pview='manage';render()">管理學習者</button><button class="b" onclick="pview='content';lid=null;render()">學習內容</button><button class="b" onclick="openBackup()">內容與備份</button></div>`; pmsg = '';
  }).catch(e => { m.innerHTML = `<p class="warn">無法讀取學習者名單（${esc(reason(e))}）。</p>`; });
}
function vManage(m) {
  mgr.list('all').then(ps => {
    if (Q || pview !== 'manage') return;
    const row = p => `<div class="card prow"><div class="av1 big">${AV(p.avatar)}</div><div class="grow"><b>${esc(p.name)}</b>${p.archivedAt ? ' <small>（已封存）</small>' : ''}</div><div class="row">` +
      `<button class="b" onclick="profileForm('${p.id}')">編輯資料</button>` +
      (p.archivedAt ? `<button class="b p" onclick="restoreProfile('${p.id}')">還原學習者</button>` : `<button class="b" onclick="archiveProfile('${p.id}')">封存學習者</button>`) +
      `<button class="b r" onclick="deleteProfile('${p.id}')">刪除學習者</button></div></div>`;
    m.innerHTML = `<div class="row"><button class="b" onclick="pview='pick';render()">返回</button><h2 style="margin:0">管理學習者</h2><button class="b p" onclick="profileForm()">新增學習者</button></div>` +
      (ps.map(row).join('') || '<p>還沒有學習者。</p>') + `<p><small>封存的學習者不會出現在選擇名單，但資料會保留，可以隨時還原。刪除則會永久移除該學習者的所有資料。</small></p><div id="pmsg"></div>`;
  }).catch(e => { m.innerHTML = `<p class="warn">無法讀取學習者名單（${esc(reason(e))}）。</p>`; });
}
function profileForm(id) {
  (id ? mgr.get(id) : Promise.resolve({ name: '', avatar: CQProfiles.AVATARS[0] })).then(p => {
    if (!p) return;
    const d = document.createElement('div'); d.className = 'modal'; let av = p.avatar;
    d.innerHTML = `<form class="card"><h3>${id ? '編輯資料' : '新增學習者'}</h3><label>名字<input name="name" value="${esc(p.name)}" maxlength="${CQProfiles.MAX_NAME}" autocomplete="off"></label><div class="avs">` +
      CQProfiles.AVATARS.map(a => `<button type="button" class="av ${a === av ? 'on' : ''}" data-a="${a}" aria-label="${a}">${AV(a)}</button>`).join('') + `</div><div class="warn err"></div><div class="row"><button type="button" class="b" id="x">取消</button><button class="b p" id="ok">儲存</button></div></form>`;
    document.body.appendChild(d);
    d.querySelectorAll('.avs .av').forEach(b => b.onclick = () => { av = b.dataset.a; d.querySelectorAll('.avs .av').forEach(x => x.classList.toggle('on', x === b)); });
    d.querySelector('#x').onclick = () => d.remove();
    d.querySelector('form').onsubmit = async e => {
      e.preventDefault(); const btn = d.querySelector('#ok'); if (btn.disabled) return; btn.disabled = true; d.querySelector('.err').textContent = '';
      try { const name = d.querySelector('[name=name]').value; if (id) await mgr.update(id, { name, avatar: av }); else await mgr.create({ name, avatar: av }); d.remove(); render(); }
      catch (err) { d.querySelector('.err').textContent = err.name === 'ProfileError' ? err.message : '儲存失敗（' + reason(err) + '），請重試。'; }
      btn.disabled = false;
    };
  }).catch(() => { });
}
async function profileAction(fn, failMsg) { try { await fn(); } catch (e) { alert(failMsg + '（' + reason(e) + '）。其他資料沒有改動。'); } render(); }
const archiveProfile = id => profileAction(() => mgr.archive(id), '封存失敗');
const restoreProfile = id => profileAction(() => mgr.restore(id), '還原失敗');
const deleteProfile = id => profileAction(() => mgr.remove(id, confirm), '刪除失敗');

async function boot() {
  try { mgr = new CQProfiles.ProfileManager(window.indexedDB); await mgr.init(); }
  catch (e) { return fatal('無法使用儲存空間', '這個瀏覽器目前無法使用儲存空間（IndexedDB），所以不能儲存資料。請不要使用私密瀏覽，或換一個瀏覽器再試。'); }
  try { await CQProfiles.adoptLegacy(mgr, window.localStorage); }
  catch (e) { return fatal('資料轉移未能完成', (e.parts && e.parts.length ? '核對時發現以下部分不相符：' + esc(e.parts.join('、')) + '。' : '') + '原有的資料沒有被刪除，也沒有改動。請按「重試」。如果仍然失敗，請先下載原有資料作備份。', true); }
  try { await CQProfiles.migrateSharedContent(mgr); CT = new CQCore.SharedContent(mgr.content); await CT.load(); }
  catch (e) { return fatal('資料轉移未能完成', '學習內容的整理未能完成。原有的資料沒有被刪除，也沒有改動。請按「重試」。', true); }
  const flushNow = () => { if (Q && Q.cur) Q.flushDraft().catch(() => { }); if (Q && corrId) flushCorr().catch(() => { }); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (Q) Q.qPause(); storyFlush(); flushNow(); }
    else if (sid && sPhase === 'read' && tab === 'stories') storyResume();
    else if (Q && inS && !res && Q.cur && Q.cur.phase === 'ask') Q.qStart(Q.cur.id + ':' + Q.cur.i);   // time away from the page is not response time
  });
  window.addEventListener('pagehide', flushNow);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
  if (window.speechSynthesis) speechSynthesis.getVoices();
  let last = null; try { last = sessionStorage.getItem(ACTIVE_KEY); } catch (e) { }
  if (last && await mgr.get(last).then(p => p && !p.archivedAt, () => false)) await selectProfile(last); else render();
  CQPwa.register({ onUpdate: showUpdateBar });   // after the app is up: offline support must never delay or break the app itself
}
window.__cqReady = boot();
