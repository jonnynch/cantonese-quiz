# Shared content and per-learner progress

**Shared content (global)** – levels and their characters/words (`levels[].chars[]` holds `c`, `jp`, `w`, `wjp`, `m`).
Stored once in the registry database (`cantonese-quiz-profiles`, store `levels`), so it exists with no learner and is the same for every learner.
Managed through `SharedContent` (core.js); reachable from the learner picker ("學習內容", "內容與備份") and from inside a learner.

**Per-learner progress** – records, images, unfinished sessions, drafts, writing corrections and adaptive statistics, each learner in its own
database (`cantonese-quiz-<id>`). Records and statistics refer to levels/characters by id only.

## Backup file (`format: "cq-backup"`, `schemaVersion: 2`)
`content.levels` is written once; `profiles[]` has one entry per learner (`profileId`, `profileName`, `avatar`, `data`: records, sessions, drafts,
corrections, stats). Either part may be missing. Legacy files (`version: 1`, one learner's levels + progress) are still read: the levels become the
content, the progress an unnamed learner that is never assigned automatically.

Import: content is merged (default; conflicts abort and change nothing), replaced (explicit) or skipped. Each learner in the file is imported
only into the local learner with the SAME `profileId` (suggested), a learner the user picks, or a new learner – otherwise skipped. Two file
learners can never share one target. Progress is always merged (never overwrites).

## Migration of older installs (`migrateSharedContent`, runs at start, once)
1. read the shared content and the levels of every learner (also archived ones);
2. merge deterministically: a level/character is identified by its id; for the same level the version with the newest `modified` wins
   (ties: existing shared content, then the earlier created learner); characters the winner lacks are added from the other versions; a
   character id used in two levels keeps the first; levels with equal names but different ids stay separate (nothing is guessed);
3. save to the shared store, read it back and compare;
4. only then remove the old copies from the learners and record completion. A failure leaves every original copy untouched and is retried at
   the next start; a finished migration is skipped, so running it again changes nothing.
