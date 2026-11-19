/* The real page under jsdom: several unfinished activities are listed, resumed independently, and survive a page reload. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const P = require('../public/js/profiles.js');
const { newIdb, CH, level } = require('./helpers');

const PUB = path.join(__dirname, '../public');
const pageHtml = () => fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/<script src="([^"]+)"><\/script>/g, (_, f) => '<script>' + fs.readFileSync(path.join(PUB, f), 'utf8') + '</script>');
const tick = () => new Promise(r => setTimeout(r, 30));
const ev = (dom, code) => dom.window.eval(code);
const main = dom => dom.window.document.querySelector('#main').textContent;
async function openPage(idb, active) {
  const dom = new JSDOM(pageHtml(), { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    w.indexedDB = idb; w.confirm = () => true; w.alert = () => { }; if (active) w.sessionStorage.setItem('cq-active-profile', active);
    w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() { }, beginPath() { }, moveTo() { }, lineTo() { }, stroke() { }, drawImage() { }, set lineWidth(v) { }, set lineCap(v) { }, set lineJoin(v) { }, set strokeStyle(v) { }, set fillStyle(v) { } });
    w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,/9j/AAAA';
  } });
  await dom.window.__cqReady; await tick(); return dom;
}

const lvl = (id, name, cs) => ({ id, name, desc: '', chars: cs.map((c, i) => ({ id: id + '-' + i, c, jp: '', w: '', wjp: '', m: '' })), created: 1, modified: 1 });

test('page: content can be managed and imported before any learner exists, and every learner then sees it', async () => {
  const idb = newIdb(); let dom = await openPage(idb);
  assert.match(main(dom), /選擇學習者/); assert.match(main(dom), /學習內容/); assert.match(main(dom), /內容與備份/);
  ev(dom, "pview = 'content'; lid = null; render()"); await tick();
  assert.match(main(dom), /級別管理/); assert.match(main(dom), /所有學習者共用/); assert.equal(ev(dom, 'Q || null'), null);
  await ev(dom, `commitLevels(ls => ls.push(${JSON.stringify(lvl('L1', '一級', ['日', '月']))}))`); await tick();
  assert.match(main(dom), /一級/); assert.equal(JSON.stringify(await ev(dom, 'mgr.list("all")')), '[]');   // still no learner
  // import more content from a backup file (still no learner); the learner entry of the file is not assigned to anyone
  ev(dom, "pview = 'backup'; render()"); await tick(); assert.match(main(dom), /匯出/); assert.match(main(dom), /匯入/);
  const file = { format: 'cq-backup', schemaVersion: 2, exportedAt: 'x', content: { levels: [lvl('L2', '二級', ['火'])] }, profiles: [{ profileId: 'other', profileName: '別人', data: { records: [] } }] };
  await ev(dom, `bkLoad({ text: async () => ${JSON.stringify(JSON.stringify(file))} })`); await tick();
  assert.match(main(dom), /備份中有 1 個級別/); assert.match(main(dom), /別人/); assert.match(main(dom), /略過/); assert.equal(JSON.stringify(ev(dom, 'bk.targets')), '["skip"]');
  await ev(dom, 'bkRun()'); await tick(); assert.match(main(dom), /學習內容已合併：1 個級別/); assert.match(main(dom), /已略過/); assert.equal(JSON.stringify(ev(dom, 'CT.levels.map(l => l.name)')), '["一級","二級"]');
  assert.equal(ev(dom, 'document.querySelectorAll(".xp").length'), 0, 'export lists no learners when there are none'); dom.window.close();
  // a learner created afterwards uses the content without importing anything
  dom = await openPage(idb); const id = await ev(dom, 'mgr.create({ name: "新", avatar: "cat" }).then(p => p.id)');
  await ev(dom, `selectProfile('${id}')`); await tick(); assert.match(main(dom), /一級/); assert.match(main(dom), /二級/);
  ev(dom, "go('set')"); await tick(); assert.match(main(dom), /內容與備份/);
  ev(dom, "go('backup')"); await tick(); assert.match(main(dom), /新 的學習進度/); assert.match(main(dom), /2 個級別/); dom.window.close();
});
