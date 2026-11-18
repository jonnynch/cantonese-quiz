/* UI layer. All persistence goes through CQCore.Quiz -> CQStorage (IndexedDB). */
let Q, store, tab = 'levels', lid = null, rid = null, inS = false, res = null, cv, cx, drawing = false, dirty = false;
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
function retryDraft() { Q.flushDraft().then(hideErr, () => { }); }
function hideErr() { const b = $('#errbar'); if (b) b.hidden = true; }
let lastWhat = '';
function after(r, what) {   // r = result of a Quiz action
  if (r.busy) return;
  if (!r.ok) { lastWhat = what; showSaveError(what, r.error); return; }
  hideErr();
  if (Q.result) { res = Q.result; Q.result = null; inS = true; }
  render();
}
async function retrySave() { if (Q.busy) return; after(await Q.retryLast(), lastWhat); }

function render() {
  $('#nav').innerHTML = [['levels', '級別管理'], ['practice', '練習'], ['exam', '考試'], ['hist', '學習紀錄'], ['set', '設定']].map(([k, t]) => `<button class="${tab === k && !inS ? 'on' : ''}" onclick="go('${k}')">${t}</button>`).join('');
  const m = $('#main'); if (inS) { sess(m); hydrate(m); return; }
  ({ levels: vLevels, practice: vPick, exam: vPick, hist: vHist, set: vSet })[tab](m); hydrate(m);
}
function hydrate(root) {
  root.querySelectorAll('img[data-img]').forEach(async im => {
    try { const r = await store.getImage(im.dataset.img); if (r) im.src = r.data; else im.replaceWith('圖片無法顯示'); } catch (e) { im.replaceWith('圖片無法顯示'); }
  });
}
/* Leaving a writing question: make sure the drawing is saved first; if that is impossible, ask before discarding it. */
async function safeToLeave() {
  if (!inS || !dirty) return true;
  try { await Q.flushDraft(); return true; }
  catch (e) { return confirm('筆跡未能儲存，離開後這一題的筆跡會遺失。確定離開？'); }
}
async function go(t) {
  if (!(await safeToLeave())) return;
  hideErr(); inS = false; res = null; tab = t; lid = null; rid = null; dirty = false; render();
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
async function commitLevels(fn) { const r = await Q.mutateLevels(fn); if (r.busy) throw Object.assign(new Error('busy'), { code: 'busy' }); if (!r.ok) throw r.error; render(); }
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
  if (Q.cur) { const s = Q.cur; h += `<div class="card"><b>有未完成的${LB(s)}</b>（${esc(s.levelName)}，${s.phase === 'mark' ? '評分中' : '第 ' + (s.i + 1) + ' / ' + s.items.length + ' 題'}）<div class="row"><button class="b p" onclick="resume()">繼續</button><button class="b r" onclick="discard()">放棄</button></div></div>`; }
  h += Q.levels.map(L => { const n = L.chars.length, low = ex && n < 20, ok = n && !low;
    return `<div class="card"><h3>${esc(L.name)} <small>${n} 字</small></h3>${low ? '<div class="warn">需要至少 20 個字才可以考試。</div>' : ''}<div class="row"><button class="b p" ${ok ? '' : 'disabled'} onclick="start('read','${L.id}','${md}')">${lab[0]}</button><button class="b p" ${ok ? '' : 'disabled'} onclick="start('write','${L.id}','${md}')">${lab[1]}</button></div></div>`; }).join('') || '<p>請先到「級別管理」新增級別和字。</p>';
  m.innerHTML = `<h2>${ex ? '考試' : '練習'}</h2>` + h;
}
function resume() { inS = true; res = null; dirty = false; render(); }
async function discard() { const r = await Q.discard(confirm); if (r.busy || r.cancelled) return; if (!r.ok) { alert('放棄失敗（' + reason(r.error) + '），未完成的測驗仍然保留。'); return; } render(); }
async function start(kind, levelId, mode) {
  const r = await Q.startSession({ kind, levelId, mode, confirm: m => confirm(m) });
  if (r.cancelled || r.busy) return;
  if (!r.ok) { alert('無法開始測驗（' + (reason(r.error) || r.error.message) + '）。'); return; }
  inS = true; res = null; dirty = false; render();
}
/* ---------- session ---------- */
function sess(m) {
  if (res) return result(m);
  const s = Q.cur; if (!s) { inS = false; return render(); }
  if (s.phase === 'mark') return marking(m, s);
  const it = s.items[s.i], n = s.items.length;
  const head = `<div class="bar"><span>${s.i + 1} / ${n}</span><button class="b" onclick="leave()">離開</button></div>`;
  if (s.kind === 'read') {
    m.innerHTML = head + `<div class="stage"><div class="big han">${esc(it.c)}</div><div class="row"><button class="b r" style="min-width:150px;min-height:72px" onclick="mark(false)">錯誤</button><button class="b p" style="min-width:150px;min-height:72px" onclick="mark(true)">正確</button></div></div>`; return;
  }
  m.innerHTML = head + `<div class="stage"><div class="row"><button class="b spk" onclick="say('w')" ${it.w ? '' : 'disabled'} aria-label="詞語發音">🔊 詞語</button><button class="b spk" onclick="say('c')" aria-label="單字發音">🔊 單字</button></div>` +
    (s.mode === 'exam' ? '' : `<div class="row"><button class="b" id="rv" onclick="rev()">顯示答案</button><span id="ans" class="han ans"></span></div>`) +
    `<canvas id="cv" width="640" height="640"></canvas><div class="row"><button class="b" onclick="clr()">清除</button><button class="b" onclick="clr()">重寫</button><button class="b p" onclick="done()">${s.i + 1 < n ? '下一題' : '完成'}</button></div></div>`;
  initCv();
}
async function leave() {
  if (!(await safeToLeave())) return;
  hideErr(); inS = false; dirty = false; render(); toast('進度和筆跡已保留，可以稍後繼續');
}
async function mark(ok) { after(await Q.answerRead(ok), '這一題的答案'); }
function say(k) { const it = Q.cur.items[Q.cur.i]; speak(k === 'w' ? it.w : it.c); }
function speak(t) {
  if (!t) return; const ss = window.speechSynthesis; if (!ss || !window.SpeechSynthesisUtterance) { toast('這部裝置不支援語音'); return; }
  const v = ss.getVoices().find(x => /zh[-_]HK|yue/i.test(x.lang));
  if (!v) toast('找不到廣東話語音，發音可能不準確');
  ss.cancel(); const u = new SpeechSynthesisUtterance(t); u.lang = 'zh-HK'; if (v) u.voice = v; u.rate = .8; ss.speak(u);
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
  if (Q.busy) return;
  if (!dirty && !confirm('還沒有寫字，確定完成這一題？')) return;
  const r = await Q.answerWrite(snap());   // canvas is NOT cleared; it is only replaced after a confirmed save
  if (r.ok) dirty = false;
  after(r, '這一題的手寫答案');
}
function marking(m, s) {
  const un = s.items.filter(x => x.ok === null).length;
  m.innerHTML = `<div class="bar"><h2>家長評分</h2><button class="b" onclick="leave()">離開</button></div><div class="grid">` +
    s.items.map((it, k) => `<div class="card mk"><div class="han mid">${esc(it.c)}</div><div>${esc(it.w)} <small>${esc(it.wjp)}</small></div>${it.imgId ? `<img data-img="${esc(it.imgId)}" alt="">` : '<div class="warn">沒有手寫圖片</div>'}<div class="row"><button class="b r ${it.ok === false ? 'on' : ''}" onclick="setOk(${k},false)">錯誤</button><button class="b p ${it.ok === true ? 'on' : ''}" onclick="setOk(${k},true)">正確</button></div></div>`).join('') +
    `</div><div class="row"><button class="b p" ${un ? 'disabled' : ''} onclick="finish()">完成評分</button>${un ? `<span class="warn">還有 ${un} 題未評分</span>` : ''}</div>`;
}
async function setOk(k, v) { after(await Q.setOk(k, v), '評分'); }
async function finish() { after(await Q.finishMarking(), '評分結果'); }
function agg(rs) { let t = 0, o = 0; rs.forEach(r => r.items.forEach(x => { t++; if (x.ok) o++; })); return { t, o, p: t ? Math.round(o / t * 100) : 0 }; }
function freq(rs) { const m = {}; rs.forEach(r => r.items.forEach(x => { if (!x.ok) m[x.c] = (m[x.c] || 0) + 1; })); return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8); }
function result(m) {
  const r = res, a = agg([r]), bad = r.items.filter(x => !x.ok);
  m.innerHTML = `<h2>${LB(r)}結果</h2><div class="card"><div class="line"><span>級別</span><b>${esc(r.levelName)}</b></div><div class="line"><span>類型</span><b>${LB(r)}</b></div><div class="line"><span>日期</span><b>${fd(r.date)}</b></div><div class="line"><span>題數</span><b>${a.t}</b></div><div class="line"><span>正確</span><b class="g">${a.o}</b></div><div class="line"><span>錯誤</span><b class="rd">${a.t - a.o}</b></div><div class="line"><span>準確率</span><b>${a.p}%</b></div></div>` +
    (bad.length ? `<div class="card"><h3>錯誤的字</h3><div class="han mid">${bad.map(x => esc(x.c)).join(' ')}</div></div>` : '<p class="g"><b>全部正確！</b></p>') +
    `<div class="row">${bad.length ? `<button class="b p" onclick="revise()">重新溫習</button>` : ''}<button class="b" onclick="go('${r.mode === 'exam' ? 'exam' : 'practice'}')">返回</button></div>`;
}
async function revise() {
  const r = res, rr = await Q.startSession({ kind: r.kind, levelId: r.levelId, mode: 'revision', parentId: r.id, chars: r.items.filter(x => !x.ok).map(x => ({ id: x.cid, c: x.c, jp: x.jp, w: x.w, wjp: x.wjp })), confirm: m => confirm(m) });
  if (rr.cancelled || rr.busy) return; if (!rr.ok) { alert('無法開始溫習（' + reason(rr.error) + '）。'); return; }
  res = null; inS = true; dirty = false; render();
}
/* ---------- history ---------- */
function vHist(m) {
  if (rid) { const r = Q.records.find(x => x.id === rid); if (r) {
    m.innerHTML = `<button class="b" onclick="rid=null;render()">返回</button><h2>${LB(r)}・${esc(r.levelName)}</h2><p>${fd(r.date)}${r.parentId ? '（溫習）' : ''}</p><div class="grid">` + r.items.map(x => `<div class="card"><div class="han mid">${esc(x.c)}</div><div>${esc(x.w)}</div><b class="${x.ok ? 'g' : 'rd'}">${x.ok ? '正確' : '錯誤'}</b>${x.imgId ? `<img data-img="${esc(x.imgId)}" alt="">` : ''}</div>`).join('') + '</div>'; return; } }
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
  m.innerHTML = `<h2>設定</h2><div class="card"><h3>匯出備份</h3><p><small>包括所有級別、字、紀錄和手寫圖片。未完成的測驗不包括在內。</small></p><button class="b p" onclick="exp()">匯出</button><div id="emsg" class="row"></div></div>
  <div class="card"><h3>匯入備份</h3><div class="row"><label><input type="radio" name="im" value="merge" checked style="width:auto;min-height:0"> 合併（保留現有資料）</label><label><input type="radio" name="im" value="replace" style="width:auto;min-height:0"> 取代全部資料</label></div><input type="file" id="fi" accept=".json,application/json"><div id="imsg"></div></div>`;
  $('#fi').onchange = e => { if (e.target.files[0]) imp(e.target.files[0]); e.target.value = ''; };
}
async function exp() {
  try {
    const { json, missingImages } = await Q.exportBackup();
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(json)], { type: 'application/json' }));
    a.download = '識字備份-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); a.remove();
    $('#emsg').innerHTML = missingImages ? `<span class="warn">有 ${missingImages} 張手寫圖片找不到，備份中沒有包括這些圖片。</span>` : '';
  } catch (e) { $('#emsg').innerHTML = `<span class="warn">匯出失敗（${esc(reason(e))}）。</span>`; }
}
const list = (a, n) => a.slice(0, n).map(x => `<li>${esc(x)}</li>`).join('') + (a.length > n ? `<li>…還有 ${a.length - n} 項</li>` : '');
async function imp(f) {
  const msg = $('#imsg'), mode = document.querySelector('input[name=im]:checked').value; let json;
  try { json = JSON.parse(await f.text()); } catch (e) { msg.innerHTML = '<p class="warn">匯入失敗：檔案已損毀或格式不正確。現有資料沒有改動。</p>'; return; }
  let r;
  try { r = await Q.importBackup(json, mode, confirm); }
  catch (e) {
    msg.innerHTML = e.list ? `<p class="warn">匯入失敗，現有資料沒有改動：</p><ul class="warn">${list(e.list, 10)}</ul>` : `<p class="warn">匯入失敗（${esc(reason(e))}）。現有資料沒有改動。</p>`; return;
  }
  if (r.cancelled) return;
  if (r.aborted) { msg.innerHTML = `<p class="warn">沒有匯入任何資料：發現 ${r.conflicts.length} 項衝突，現有資料沒有改動。</p><ul class="warn">${list(r.conflicts, 10)}</ul><p><small>如要使用備份的內容，請先匯出目前的資料，再選擇「取代全部資料」。</small></p>`; return; }
  msg.innerHTML = `<p class="g">${r.mode === 'replace' ? '已取代全部資料' : '已合併'}：新增級別 ${r.added.levels}、新增字 ${r.added.chars}、新增紀錄 ${r.added.records}${r.identical ? `；${r.identical} 項資料已存在（相同），已略過` : ''}。</p>` +
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
async function boot() {
  try { store = CQStorage.createStore(await CQStorage.openDb(window.indexedDB)); }
  catch (e) { return fatal('無法使用儲存空間', '這個瀏覽器目前無法使用儲存空間（IndexedDB），所以不能儲存資料。請不要使用私密瀏覽，或換一個瀏覽器再試。'); }
  try { await CQStorage.migrateLegacy(store, window.localStorage); }
  catch (e) { return fatal('資料轉移未能完成', (e.parts && e.parts.length ? '核對時發現以下部分不相符：' + esc(e.parts.join('、')) + '。' : '') + '原有的資料沒有被刪除，也沒有改動。請按「重試」。如果仍然失敗，請先下載原有資料作備份。', true); }
  Q = new CQCore.Quiz(store); Q.onDraftError = showDraftError; Q.onDraftOk = hideErr;
  const flushNow = () => { if (Q.cur) Q.flushDraft().catch(() => { }); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });
  window.addEventListener('pagehide', flushNow);
  try { await Q.init(); } catch (e) { return fatal('無法讀取資料', '資料沒有被改動。請按「重試」。'); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
  if (Q.cur) { tab = Q.cur.mode === 'exam' ? 'exam' : 'practice'; toast('有未完成的測驗，可以繼續或放棄'); }
  if (window.speechSynthesis) speechSynthesis.getVoices();
  render();
}
window.__cqReady = boot();
