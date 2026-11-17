# 識字小天地 (cantonese-quiz)

Browser-based Traditional Chinese / Cantonese character quiz for a child, with parent marking.
Pure HTML/CSS/JS, client-side only. Open `index.html` in a browser (or serve the folder statically).

## Features
- Levels and characters (stable IDs), reading practice, writing practice (listen and write), reading/writing exams (20 unique characters), revision, learning history, JSON backup/import (replace or merge).
- Pronunciation uses browser SpeechSynthesis (`zh-HK`) when available.

## Known limitations
- Backup is JSON (handwriting images embedded), not ZIP.
- No local audio upload yet; data is in localStorage (not IndexedDB).
- No automated tests or CI yet.
