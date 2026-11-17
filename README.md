# 識字小天地 (cantonese-quiz)

Browser-based Traditional Chinese / Cantonese character quiz for a child, with parent marking.
Pure HTML/CSS/JS, client-side only. Open `index.html` in a browser (or serve the folder statically).

## Features
- Levels and characters (stable IDs), reading practice, writing practice (listen and write), reading/writing exams (20 unique characters), revision, learning history, JSON backup/import (replace or merge).
- Pronunciation uses browser SpeechSynthesis (`zh-HK`) when available.

## Known limitations
- Backup is JSON (handwriting images embedded), not ZIP.
- No local audio upload yet.
- A handwriting stroke that has not been saved yet (current question) is lost if the page is reloaded; all completed questions are kept.

## Storage
Levels, records, handwriting images and the unfinished session are stored in IndexedDB (`cantonese-quiz`). Data from older versions in `localStorage` is migrated automatically and is only removed after the copy has been verified.

## Tests
`npm install && npm test` (Node 20+; uses `node --test`, `fake-indexeddb` and `jsdom`).
