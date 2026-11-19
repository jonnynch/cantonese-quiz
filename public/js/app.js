/* UI layer. All persistence goes through CQCore.Quiz -> CQStorage (IndexedDB). */
let corrId = null, corrIdx = 0, corrSum = false, cs = [], cTimers = {}, cFail = new Set(), autoKey = null, speechUnlocked = false;
let Q, store, mgr, profile = null, pview = 'pick', tab = 'levels', lid = null, rid = null, inS = false, res = null, cv, cx, drawing = false, dirty = false;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lv = id => Q.level(id);
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
  if (!Q) { $('#nav').innerHTML = ''; (pview === 'manage' ? vManage : vPickProfile)($('#main')); return; }
  $('#nav').innerHTML = `<button class="who" onclick="switchLearner()" aria-label="切換學習者"><span class="av1">${AV(profile.avatar)}</span> ${esc(profile.name)} <small>切換學習者</small></button>` + [['levels', '級別管理'], ['practice', '練習'], ['exam', '考試'], ['hist', '學習紀錄'], ['set', '設定']].map(([k, t]) => `<button class="${tab === k && !inS ? 'on' : ''}" onclick="go('${k}')">${t}</button>`).join('');
  const m = $('#main'); if (corrId) { vCorrection(m); return; }
  if (inS) { sess(m); hydrate(m); return; }
  ({ levels: vLevels, practice: vPick, exam: vPick, hist: vHist, set: vSet })[tab](m); hydrate(m);
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
async function commitLevels(fn) { const q = Q, r = await q.mutateLevels(fn); if (r.busy) throw Object.assign(new Error('busy'), { code: 'busy' }); if (!r.ok) throw r.error; if (q === Q) render(); }
/* ---------- level management ---------- */
function vLevels(m) {
  if (lid && lv(lid)) {
    const L = lv(lid);
    m.innerHTML = `<div class="row"><button class="b" onclick="lid=null;render()">返回</button><h2 style="margin:0">${esc(L.name)} <small>${L.chars.length} 字</small></h2></div>${L.desc ? `<p>${esc(L.desc)}</p>` : ''}<div class="row"><button class="b p" onclick="charForm()">新增字</button></div><div class="grid">` +
      L.chars.map(c => `<div class="card"><div class="han mid">${esc(c.c)}</div><div>${esc(c.jp)}</div><div>${esc(c.w)} <small>${esc(c.wjp)}</small></div><div><small>${esc(c.m)}</small></div><div class="row"><button class="b" onclick="charForm('${c.id}')">編輯</button><button class="b r" onclick="delChar('${c.id}')">刪除</button></div></div>`).join('') + '</div>' + (L.chars.length ? '' : '<p>這個級別還沒有字。</p>'); return;
  }
  m.innerHTML = `<div class="row"><h2 style="margin:0">級別管理</h2><button class="b p" onclick="addLevel()">新增級別</button></div>` +
    (Q.levels.map(L => `<div class="card"><h3>${esc(L.name)} <small>${L.chars.length} 字</small></h3>${L.desc ? `<p>${esc(L.desc)}</p>` : ''}<div class="row"><button class="b p" onclick="lid='${L.id}';render()">查看</button><button class="b" onclick="renLevel('${L.id}')">重新命名</button><button class="b r" onclick="delLevel('${L.id}')">刪除</button></div></div>`).join('') || '<p>還沒有級別，請先新增。</p>');
}
function addLevel() { form('新增級別', [['name', '名稱'], ['desc', '說明（可選）']], {}, o => { if (!o.name) return false; const t = Date.now(); return commitLevels(ls => ls.push({ id: Q.uid(), name: o.name, desc: o.desc, chars: [], created: t, modified: t })); }) }
function renLevel(id) { const L = lv(id); form('重新命名', [['name', '名稱'], ['desc', '說明（可選）']], L, o => { if (!o.name) return false; return commitLevels(ls => { const x = ls.find(l => l.id === id); x.name = o.name; x.desc = o.desc; x.modified = Date.now(); }); }) }
async function delLevel(id) {
  if (!confirm('刪除這個級別和裏面所有的字？此動作無法復原。（已有的學習紀錄和未完成的測驗會保留。）')) return;
  try { await commitLevels(ls => { ls.splice(ls.findIndex(l => l.id === id), 1); }); } catch (e) { alert('刪除失敗（' + reason(e) + '），資料沒有改動。'); }
}
function charForm(id) {
  const L = lv(lid), c = id ? L.chars.find(x => x.id === id) : {};
  form(id ? '編輯字' : '新增字', [['c', '字'], ['jp', '粵拼'], ['w', '詞語'], ['wjp', '詞語粵拼'], ['m', '意思']], c, o => {
    if ([...o.c].length !== 1) { alert('「字」欄位請輸入一個繁體字'); return false; }
    return commitLevels(ls => { const x = ls.find(l => l.id === lid); if (id) Object.assign(x.chars.find(y => y.id === id), o); else x.chars.push({ id: Q.uid(), ...o }); x.modified = Date.now(); });
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
    h += `<div class="card"><b>有未完成的寫五次練習</b>（${esc(c.levelName)}，第 ${p.ci + 1} / ${c.items.length} 個字，第 ${Math.min(p.ai + 1, 5)} 次，${p.saved} / ${p.total}）<div><small>上次作答：${fd(c.updatedAt || c.createdAt)}</small></div><div class="row"><button class="b p" data-id="${esc(c.id)}" onclick="openCorrection(this.dataset.id)">繼續</button></div></div>`; });
  h += Q.levels.map(L => { const n = L.chars.length, low = ex && n < 20, ok = n && !low;
    return `<div class="card"><h3>${esc(L.name)} <small>${n} 字</small></h3>${low ? '<div class="warn">需要至少 20 個字才可以考試。</div>' : ''}<div class="row"><button class="b p" ${ok ? '' : 'disabled'} onclick="start('read','${L.id}','${md}')">${lab[0]}</button><button class="b p" ${ok ? '' : 'disabled'} onclick="start('write','${L.id}','${md}')">${lab[1]}</button></div></div>`; }).join('') || '<p>請先到「級別管理」新增級別和字。</p>';
  m.innerHTML = `<h2>${ex ? '考試' : '練習'}</h2>` + h;
}
/* Continue an unfinished session (id) or, without an id, the current one. Nothing is spoken again and nothing is reset. */
async function resume(id) {
  const q = Q;
  if (id && !(q.cur && q.cur.id === id)) { const r = await q.open(id); if (q !== Q || r.busy) return; if (!r.ok) { alert('無法繼續這次測驗（' + (reason(r.error) || r.error.message) + '）。進度沒有改動。'); return; } }
  inS = true; res = null; dirty = false; render();
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
/* ---------- session ---------- */
function sess(m) {
  if (res) return result(m);
  const s = Q.cur; if (!s) { inS = false; return render(); }
  if (s.phase === 'mark') return marking(m, s);
  const it = s.items[s.i], n = s.items.length;
  const head = `<div class="bar"><span>${s.i + 1} / ${n}</span><button class="b" onclick="leave()" aria-label="暫停並離開，進度會保留">⏸ 暫停（保留進度）</button></div>`;
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
  silence(); hideErr(); inS = false; dirty = false; render(); toast('進度和筆跡已保留，可以稍後繼續');
}
async function mark(ok) { const q = Q; after(await q.answerRead(ok), '這一題的答案', q); }
function say(k) { const it = Q.cur.items[Q.cur.i]; speak(k === 'w' ? it.w : it.c); }
/* Speak one or more phrases strictly one after another (a short pause between them). Starting any new speech, or silence(), invalidates a
   sequence that is still waiting, so two voices never overlap and a stale second phrase is never spoken.
   quiet = automatic speech: never show messages, never throw. */
let speechSeq = 0, gapTimer = null, speechGap = 400;
function silence() { speechSeq++; clearTimeout(gapTimer); try { const ss = window.speechSynthesis; if (ss) ss.cancel(); } catch (e) { } }
function speakSeq(parts, quiet) {
  parts = parts.filter(Boolean); if (!parts.length) return;
  const ss = window.speechSynthesis; if (!ss || !window.SpeechSynthesisUtterance) { if (!quiet) toast('這部裝置不支援語音'); return; }
  const my = ++speechSeq; clearTimeout(gapTimer);
  try {
    const v = ss.getVoices().find(x => /zh[-_]HK|yue/i.test(x.lang));
    if (!v && !quiet) toast('找不到廣東話語音，發音可能不準確');
    ss.cancel();                                                       // cancel() first: never two voices at once
    const next = k => {
      if (my !== speechSeq || k >= parts.length) return;
      const u = new SpeechSynthesisUtterance(parts[k]); u.lang = 'zh-HK'; if (v) u.voice = v; u.rate = .8;
      let moved = false, fb = null;
      const go = () => { if (moved) return; moved = true; clearTimeout(fb); if (k + 1 < parts.length && my === speechSeq) gapTimer = setTimeout(() => next(k + 1), speechGap); };
      fb = setTimeout(go, 4000); u.onend = u.onerror = go;             // some engines never report the end: do not get stuck
      try { ss.speak(u); } catch (e) { clearTimeout(fb); moved = true; if (!quiet) toast('無法播放語音'); }
    };
    next(0);
  } catch (e) { if (!quiet) toast('無法播放語音'); }
}
const speak = (t, quiet) => speakSeq([t], quiet);
/* iOS only allows speech that was started from a tap: prime it synchronously inside the tap handler, before any await. */
function unlockSpeech() {
  try { const ss = window.speechSynthesis; if (!speechUnlocked && ss && window.SpeechSynthesisUtterance) { const u = new SpeechSynthesisUtterance(''); u.volume = 0; ss.speak(u); speechUnlocked = true; } } catch (e) { }
}
/* Pronounce the target character, then (after a short pause) its compound word with the character identified in context, e.g. 左 ... 左右嘅左.
   Nothing is shown on screen. Called only when a question is newly entered (session start / after an answer advanced), never from render
   or resume, and remembered per session+question. The compound word is the existing data (none, or the character itself: character only). */
function autoSpeak() {
  const s = Q && Q.cur; if (!s || s.kind !== 'write' || s.phase !== 'ask' || corrId) return;
  const key = s.id + ':' + s.i; if (autoKey === key) return; autoKey = key;
  const it = s.items[s.i];
  speakSeq([it.c, it.w && it.w !== it.c ? it.w + '嘅' + it.c : ''], true);
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
function marking(m, s) {
  const un = s.items.filter(x => x.ok === null).length;
  m.innerHTML = `<div class="bar"><h2>家長評分</h2><button class="b" onclick="leave()" aria-label="暫停並離開，進度會保留">⏸ 暫停（保留進度）</button></div><div class="grid">` +
    s.items.map((it, k) => `<div class="card mk"><div class="han mid">${esc(it.c)}</div><div>${esc(it.w)} <small>${esc(it.wjp)}</small></div>${it.imgId ? `<img data-img="${esc(it.imgId)}" alt="">` : '<div class="warn">沒有手寫圖片</div>'}<div class="row"><button class="b r ${it.ok === false ? 'on' : ''}" onclick="setOk(${k},false)">錯誤</button><button class="b p ${it.ok === true ? 'on' : ''}" onclick="setOk(${k},true)">正確</button></div></div>`).join('') +
    `</div><div class="row"><button class="b p" ${un ? 'disabled' : ''} onclick="finish()">完成評分</button>${un ? `<span class="warn">還有 ${un} 題未評分</span>` : ''}</div>`;
}
async function setOk(k, v) { const q = Q; after(await q.setOk(k, v), '評分', q); }
async function finish() { const q = Q; after(await q.finishMarking(), '評分結果', q); }
function agg(rs) { let t = 0, o = 0; rs.forEach(r => r.items.forEach(x => { t++; if (x.ok) o++; })); return { t, o, p: t ? Math.round(o / t * 100) : 0 }; }
function freq(rs) { const m = {}; rs.forEach(r => r.items.forEach(x => { if (!x.ok) m[x.c] = (m[x.c] || 0) + 1; })); return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8); }
const durText = r => CQCore.durationOf(r) || '未有資料';
function corrButton(r) {
  const c = Q.correctionFor(r.id); if (!c) return '';
  return c.state === 'done' ? '<span class="g"><b>已完成寫五次練習</b></span>' : `<button class="b p" onclick="openCorrection('${c.id}')">寫五次練習（${c.items.length} 個字）</button>`;
}
function result(m) {
  const r = res, a = agg([r]), bad = r.items.filter(x => !x.ok);
  m.innerHTML = `<h2>${LB(r)}結果</h2><div class="card"><div class="line"><span>級別</span><b>${esc(r.levelName)}</b></div><div class="line"><span>類型</span><b>${LB(r)}</b></div><div class="line"><span>用時</span><b>${durText(r)}</b></div><div class="line"><span>題數</span><b>${a.t}</b></div><div class="line"><span>正確</span><b class="g">${a.o}</b></div><div class="line"><span>錯誤</span><b class="rd">${a.t - a.o}</b></div><div class="line"><span>準確率</span><b>${a.p}%</b></div></div>` +
    (bad.length ? `<div class="card"><h3>錯誤的字</h3><div class="han mid">${bad.map(x => esc(x.c)).join(' ')}</div></div>` : '<p class="g"><b>全部正確！</b></p>') +
    `<div class="row">${corrButton(r)}${bad.length ? `<button class="b p" onclick="revise()">重新溫習</button>` : ''}<button class="b" onclick="go('${r.mode === 'exam' ? 'exam' : 'practice'}')">返回</button></div>`;
}
async function revise() {
  unlockSpeech();
  const q = Q, r = res, rr = await q.startSession({ kind: r.kind, levelId: r.levelId, mode: 'revision', parentId: r.id, chars: r.items.filter(x => !x.ok).map(x => ({ id: x.cid, c: x.c, jp: x.jp, w: x.w, wjp: x.wjp })) });
  if (q !== Q || rr.busy) return;
  if (rr.duplicate) { toast('這次溫習已有未完成的進度，繼續上次的進度'); return resume(rr.existing); }
  if (!rr.ok) { alert('無法開始溫習（' + reason(rr.error) + '）。'); return; }
  res = null; inS = true; dirty = false; render(); autoSpeak();
}
/* ---------- history ---------- */
function vHist(m) {
  if (rid) { const r = Q.records.find(x => x.id === rid); if (r) {
    m.innerHTML = `<button class="b" onclick="rid=null;render()">返回</button><h2>${LB(r)}・${esc(r.levelName)}</h2><p>${fd(r.date)}　用時 ${durText(r)}${r.parentId ? '（溫習）' : ''}</p><div class="grid">` + r.items.map(x => `<div class="card"><div class="han mid">${esc(x.c)}</div><div>${esc(x.w)}</div><b class="${x.ok ? 'g' : 'rd'}">${x.ok ? '正確' : '錯誤'}</b>${x.imgId ? `<img data-img="${esc(x.imgId)}" alt="">` : ''}</div>`).join('') + '</div>'; return; } }
  const ids = [...new Set([...Q.levels.map(l => l.id), ...Q.records.map(r => r.levelId)])];
  m.innerHTML = '<h2>學習紀錄</h2>' + (ids.map(id => {
    const rs = Q.records.filter(r => r.levelId === id), nm = lv(id) ? lv(id).name : (rs[0] ? rs[0].levelName : '');
    const blocks = ['read', 'write'].map(k => { const kr = rs.filter(r => r.kind === k), a = agg(kr), f = freq(kr);
      return `<div class="card"><h4>${k === 'read' ? '讀字' : '寫字'}　${a.t ? a.o + ' / ' + a.t + '（' + a.p + '%）' : '未有紀錄'}</h4>` +
        ['practice', 'revision', 'exam'].map(md => { const x = kr.filter(r => r.mode === md), g = agg(x); return `<div class="line"><span>${NAME[k][md]}</span><span>${x.length} 次　${g.t ? g.p + '%' : '—'}</span></div>`; }).join('') +
        (f.length ? `<p>常錯：${f.map(([c, n]) => `<span class="han">${esc(c)}</span>×${n}`).join('　')}</p>` : '') + '</div>'; }).join('');
    const list = rs.slice().reverse().slice(0, 10).map(r => { const a = agg([r]); return `<button class="b line" onclick="rid='${r.id}';render()"><span>${fd(r.date)}　${LB(r)}</span><span>${a.o}/${a.t}（${a.p}%）</span></button>`; }).join('');
    return `<h3>${esc(nm)}</h3><div class="grid">${blocks}</div>${list ? `<div class="card">${list}</div>` : ''}`; }).join('') || '<p>還沒有紀錄。</p>');
}
/* ---------- settings: backup ---------- */
function vSet(m) {
  m.innerHTML = `<h2>設定</h2><div class="card"><h3>學習者：${AV(profile.avatar)} ${esc(profile.name)}</h3><div class="row"><button class="b p" onclick="switchLearner()">切換學習者</button><button class="b" onclick="manageLearners()">管理學習者</button></div></div><div class="card"><h3>安裝到主畫面</h3><p><small>iPad／iPhone：在 Safari 按「分享」，再選「加入主畫面」。Android／Chrome：選單 →「安裝應用程式」。安裝後，打開過一次的應用程式可以在沒有網絡時使用，所有資料都儲存在這部裝置上。</small></p></div><div class="card"><h3>匯出備份</h3><p><small>包括「${esc(profile.name)}」的級別、字、紀錄、手寫圖片，以及未完成的測驗、未交的手寫草稿和寫五次練習。</small></p><button class="b p" onclick="exp()">匯出</button><div id="emsg" class="row"></div></div>
  <div class="card"><h3>匯入備份</h3><p><small>只會影響「${esc(profile.name)}」的資料。</small></p><div class="row"><label><input type="radio" name="im" value="merge" checked style="width:auto;min-height:0"> 合併（保留現有資料）</label><label><input type="radio" name="im" value="replace" style="width:auto;min-height:0"> 取代全部資料</label></div><input type="file" id="fi" accept=".json,application/json"><div id="imsg"></div></div>`;
  $('#fi').onchange = e => { if (e.target.files[0]) imp(e.target.files[0]); e.target.value = ''; };
}
async function exp() {
  try {
    const q = Q, { json, missingImages } = await q.exportBackup(); if (q !== Q) return;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(json)], { type: 'application/json' }));
    a.download = '識字備份-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); a.remove();
    $('#emsg').innerHTML = missingImages ? `<span class="warn">有 ${missingImages} 張手寫圖片找不到，備份中沒有包括這些圖片。</span>` : '';
  } catch (e) { $('#emsg').innerHTML = `<span class="warn">匯出失敗（${esc(reason(e))}）。</span>`; }
}
const list = (a, n) => a.slice(0, n).map(x => `<li>${esc(x)}</li>`).join('') + (a.length > n ? `<li>…還有 ${a.length - n} 項</li>` : '');
async function imp(f) {
  const msg = $('#imsg'), mode = document.querySelector('input[name=im]:checked').value; let json;
  try { json = JSON.parse(await f.text()); } catch (e) { msg.innerHTML = '<p class="warn">匯入失敗：檔案已損毀或格式不正確。現有資料沒有改動。</p>'; return; }
  let r; const q = Q;
  try { r = await q.importBackup(json, mode, confirm); }
  catch (e) {
    msg.innerHTML = e.list ? `<p class="warn">匯入失敗，現有資料沒有改動：</p><ul class="warn">${list(e.list, 10)}</ul>` : `<p class="warn">匯入失敗（${esc(reason(e))}）。現有資料沒有改動。</p>`; return;
  }
  if (q !== Q || r.cancelled) return;
  if (r.aborted) { msg.innerHTML = `<p class="warn">沒有匯入任何資料：發現 ${r.conflicts.length} 項衝突，現有資料沒有改動。</p><ul class="warn">${list(r.conflicts, 10)}</ul><p><small>如要使用備份的內容，請先匯出目前的資料，再選擇「取代全部資料」。</small></p>`; return; }
  msg.innerHTML = `<p class="g">${r.mode === 'replace' ? '已取代全部資料' : '已合併'}：新增級別 ${r.added.levels}、新增字 ${r.added.chars}、新增紀錄 ${r.added.records}${r.added.sessions ? `、未完成的測驗 ${r.added.sessions}` : ''}${r.added.corrections ? `、寫五次練習 ${r.added.corrections}` : ''}${r.identical ? `；${r.identical} 項資料已存在（相同），已略過` : ''}。</p>` +
    (r.conflicts.length ? `<p class="warn">發現 ${r.conflicts.length} 項衝突，沒有覆蓋現有資料：</p><ul class="warn">${list(r.conflicts, 10)}</ul>` : '') +
    (r.warnings.length ? `<ul class="warn">${list(r.warnings, 10)}</ul>` : '');
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
  corrId = id; corrIdx = i < 0 ? 0 : i; corrSum = c.state === 'done'; inS = false; res = null; hideErr(); render();
}
function vCorrection(m) {
  const c = Q.correction(corrId); if (!c) { corrId = null; return render(); }
  if (corrSum || c.state === 'done') {
    const n = c.items.length;
    m.innerHTML = `<h2>寫五次練習完成</h2><div class="card"><div class="line"><span>級別</span><b>${esc(c.levelName)}</b></div><div class="line"><span>字數</span><b>${n}</b></div><div class="line"><span>已完成</span><b class="g">${n * 5} / ${n * 5}</b></div></div><div class="card"><div class="han mid">${c.items.map(x => esc(x.c)).join(' ')}</div></div><div class="row"><button class="b p" onclick="leaveCorr()">返回</button></div>`;
    return;
  }
  const it = c.items[corrIdx], last = corrIdx + 1 >= c.items.length;
  m.innerHTML = `<div class="bar"><span id="cprog"></span><button class="b" onclick="leaveCorr()" aria-label="暫停並離開，進度會保留">⏸ 暫停（保留進度）</button></div><div class="stage"><p><b>呢個字未寫正確，請連續寫五次。</b></p>` +
    `<div class="big han" style="font-size:min(30vw,20vh,180px)">${esc(it.c)}</div>` +
    (it.w ? `<div class="han mid">${esc(it.w)}${it.wjp ? ` <small>${esc(it.wjp)}</small>` : ''}</div>` : '') +
    `<div class="row"><button class="b spk" onclick="sayC('c')" aria-label="單字發音">🔊 單字</button>${it.w ? '<button class="b spk" onclick="sayC(\'w\')" aria-label="詞語發音">🔊 詞語</button>' : ''}</div>` +
    `<div class="five">${[0, 1, 2, 3, 4].map(k => `<div class="slot"><div class="no">${k + 1}</div><canvas id="cc${k}" width="360" height="360" aria-label="第 ${k + 1} 次"></canvas><button class="b" onclick="clrSlot(${k})">清除</button></div>`).join('')}</div>` +
    `<div class="row"><button class="b p" id="cnext" onclick="nextChar()">${last ? '完成' : '下一個字'}</button></div></div>`;
  initSlots(c);
}
function sayC(k) { const c = Q.correction(corrId), it = c && c.items[corrIdx]; if (it) speak(k === 'w' ? it.w : it.c); }
function initSlots(c) {
  Object.values(cTimers).forEach(clearTimeout); cTimers = {}; cFail.clear(); cs = [];
  const it = c.items[corrIdx], id = corrId, q = Q, st0 = store;
  for (let k = 0; k < CQCore.ATTEMPTS; k++) {
    const el = $('#cc' + k), x = el.getContext('2d'), slot = { cv: el, cx: x, dirty: false, drawing: false };
    x.lineWidth = 7; x.lineCap = x.lineJoin = 'round'; x.strokeStyle = '#111'; x.fillStyle = '#fff'; x.fillRect(0, 0, 360, 360); cs.push(slot);
    const pt = e => { const r = el.getBoundingClientRect(); return [(e.clientX - r.left) * 360 / (r.width || 360), (e.clientY - r.top) * 360 / (r.height || 360)]; };
    el.onpointerdown = e => { e.preventDefault(); el.setPointerCapture(e.pointerId); slot.drawing = true; slot.dirty = true; const [px, py] = pt(e); x.beginPath(); x.moveTo(px, py); x.lineTo(px + .01, py); x.stroke(); x.beginPath(); x.moveTo(px, py); };
    el.onpointermove = e => { if (!slot.drawing) return; e.preventDefault(); const [px, py] = pt(e); x.lineTo(px, py); x.stroke(); x.beginPath(); x.moveTo(px, py); };
    el.onpointerup = el.onpointercancel = () => { if (!slot.drawing) return; slot.drawing = false; schedSlot(k); };
    const saved = it.attempts[k];                                      // restore an already saved attempt (refresh / resume)
    if (saved) st0.getImage(saved).then(r => {
      if (!r || q !== Q || corrId !== id || cs[k] !== slot || slot.dirty) return;
      const img = new Image(); img.onload = () => { if (cs[k] !== slot || slot.dirty) return; x.drawImage(img, 0, 0, 360, 360); slot.dirty = true; }; img.src = r.data;
    }).catch(() => { });
  }
  updateCorrProgress();
}
function updateCorrProgress() {
  const c = Q.correction(corrId); if (!c || corrSum) return; const it = c.items[corrIdx], n = c.items.length;
  const filled = it.attempts.filter(Boolean).length, total = c.items.reduce((t, x) => t + x.attempts.filter(Boolean).length, 0);
  const p = $('#cprog'); if (p) p.textContent = `第 ${corrIdx + 1} / ${n} 個字　這個字 ${filled} / 5　總進度 ${total} / ${n * 5}`;
  const b = $('#cnext'); if (b) b.disabled = !CQCore.attemptsDone(it);
  cs.forEach((s, k) => s.cv.classList.toggle('ok', !!it.attempts[k]));
}
function schedSlot(k) { clearTimeout(cTimers[k]); cTimers[k] = setTimeout(() => { delete cTimers[k]; saveSlot(k); }, 400); }
async function saveSlot(k) {     // a blank canvas is saved as "no attempt": it can never count as completed
  const q = Q, id = corrId, ci = corrIdx, slot = cs[k]; if (!slot) return;
  clearTimeout(cTimers[k]); delete cTimers[k];
  const r = await q.saveAttempt(id, ci, k, slot.dirty ? slot.cv.toDataURL('image/jpeg', .75) : null);
  if (q !== Q || id !== corrId || ci !== corrIdx) return;
  if (!r.ok) { cFail.add(k); showBar(`<b>第 ${k + 1} 次的手寫答案沒有儲存成功。</b>（${esc(reason(r.error))}）筆跡仍然保留在畫面上，請按「重試」。儲存成功之前，不能算完成。`, 'retryCorr'); return; }
  cFail.delete(k); if (!cFail.size) hideErr(); updateCorrProgress();
}
function retryCorr() { [...cFail].forEach(k => saveSlot(k)); }
function clrSlot(k) {
  const s = cs[k]; if (!s) return; s.cx.fillStyle = '#fff'; s.cx.fillRect(0, 0, 360, 360); s.dirty = false;   // only this attempt
  if (Q.correction(corrId).items[corrIdx].attempts[k] || cFail.has(k)) saveSlot(k); else clearTimeout(cTimers[k]);
}
async function flushCorr() { await Promise.all(Object.keys(cTimers).map(k => saveSlot(+k))); }
async function nextChar() {
  const q = Q, id = corrId; await flushCorr(); if (cFail.size || q !== Q) return;
  const c = q.correction(id); if (!c || !CQCore.attemptsDone(c.items[corrIdx])) return;
  if (corrIdx + 1 < c.items.length) { corrIdx++; render(); return; }
  const r = await q.completeCorrection(id); if (q !== Q) return;
  if (!r.ok) { showBar(`<b>寫五次練習的完成紀錄沒有儲存成功。</b>（${esc(reason(r.error))}）所有筆跡都已保留，請按「重試」。`, 'nextChar'); return; }
  hideErr(); corrSum = true; render();
}
async function leaveCorr() {
  if (!(await safeToLeave())) return;
  silence(); corrId = null; corrSum = false; cs = []; hideErr(); render(); toast('進度已保留，可以稍後繼續');
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
  tab = 'levels'; lid = null; rid = null; inS = false; res = null; dirty = false; drawing = false; cv = cx = null;
  corrId = null; corrSum = false; cs = []; Object.values(cTimers).forEach(clearTimeout); cTimers = {}; cFail.clear(); autoKey = null;
  silence(); hideErr(); document.querySelectorAll('.modal').forEach(d => d.remove());
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
    st = await mgr.openStore(id); q = new CQCore.Quiz(st); await q.init();
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
      (ps.length ? '' : '<p>還沒有學習者，請先新增。</p>') + `<div class="row"><button class="b" onclick="pview='manage';render()">管理學習者</button></div>`; pmsg = '';
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
  const flushNow = () => { if (Q && Q.cur) Q.flushDraft().catch(() => { }); if (Q && corrId) flushCorr().catch(() => { }); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });
  window.addEventListener('pagehide', flushNow);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
  if (window.speechSynthesis) speechSynthesis.getVoices();
  let last = null; try { last = sessionStorage.getItem(ACTIVE_KEY); } catch (e) { }
  if (last && await mgr.get(last).then(p => p && !p.archivedAt, () => false)) await selectProfile(last); else render();
  CQPwa.register({ onUpdate: showUpdateBar });   // after the app is up: offline support must never delay or break the app itself
}
window.__cqReady = boot();
