/* Story Reading: LOCAL story generation (no network, no AI service). A story is built from an approved template (a short narrative with a beginning, a
   middle and an end) whose slots (hero, place, item, friend ...) are filled from an approved lexicon (story-data.js). Choices are weighted by what this
   learner already knows, so the story is mostly made of familiar characters; the template's sentences are authored, so the grammar is natural.
   Jyutping and English come with the approved words, so they are never guessed.  Pure functions only: randomness (rng) and the learner's knowledge are
   inputs, which keeps everything testable. */
(function (root, factory) {
  const m = factory((typeof module === 'object' && module.exports) ? require('./story-data.js') : root.CQStoryData);
  if (typeof module === 'object' && module.exports) module.exports = m; else root.CQStory = m;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (D) {
  const PUNCT = '，。！？：「」、', isCJK = ch => /[\u3400-\u9fff]/.test(ch);
  const CORE = new Set([...D.CORE]);
  const LEN = { 1: [3, 5], 2: [5, 8], 3: [8, 12] };                 // sentences per difficulty
  const MAX_CHARS = { 1: 18, 2: 26, 3: 36 };                        // longest sentence (Chinese characters) per difficulty
  const MIN_FAMILIAR = { 1: 0.9, 2: 0.8, 3: 0.7 };                  // share of characters that are familiar (known or very common)
  const QUESTIONS = { 1: 2, 2: 3, 3: 3 };
  const SEX = { m: { he: 'he', He: 'He', his: 'his', him: 'him' }, f: { he: 'she', He: 'She', his: 'her', him: 'her' }, n: { he: 'it', He: 'It', his: 'its', him: 'it' } };

  /* ---- words ---- */
  const DICT = new Map();
  Object.entries(D.FUNC).forEach(([w, v]) => DICT.set(w, v ? { jp: v[0], en: v[1], c: v[2] ? 1 : 0 } : { jp: null, en: null, c: 0 }));
  Object.values(D.LEX).forEach(L => L.forEach(([z, jp, en]) => { if (!DICT.has(z)) DICT.set(z, { jp, en, c: 1 }); }));
  Object.entries(D.MEASURES).forEach(([z, [jp, en]]) => { if (!DICT.has(z)) DICT.set(z, { jp, en, c: 0 }); });
  const KEYS = [...DICT.keys()].sort((a, b) => b.length - a.length);
  /* a literal piece of a sentence -> tokens [text, jyutping | null, english | null, content word 1/0]; an unknown word is a data error, never guessed */
  function tokenize(lit) {
    const out = []; let i = 0;
    while (i < lit.length) { const k = KEYS.find(w => lit.startsWith(w, i)); if (!k) throw new Error('Unknown word in story data: ' + lit.slice(i)); const d = DICT.get(k); out.push([k, d.jp, d.en, d.c]); i += k.length; }
    return out;
  }
  const entry = (cat, [zh, jp, en, x]) => ({ zh, jp, en, cat, ...x, pr: x.pr || (cat === 'animal' ? '牠' : undefined), s: x.s || (cat === 'animal' ? 'n' : undefined) });
  const POOL = cat => (D.LEX[cat] || []).map(r => entry(cat, r));
  const chars = zh => [...zh].filter(isCJK);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const shuffle = (a, rng) => { const o = a.slice(); for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; };
  const slotsIn = t => new Set([...(t || '').matchAll(/\{(?:[A-Za-z]+:)?([a-z_]+)(?:\.[a-z]+)?\}/g)].map(m => m[1]));

  /* ---- expansion of a sentence pattern ---- */
  function expandZh(p, vals) {
    const toks = [], re = /\{([a-z]+)(?:\.([a-z]+))?\}/g; let last = 0, m;
    while ((m = re.exec(p))) {
      if (m.index > last) toks.push(...tokenize(p.slice(last, m.index)));
      const e = vals[m[1]]; if (!e) throw new Error('Slot not filled: ' + m[1]);
      if (!m[2]) toks.push([e.zh, e.jp, e.en, 1]);
      else if (m[2] === 'pr') toks.push([e.pr, 'taa1', SEX[e.s].he, 0]);
      else if (m[2] === 'm') { const d = DICT.get(e.m); toks.push([e.m, d.jp, d.en, 0]); }
      last = re.lastIndex;
    }
    if (last < p.length) toks.push(...tokenize(p.slice(last)));
    return toks;
  }
  function expandEn(p, vals) {
    return cap(p.replace(/\{(?:(He|he|his|him|a):)?([a-z_]+)(?:\.([a-z]+))?\}/g, (_, fn, name, sub) => {
      const e = vals[name]; if (!e) throw new Error('Slot not filled: ' + name);
      if (fn === 'a') return (e.an || /^[aeiou]/i.test(e.en) ? 'an ' : 'a ') + e.en;
      if (fn) return SEX[e.s || 'n'][fn];
      return sub === 'pl' ? e.pl : e.en;
    }));
  }
  const fillText = (t, vals) => t.replace(/\{([a-z]+)(?:\.([a-z]+))?\}/g, (_, n, sub) => { const e = vals[n]; return sub === 'pr' ? e.pr : sub === 'm' ? e.m : e.zh; });

  /* ---- how familiar is a text for this learner ---- */
  const isFamiliar = (c, known) => CORE.has(c) || (known && known.has(c));
  function measure(sentences, known, topicChars) {
    const all = sentences.flatMap(s => chars(s.zh)), fam = all.filter(c => isFamiliar(c, known)).length;
    const newChars = [...new Set(all.filter(c => !isFamiliar(c, known)))];
    let hits = 0; const words = new Set();
    if (topicChars) sentences.forEach(s => s.tokens.forEach(t => { if (t[3] && chars(t[0]).some(c => topicChars.has(c))) { hits++; words.add(t[0]); } }));
    return { familiar: all.length ? fam / all.length : 1, total: all.length, newChars, topicHits: hits, topicWords: [...words] };
  }

  /* ---- filling the slots ---- */
  function weight(e, known, topicChars, recent) {
    const cs = chars(e.zh), frac = cs.length ? cs.filter(c => isFamiliar(c, known)).length / cs.length : 1;
    let w = 1 + 6 * frac * frac;
    if (topicChars && cs.some(c => topicChars.has(c))) w *= 4;
    if (recent && recent.includes(e.zh)) w *= 0.3;
    return w;
  }
  const pick = (list, ws, rng) => { const t = ws.reduce((a, b) => a + b, 0); let r = rng() * t; for (let i = 0; i < list.length; i++) { r -= ws[i]; if (r < 0) return list[i]; } return list[list.length - 1]; };
  function fillSlots(tpl, used, ctx) {
    const vals = {};
    for (const name of Object.keys(tpl.slots)) {
      if (!used.has(name)) continue;
      const sp = tpl.slots[name], cats = [].concat(sp.cat);
      let c = cats.flatMap(POOL).filter(e => !(sp.not && sp.not.includes(e.zh)) && !(sp.tag && e.tag !== sp.tag) && !(sp.differ && vals[sp.differ] && e.zh === vals[sp.differ].zh) && !Object.values(vals).some(v => v.zh === e.zh));
      if (!c.length) return null;
      vals[name] = pick(c, c.map(e => weight(e, ctx.known, ctx.topicChars, name === 'hero' ? ctx.recentHeroes : null)), ctx.rng);
    }
    return vals;
  }

  /* ---- comprehension questions that come from the story's own content ---- */
  /* wrong answers / false statements may only use words that do NOT occur in the story, so a question can never be ambiguous */
  function poolFor(q, vals, text) {
    return [].concat(q.pool).flatMap(POOL).filter(e => !(q.not && q.not.includes(e.zh)) && !(q.differ && vals[q.differ] && e.zh === vals[q.differ].zh) && !(text && text.includes(e.zh)));
  }
  function buildQuestions(tpl, vals, rng, diff, text) {
    const qs = [];
    (tpl.questions || []).forEach(q => {
      const need = new Set([...slotsIn(q.zh), ...slotsIn(q.t), ...slotsIn(q.f), ...(q.ans && !q.opts ? [q.ans] : []), ...(q.swap ? [q.swap] : [])]);
      if (![...need].every(n => vals[n])) return;
      if (q.type === 'mc') {
        let correct, opts;
        if (q.opts) { correct = q.opts[q.ans]; opts = q.opts.slice(); if (opts.some((o, k) => k !== q.ans && text.includes(o))) return; }   // never ask a question with a second possible answer
        else { correct = vals[q.ans].zh; const dis = shuffle(poolFor(q, vals, text).filter(e => e.zh !== correct), rng).slice(0, 2).map(e => e.zh); if (dis.length < 2) return; opts = [correct, ...dis]; }
        opts = shuffle(opts, rng); qs.push({ type: 'mc', zh: fillText(q.zh, vals), options: opts, answer: opts.indexOf(correct) });
      } else {
        const truth = rng() < 0.5; let zh;
        if (q.t) zh = fillText(truth ? q.t : q.f, vals);
        else if (truth) zh = fillText(q.zh, vals);
        else { const alts = poolFor(q, vals, text).filter(e => e.zh !== vals[q.swap].zh); if (!alts.length) return; zh = fillText(q.zh, { ...vals, [q.swap]: pick(alts, alts.map(() => 1), rng) }); }
        qs.push({ type: 'tf', zh, options: ['對', '錯'], answer: truth ? 0 : 1 });
      }
    });
    const mcs = shuffle(qs.filter(q => q.type === 'mc'), rng), tfs = shuffle(qs.filter(q => q.type === 'tf'), rng), n = QUESTIONS[diff] || 2, out = [];
    while (out.length < n && (mcs.length || tfs.length)) { const nx = (out.length === 1 && tfs.length ? tfs : mcs.length ? mcs : tfs).shift(); out.push(nx); }
    return out;
  }

  /* ---- one story from one template ---- */
  function build(tpl, diff, ctx) {
    const topicId = ctx.topic && ctx.topic.id;
    /* the sentences for this difficulty; from intermediate on, a sentence may be replaced by its richer variant (longer, with more varied structure) */
    const inc = tpl.sentences.filter(s => (s.d[0] <= diff && diff <= s.d[1]) || (topicId && s.t && s.t.includes(topicId)))
      .map(s => { const v = (s.alt || []).filter(a => a.d <= diff).sort((x, y) => y.d - x.d)[0]; return v ? { ...s, zh: v.zh, en: v.en } : s; });
    const used = new Set([...slotsIn(tpl.title.zh), ...inc.flatMap(s => [...slotsIn(s.zh)])]);
    const vals = fillSlots(tpl, used, ctx); if (!vals) return null;
    const sentences = inc.map(s => { const tokens = expandZh(s.zh, vals); return { zh: tokens.map(t => t[0]).join(''), en: expandEn(s.en, vals), tokens }; });
    const questions = buildQuestions(tpl, vals, ctx.rng, diff, sentences.map(s => s.zh).join(''));
    const m = measure(sentences, ctx.known, ctx.topicChars);
    const heroZh = vals.hero ? vals.hero.zh : null;
    return { tpl: tpl.id, hero: heroZh, title: { zh: expandZh(tpl.title.zh, vals).map(t => t[0]).join(''), en: expandEn(tpl.title.en, vals) }, sentences, questions, ...m };
  }
  const structurallyValid = (c, diff) => {
    const [lo, hi] = LEN[diff]; if (c.sentences.length < lo || c.sentences.length > hi) return false;
    if (new Set(c.sentences.map(s => s.zh)).size !== c.sentences.length) return false;
    if (c.sentences.some(s => chars(s.zh).length > MAX_CHARS[diff])) return false;
    return c.questions.length >= 2;
  };

  /* Generate one story.  known: Set of characters the learner knows; topic: { id, chars: Set } or null; recent: [{ template, hero }] of the latest stories. */
  function generate(o) {
    o = o || {}; const diff = [1, 2, 3].includes(o.difficulty) ? o.difficulty : 1, rng = o.rng || Math.random, known = o.known || new Set();
    const topic = o.topic || null, topicChars = topic ? topic.chars : null, recent = o.recent || [];
    const ctx = { known, topic, topicChars, rng, recentHeroes: recent.map(r => r.hero).filter(Boolean) };
    const need = topic ? 1 : 0, recentT = recent.map(r => r.template), cands = [];
    const tws = D.TEMPLATES.map(t => (topic && t.tags.includes(topic.id) ? 5 : 1) * (recentT[0] === t.id ? 0.05 : recentT.includes(t.id) ? 0.3 : 1));
    for (let i = 0; i < (o.tries === undefined ? 40 : o.tries); i++) {
      const tpl = pick(D.TEMPLATES, tws, rng), c = build(tpl, diff, ctx);
      if (c && structurallyValid(c, diff)) cands.push(c);
    }
    const fallbacks = D.FALLBACKS.map(f => build(f, diff, ctx)).filter(Boolean);
    const topicOk = c => !topic || c.topicHits >= need, score = c => c.familiar + (topic ? Math.min(c.topicHits, 4) * 0.05 : 0) + (recentT.includes(c.tpl) ? -0.1 : 0) + rng() * 0.03;
    const good = cands.filter(c => c.familiar >= MIN_FAMILIAR[diff] && topicOk(c)).sort((a, b) => score(b) - score(a));
    let best, generated = true;
    if (good.length) {                                                       // any good story, not always the same one; with a topic, the ones that use it most
      const mh = topic ? Math.max(...good.map(c => c.topicHits)) : 0, pool = good.filter(c => !topic || c.topicHits >= Math.max(need, mh - 1));
      const top = Math.max(...pool.map(c => c.familiar)), near = pool.filter(c => c.familiar >= top - 0.07); best = near[Math.floor(rng() * near.length)];
    }
    if (!best) {                                                                                     // nothing good enough: prefer an authored fixed story that is, else the least bad
      const fbs = fallbacks.filter(c => c.familiar >= MIN_FAMILIAR[diff] && topicOk(c)), fbTop = fbs.filter(c => !recentT.includes(c.tpl)), fbPool = fbTop.length ? fbTop : fbs, fb = fbPool[Math.floor(rng() * fbPool.length)];   // any suitable fixed story, preferably not a recent one
      const rest = cands.filter(topicOk).sort((a, b) => b.familiar - a.familiar)[0] || cands.sort((a, b) => b.familiar - a.familiar)[0];
      if (fb) { best = fb; generated = false; } else if (rest) best = rest; else { best = fallbacks.sort((a, b) => b.familiar - a.familiar)[0]; generated = false; }
    }
    if (!best) throw new Error('No story could be produced');
    return { title: best.title, template: best.tpl, hero: best.hero, topic: topic ? topic.id : null, difficulty: diff, generated, sentences: best.sentences, questions: best.questions,
      familiar: Math.round(best.familiar * 1000) / 1000, total: best.total, newChars: best.newChars, topicWords: best.topicWords, topicMatched: topicOk(best), lowFamiliarity: best.familiar < MIN_FAMILIAR[diff] };
  }
  /* a starting difficulty from how many characters the learner knows */
  const suggestDifficulty = n => (n < 60 ? 1 : n < 200 ? 2 : 3);
  const storyText = s => s.sentences.map(x => x.zh).join('');
  return { generate, tokenize, measure, suggestDifficulty, storyText, isFamiliar, CORE, LEN, MAX_CHARS, MIN_FAMILIAR, QUESTIONS, DICT, DATA: D, chars, isCJK };
});
