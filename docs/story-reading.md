# Story Reading (故事閱讀)

A separate reading activity (own nav tab). It writes no records, statistics, mastery or exam results, and never creates character-learning records.

## Local story generation (no network, no AI service) – `public/js/story.js`, content in `public/js/story-data.js`
- **Approved content only.** `story-data.js` holds the lexicon (`LEX`: heroes, places, items, foods, colours, vehicles ...), function words (`FUNC`), 10 story templates and
  7 fixed stories. Every word has Jyutping and English; the Jyutping was cross-checked against the pycantonese dictionary data (the common spoken reading is kept where
  they differ, e.g. 公園 gung1 jyun2). A sentence is a pattern such as `{hero}去{place}玩。`; it is tokenized into approved words, so an unknown word is a data error
  (never guessed) and Jyutping is only ever shown for whole approved words.
- **Structure.** Each template is a short story with a beginning, a middle and an end. Sentences carry a difficulty range; from intermediate on a sentence can be replaced
  by a richer variant (`alt`: longer, with because/so, while ...). Length: beginner 3–5, intermediate 5–8, advanced 8–12 sentences.
- **Learner knowledge.** `Quiz.knownGlyphs()` = characters learned through practice (curriculum or topic: `TOPIC.LEARNED_STREAK` correct in a row) plus all characters of levels
  marked mastered; ~150 very common characters (`CORE`) always count as familiar. Slot words are drawn with weights that favour familiar characters; candidates must reach
  90% / 80% / 70% familiar characters (beginner / intermediate / advanced); the best of up to 40 candidates is chosen at random among the good ones (variety), avoiding the
  latest templates and heroes. If nothing is good enough a fixed authored story is used. New characters are marked with a dotted underline and listed after reading.
- **Topics.** With a topic, the story must contain words that carry the topic's characters (from the topic pack), and the candidates using the topic most win. The learner need not know the topic.
- **Questions.** 2–3 per story (multiple choice / true-false) are built from the story's own slot values; wrong options and false statements only use words that do not occur in the story.
- **Difficulty** is chosen by the learner (the suggestion comes from how many characters are known; there is no age field).

## Audio
Reuses the existing zh-HK speech (`speak`, voice choice, rate). A character tap speaks that character; a sentence tap the sentence; "play whole story" hands every sentence to the
speech service at once (`speakList`: no timers, so no gaps of our own) and highlights the sentence from `onstart`; stop = `cancel()`.

## Data
Per learner (profile DB v6, store `stories`): the story as generated plus progress (page, reading time, completed, audio used, comprehension score). Part of the existing profile
backup (`data.stories`); merge never overwrites a learner's own stories; older backups import unchanged. No reward system exists in the app, so none is touched.
