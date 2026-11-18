#!/usr/bin/env node
/* Keeps VERSION in public/sw.js equal to the hash of every precached file, so that the cache name changes exactly when an asset changes
   (and the changed sw.js makes browsers install the new version).
     node scripts/stamp-sw.js          rewrite VERSION in public/sw.js
     node scripts/stamp-sw.js --check  exit 1 if VERSION is out of date */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const PUB = path.join(__dirname, '..', 'public');

function precacheList(src) {
  const m = /const PRECACHE = (\[[\s\S]*?\]);/.exec(src); if (!m) throw new Error('PRECACHE not found in sw.js');
  return new Function('return ' + m[1])();
}
function computeVersion(pub) {
  pub = pub || PUB;
  const list = precacheList(fs.readFileSync(path.join(pub, 'sw.js'), 'utf8'));
  const h = crypto.createHash('sha256');
  for (const p of list) { const file = p === './' ? 'index.html' : p; h.update(file + '\0'); h.update(fs.readFileSync(path.join(pub, file))); h.update('\0'); }
  return h.digest('hex').slice(0, 12);
}
function currentVersion(pub) { const m = /const VERSION = '([^']*)'/.exec(fs.readFileSync(path.join(pub || PUB, 'sw.js'), 'utf8')); return m && m[1]; }
module.exports = { precacheList, computeVersion, currentVersion };

if (require.main === module) {
  const want = computeVersion(), have = currentVersion();
  if (process.argv.includes('--check')) { if (want !== have) { console.error('sw.js VERSION is ' + have + ' but should be ' + want + ' - run: npm run stamp-sw'); process.exit(1); } console.log('sw.js VERSION ok (' + have + ')'); }
  else {
    const f = path.join(PUB, 'sw.js'), s = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, s.replace(/const VERSION = '[^']*'/, "const VERSION = '" + want + "'")); console.log('sw.js VERSION = ' + want);
  }
}
