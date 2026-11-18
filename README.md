# 識字小天地 (cantonese-quiz)

Browser-based Traditional Chinese / Cantonese character quiz for a child, with parent marking.
Pure HTML/CSS/JS, client-side only. Open `index.html` in a browser (or serve the folder statically).

## Features
- Levels and characters (stable IDs), reading practice, writing practice (listen and write), reading/writing exams (20 unique characters), revision, learning history, JSON backup/import (replace or merge).
- Pronunciation uses browser SpeechSynthesis (`zh-HK`) when available.

## Known limitations
- Backup is JSON (handwriting images embedded), not ZIP.
- No local audio upload yet.
- Handwriting on the current question is autosaved shortly after each stroke (restored at slightly lower image quality); a stroke made in the last fraction of a second before a crash or reload can still be lost.

## Storage
Levels, records, handwriting images and the unfinished session are stored in IndexedDB (`cantonese-quiz`). Data from older versions in `localStorage` is migrated automatically and is only removed after the copy has been verified.

## Learner profiles
Each learner has a separate IndexedDB database (`cantonese-quiz-<profileId>`) holding their levels, characters, records, handwriting images, unfinished session and draft, so data cannot mix between learners. The learner list (id, name, avatar, createdAt, updatedAt, archivedAt) lives in `cantonese-quiz-profiles`. The database that existed before profiles (`cantonese-quiz`) is adopted in place as the default learner `p-legacy`; nothing is copied, rewritten or deleted. The active learner is remembered per browser tab (sessionStorage), so a refresh stays on the same learner while a newly opened app asks who is learning. Backup export/import (Settings) applies to the active learner only.

## Writing practice details
- A new writing question automatically pronounces the isolated target character once (browser SpeechSynthesis, zh-HK). The compound word is only played by its own button. Resuming a session or re-rendering never replays it.
- The completion screen shows the elapsed wall-clock time (from the stored session start to completion). Records keep both `started` and `date` (completion) timestamps; older records without `started` show the duration as unavailable.
- After marking a writing practice, revision or exam, every wrongly written character gets a "write it five times" activity (stored in the `corrections` store of the learner's database, separate from the original record, which is never changed). Each attempt is a separate canvas and saved image.

## Installable app / offline use (PWA)
`public/manifest.webmanifest` (name Cantonese Quiz, short name 中文識字, standalone), `public/icons/*` and `public/sw.js` make the site installable (iPad Safari: Share > Add to Home Screen) and usable offline. All paths are relative, so it works at the domain root or under a sub-path; Cloudflare serves `public/` as static assets (`public/_headers` sets the service-worker cache header).

- The service worker precaches the app shell as one versioned cache and serves it cache-first. It never stores learner data (that stays in IndexedDB) and never touches IndexedDB.
- A new version is downloaded in the background and waits. The app shows 「有新版本可以使用」; the learner applies it with 立即更新, which is refused while a question, marking or a correction is in progress. Closing and reopening the app also loads the new version.
- **After changing any file in `public/`, run `npm run stamp-sw`** (updates `VERSION` in `sw.js` to the hash of the cached files). The test suite fails if this was forgotten, or if a new file in `public/` is missing from the `PRECACHE` list in `sw.js`.
- Manual device checklist: `docs/pwa-manual-testing.md`.

## Tests
`npm install && npm test` (Node 22.22.2+, 24.15+ or 26+, as required by `jsdom`; uses `node --test`, `fake-indexeddb` and `jsdom`).
