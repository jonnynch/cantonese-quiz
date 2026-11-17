/* End-to-end smoke test of the real page (public/index.html + js/*) in jsdom with a fake IndexedDB. */
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { newIdb, legacyBlob } = require('./helpers');
const { S } = require('./helpers');

const fs = require('node:fs');
const PUB = path.join(__dirname, '../public');
function pageHtml() {   // inline the local scripts so the page can run on an http origin (localStorage needs a non-opaque origin)
  return fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/<script src="([^"]+)"><\/script>/g, (_, f) => '<script>' + fs.readFileSync(path.join(PUB, f), 'utf8') + '</script>');
}
async function openPage(idb, legacy) {
  const dom = new JSDOM(pageHtml(), {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.indexedDB = idb; w.confirm = () => true; w.alert = () => { }; if (legacy) w.localStorage.setItem(S.LEGACY_KEY, legacy); },
  });
  await dom.window.__cqReady;
  return dom;
}
const text = dom => dom.window.document.querySelector('#main').textContent;
const tick = () => new Promise(r => setTimeout(r, 20));

test('page boots, migrates legacy data, and an unfinished session survives a page reload', async () => {
  const idb = newIdb();
  let dom = await openPage(idb, legacyBlob());
  // legacy session (write, question 2 of 2) was migrated and the user is taken to the practice tab with resume/discard
  assert.match(text(dom), /有未完成的聽音寫字/); assert.match(text(dom), /第 2 \/ 2 題/);
  assert.equal(dom.window.localStorage.getItem(S.LEGACY_KEY), null);
  dom.window.eval('discard()'); await tick();                          // confirm() stubbed to true
  assert.doesNotMatch(text(dom), /有未完成/);
  dom.window.eval("start('read','L1','practice')"); await tick();
  dom.window.eval('mark(true)'); await tick();
  assert.match(text(dom), /2 \/ 2/);
  dom.window.close();

  dom = await openPage(idb);                                           // simulated browser refresh
  assert.match(text(dom), /有未完成的讀字練習/); assert.match(text(dom), /第 2 \/ 2 題/);
  assert.equal(dom.window.eval('tab'), 'practice');
  dom.window.eval('resume()'); await tick();
  assert.match(text(dom), /2 \/ 2/);                                   // continues at the second question
  dom.window.eval('leave()'); await tick();
  assert.match(text(dom), /有未完成的讀字練習/);                        // leaving did not delete it
  dom.window.close();
});

test('page shows a clear error when IndexedDB is unavailable', async () => {
  const dom = await openPage(undefined);
  assert.match(text(dom), /無法使用儲存空間/);
  dom.window.close();
});

test('page: a failed save shows an error banner, stays on the question, and retry then advances', async () => {
  const idb = newIdb();
  const dom = await openPage(idb, legacyBlob());
  dom.window.eval('discard()'); await tick();
  dom.window.eval("start('read','L1','practice')"); await tick();
  dom.window.eval('Q.store = { ...Q.store, saveSession: () => Promise.reject(Object.assign(new Error("x"), { code: "quota" })) }'); // simulate full storage
  dom.window.eval('mark(true)'); await tick();
  const bar = dom.window.document.querySelector('#errbar');
  assert.ok(bar && !bar.hidden); assert.match(bar.textContent, /沒有儲存成功/); assert.match(bar.textContent, /儲存空間不足/);
  assert.match(text(dom), /1 \/ 2/);                                   // still on question 1
  dom.window.eval('Q.store = store'); dom.window.eval('retrySave()'); await tick();
  assert.match(text(dom), /2 \/ 2/); assert.ok(dom.window.document.querySelector('#errbar').hidden);
  dom.window.close();
});
