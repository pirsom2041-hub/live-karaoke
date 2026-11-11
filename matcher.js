// Song identification + line following over noisy Hebrew transcripts.
// Pure logic, no DOM: runs in the browser and in Node tests. All times are seconds on one shared clock.

const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const HALLU = [/תודה (רבה )?(על|ש)(ה)?צפי/, /כתוביות/, /תרגום:/, /תמלול:/, /amara/i, /subtitles/i, /^תודה\.?$/, /^תודה רבה\.?$/, /^מוזיקה\.?$/, /^\[.*\]$/];

export function norm(s) {
  return String(s).normalize('NFKC')
    .replace(/[֑-ׇ]/g, '')
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .toLowerCase()
    .replace(/[^א-תa-z0-9]+/g, ' ')
    .replace(/וו/g, 'ו').replace(/יי/g, 'י')
    .trim();
}

export function grams(n) {
  const p = ` ${n} `;
  const out = new Set();
  for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  return out;
}

export function createMatcher(catalog, opts = {}) {
  const O = {
    lineMin: 0.55,     // share of a line's weighted trigrams that must appear in the chunk to count
    lockChunk: 0.9,    // chunk score (in "typical lines") needed to lock
    lockEv: 1.2,       // accumulated evidence needed to lock
    lockRatio: 1.8,    // lead over the runner-up
    switchChunk: 1.6,  // chunk score for another song that steals the lock
    decay: 0.6,
    lostAfter: 150,    // seconds without any match before the lock is released (far-field audio matches rarely)
    hypMin: 0.45,      // weakest candidate worth a second, lyric-hinted transcription
    verifyMin: 2.5,    // score the hinted transcription must reach to lock
    onEvent: () => {},
    ...opts,
  };

  // ---- index ----
  const df = new Map();
  let nDocs = 0;
  for (const s of catalog.songs) for (const sec of s.sections) for (const l of sec.lines) {
    nDocs++;
    for (const g of grams(norm(l.x))) df.set(g, (df.get(g) || 0) + 1);
  }
  const idfMax = Math.log(1 + Math.max(nDocs, 50));
  const idf = (g) => { const d = df.get(g); return d ? Math.log(1 + nDocs / d) : idfMax; };
  const weigh = (gs) => { let w = 0; for (const g of gs) w += idf(g); return w; };
  const cont = (g, w, T) => { let c = 0; for (const x of g) if (T.has(x)) c += idf(x); return w ? c / w : 0; };
  const mkLine = (l) => {
    const n = norm(l.x);
    const g = [...grams(n)];
    return { a: l.a, b: l.b, x: l.x, n, g, w: weigh(g), k: n ? n.split(' ').length : 0 };
  };
  const songs = catalog.songs.map((s) => {
    // A song may carry two names ("a · b"); each is checked on its own.
    const titles = s.title.split('·').map((t) => { const tn = norm(t); const tg = [...grams(tn)]; return { tg, tw: weigh(tg), tk: tn.split(' ').length, mul: 1 }; }).filter((t) => t.tw);
    return {
      id: s.id, title: s.title, album: s.album, year: s.year, dur: s.dur, titles,
      sections: s.sections.map((sec) => ({ src: sec.src, live: !!sec.live, full: !!sec.full, lines: sec.lines.map(mkLine).filter((l) => l.k > 0) })),
      learned: null,
    };
  });
  const byId = new Map(songs.map((s) => [s.id, s]));
  // A title that is an everyday phrase ("רוצה אותך") shows up inside other songs, so it is weak evidence.
  const fullText = songs.map((s) => grams(s.sections.flatMap((sec) => sec.lines.map((l) => l.n)).join(' ')));
  songs.forEach((s, i) => {
    for (const t of s.titles) {
      let other = 0;
      fullText.forEach((G, j) => { if (j !== i && cont(t.tg, t.tw, G) >= 0.85) other++; });
      t.mul = (t.tk >= 2 ? 1.5 : 0.7) / (1 + 3 * other);
    }
  });
  const allW = songs.flatMap((s) => s.sections.flatMap((sec) => sec.lines.map((l) => l.w))).sort((a, b) => a - b);
  const unit = allW.length ? allW[Math.floor(allW.length / 2)] : 60;

  const secsOf = (s) => (s.learned ? [...s.sections, s.learned] : s.sections);

  // ---- state ----
  const st = {
    phase: 'idle',       // idle | listening | locked
    song: null, manual: false, mode: 'captions', // karaoke | captions
    anchor: null,        // { sec, offset } while running, or { sec, idx, paused: true } while waiting for a tap or a match
    hold: false,         // the user set the timing by hand
    lastMatch: 0, lockedAt: 0, miss: 0,
    ev: new Map(), captions: [], pending: [], heard: '', conf: 0, lastCapEnd: 0,
  };

  // Real lyrics (from the web) are the only thing ever displayed for a song that has them:
  // clip transcripts and live captions contain misheard words and serve as matching evidence only.
  const fullSec = (song) => song.sections.find((sec) => sec.full && sec.lines.length) || null;
  const showSecs = (song) => { const f = fullSec(song); return f ? [f] : secsOf(song); };
  // Without real lyrics, the section with the most words is the one shown when a song is picked by hand.
  const mainSec = (song) => {
    const f = fullSec(song);
    if (f) return f;
    let best = null, n = 0;
    for (const sec of song.sections) { const w = sec.lines.reduce((a, l) => a + l.k, 0); if (w > n) { n = w; best = sec; } }
    return best;
  };
  const sheet = (song) => { const sec = mainSec(song); return sec ? { sec, idx: 0, paused: true } : null; };

  function scoreSongs(T, t0) {
    const out = [];
    for (const s of songs) {
      // Evidence = weight of the distinct trigrams matched through lines that are mostly present.
      // Counting trigrams once keeps a repeated or near-identical line from scoring twice.
      const hit = new Set();
      for (const sec of secsOf(s)) for (const l of sec.lines) {
        if (l.k < 3) continue; // one- and two-word lines turn up in any song
        if (sec.learned && l.b > t0 - 2) continue; // never match a chunk against what it just taught us
        if (cont(l.g, l.w, T) >= O.lineMin) for (const g of l.g) if (T.has(g)) hit.add(g);
      }
      let sc = 0;
      for (const g of hit) sc += idf(g);
      let bonus = 0;
      for (const t of s.titles) if (cont(t.tg, t.tw, T) >= 0.85) bonus = Math.max(bonus, t.tw * t.mul);
      sc += bonus;
      if (sc > 0) out.push([s, sc / unit]);
    }
    return out.sort((a, b) => b[1] - a[1]);
  }

  // Where in the chunk was this line sung? Best window of consecutive words.
  function locate(line, words) {
    let best = null;
    for (const k of [line.k, line.k + 1, line.k - 1, line.k + 2]) {
      if (k < 1 || k > words.length) continue;
      for (let i = 0; i + k <= words.length; i++) {
        const G = grams(words.slice(i, i + k).map((w) => w.n).join(' '));
        const c = cont(line.g, line.w, G);
        const extra = G.size ? [...G].filter((g) => !line.g.includes(g)).length / G.size : 0;
        const sim = c - 0.3 * extra;
        if (!best || sim > best.sim) best = { sim, s: words[i].s, e: words[i + k - 1].e };
      }
    }
    return best;
  }

  function matchLines(song, T, words, t0) {
    const cands = [];
    const cur = st.anchor && !st.anchor.paused ? st.anchor : null;
    for (const sec of showSecs(song)) sec.lines.forEach((l, i) => {
      if (sec.learned && l.b > t0 - 2) return;
      if (l.k < 2) return;
      const c = cont(l.g, l.w, T);
      if (c < 0.6) return;
      const loc = words.length ? locate(l, words) : null;
      if (!loc || loc.sim < 0.45) return;
      cands.push({ sec, i, offset: loc.s - l.a, w: l.w * c });
    });
    if (!cands.length) return null;
    const bySec = new Map();
    for (const c of cands) bySec.set(c.sec, (bySec.get(c.sec) || 0) + c.w);
    let sec = null, top = 0;
    for (const [s, w] of bySec) { const ww = w * (st.anchor && st.anchor.sec === s ? 1.2 : 1); if (ww > top) { top = ww; sec = s; } }
    const cs = cands.filter((c) => c.sec === sec);
    let best = null;
    for (const center of cs) {
      const group = cs.filter((c) => Math.abs(c.offset - center.offset) <= 1.5);
      let sup = group.reduce((n, c) => n + c.w, 0);
      if (cur && cur.sec === sec && Math.abs(center.offset - cur.offset) <= 3) sup *= 1.3;
      if (!best || sup > best.sup) best = { sup, group };
    }
    const tw = best.group.reduce((n, c) => n + c.w, 0);
    const offset = best.group.reduce((n, c) => n + c.offset * c.w, 0) / tw;
    return { sec, offset, support: tw / unit };
  }

  function learn(song, caps) {
    if (!caps.length || fullSec(song)) return;
    if (!song.learned) song.learned = { src: 'live', learned: true, lines: [] };
    const have = new Set(secsOf(song).flatMap((sec) => sec.lines.map((l) => l.n)));
    for (const c of caps) {
      const l = mkLine(c);
      if (l.k < 2 || have.has(l.n)) continue;
      have.add(l.n);
      song.learned.lines.push(l);
    }
  }

  function lock(song, now, manual) {
    const prev = st.song;
    st.phase = 'locked'; st.song = song; st.manual = !!manual; st.hold = false;
    // Known lyrics are on screen from the first moment, waiting for a tap or a match to start moving.
    st.anchor = sheet(song); st.mode = st.anchor ? 'karaoke' : 'captions';
    st.lastMatch = now; st.lockedAt = now; st.miss = 0;
    learn(song, st.pending.filter((c) => c.a > now - 75));
    st.pending = [];
    if (prev !== song) O.onEvent({ type: 'lock', song: pub(song), manual: !!manual, at: now });
  }

  function unlock(now, why) {
    if (st.phase !== 'locked') return;
    O.onEvent({ type: 'unlock', song: pub(st.song), why, at: now });
    st.phase = 'listening'; st.song = null; st.manual = false; st.hold = false; st.anchor = null; st.mode = 'captions'; st.pending = [];
  }

  const pub = (s) => s && { id: s.id, title: s.title, album: s.album, year: s.year };

  function parse({ t0, tr }) {
    const segs = (tr.segments || []).filter((s) => {
      const x = (s.text || '').trim();
      if (!x) return false;
      if ((s.no_speech_prob > 0.6 && s.avg_logprob < -0.8) || s.compression_ratio > 2.4) return false;
      return !HALLU.some((re) => re.test(x));
    });
    const inSeg = (w) => segs.some((s) => w.start >= s.start - 0.1 && w.end <= s.end + 0.1);
    const words = (tr.words || []).filter(inSeg).map((w) => ({ n: norm(w.word), s: t0 + w.start, e: t0 + w.end })).filter((w) => w.n);
    const text = segs.map((s) => s.text.trim()).join(' ');
    // Low-confidence segments still count as matching evidence, but they read as nonsense, so they are never displayed.
    const caps = segs.filter((s) => !(s.avg_logprob < -0.75) && !(s.no_speech_prob > 0.5))
      .map((s) => ({ a: t0 + s.start, b: t0 + s.end, x: s.text.trim().replace(/[.,!?"]/g, '') }));
    return { words, text, caps, T: grams(norm(text)) };
  }

  function follow(T, words, t0, t1, caps) {
    const m = matchLines(st.song, T, words, t0);
    if (m && m.support >= 0.7) {
      const a = st.anchor;
      const same = a && !a.paused && a.sec === m.sec && Math.abs(a.offset - m.offset) < 1.5;
      st.anchor = { sec: m.sec, offset: same ? a.offset * 0.3 + m.offset * 0.7 : m.offset };
      st.mode = 'karaoke'; st.lastMatch = t1; st.miss = 0; st.hold = false;
    } else {
      st.miss++; // known lines keep running at their own pace; they stop only when the section ends (tick)
    }
    if (st.mode === 'captions') learn(st.song, caps);
  }

  // tr: Whisper verbose_json for audio recorded between t0 and t1.
  // Returns the best unconfirmed candidate, so the caller can re-check that chunk with a lyric hint (see verify).
  function feedChunk(chunk) {
    const { t0, t1 } = chunk;
    if (st.phase === 'idle') st.phase = 'listening';
    const { words, text, T, caps: allCaps } = parse(chunk);
    st.heard = text;
    for (const [k, v] of st.ev) { const nv = v * O.decay; if (nv < 0.05) st.ev.delete(k); else st.ev.set(k, nv); }
    if (!text) { tick(t1); return null; }

    const caps = allCaps.filter((c) => c.a >= st.lastCapEnd - 0.4);
    if (caps.length) { st.lastCapEnd = caps[caps.length - 1].b; st.captions.push(...caps); st.captions = st.captions.slice(-8); }

    const scores = scoreSongs(T, t0);
    for (const [s, sc] of scores) st.ev.set(s.id, (st.ev.get(s.id) || 0) + sc);
    const top = scores[0], second = scores[1];
    const evOf = (s) => st.ev.get(s.id) || 0;

    if (st.phase === 'locked') {
      const mine = scores.find(([s]) => s === st.song);
      const rival = scores.find(([s]) => s !== st.song);
      const need = st.manual ? O.switchChunk + 0.9 : O.switchChunk;
      if (rival && rival[1] >= need && (!mine || mine[1] < rival[1] * 0.4)) lock(rival[0], t1, false);
    } else if (top && top[1] >= O.lockChunk && evOf(top[0]) >= O.lockEv && (!second || evOf(top[0]) >= O.lockRatio * evOf(second[0]))) {
      st.pending.push(...caps);
      lock(top[0], t1, false);
    }

    if (st.phase === 'locked') {
      follow(T, words, t0, t1, caps);
      st.conf = Math.min(1, evOf(st.song) / 3);
      tick(t1);
      return null;
    }
    st.pending.push(...caps);
    st.pending = st.pending.filter((c) => c.a > t1 - 90);
    st.conf = top ? Math.min(1, evOf(top[0]) / 3) * 0.6 : 0;
    tick(t1);
    return top && top[1] >= O.hypMin ? { id: top[0].id, title: top[0].title, score: +top[1].toFixed(2) } : null;
  }

  // Second opinion on a candidate: the same audio transcribed again with that song's lyrics as a hint.
  // A real match jumps well above the unprompted score; a wrong candidate stays low.
  function verify(chunk, id) {
    const song = byId.get(id);
    if (!song || st.phase === 'locked') return null;
    const { words, text, T, caps } = parse(chunk);
    if (!text) return { ok: false, score: 0 };
    const scores = scoreSongs(T, chunk.t0);
    const mine = scores.find(([s]) => s === song), other = scores.find(([s]) => s !== song);
    const score = mine ? +mine[1].toFixed(2) : 0;
    if (!mine || mine[1] < O.verifyMin || (other && mine[1] < 1.8 * other[1])) return { ok: false, score };
    st.heard = text;
    st.ev.set(id, Math.max(st.ev.get(id) || 0, mine[1]));
    lock(song, chunk.t1, false);
    follow(T, words, chunk.t0, chunk.t1, caps);
    st.conf = Math.min(1, mine[1] / 3);
    return { ok: true, score };
  }

  // Up to 40 words of a song's known lyrics (the hint limit of the transcription model is small).
  function hint(song, text, now) {
    const secs = showSecs(song).filter((s) => s.lines.length);
    if (!secs.length) return '';
    let sec = null, start = 0;
    if (text) {
      const T = grams(norm(text));
      let best = 0;
      for (const s of secs) s.lines.forEach((l, i) => {
        const c = l.k >= 2 ? cont(l.g, l.w, T) * Math.min(1, l.k / 3) : 0;
        if (c > best) { best = c; sec = s; start = Math.max(0, i - 1); }
      });
    }
    if (!sec && st.song === song && st.anchor) {
      sec = st.anchor.sec;
      start = st.anchor.paused ? st.anchor.idx : Math.max(0, position(now).idx - 3);
    }
    if (!sec) { sec = mainSec(song) || secs[0]; start = 0; }
    const out = [];
    for (let i = start; i < sec.lines.length && out.length < 40; i++) out.push(...sec.lines[i].x.split(' ').slice(0, 40 - out.length));
    return out.join(' ');
  }

  // Tap controls: forward starts the waiting line now, or jumps to the next one; back returns to the previous line.
  function nudge(dir, now) {
    if (st.phase !== 'locked') return false;
    const a = st.anchor || sheet(st.song); // after the known lines ran out, a tap brings them back
    if (!a) return false;
    const L = a.sec.lines;
    let idx;
    if (a.paused) idx = a.end ? 0 : a.idx + (dir < 0 ? -1 : 0);
    else {
      const p = position(now);
      idx = (p.waiting ? -1 : p.idx) + (dir < 0 ? -1 : 1);
      // Web lyrics have estimated timing. A forward tap shows how long the line really took,
      // so the rest of the song moves halfway toward that pace.
      if (dir > 0 && a.sec.full && !p.waiting && p.idx + 1 < L.length) {
        const f = Math.sqrt(Math.min(2, Math.max(0.5, (now - a.offset - L[p.idx].a) / (L[p.idx + 1].a - L[p.idx].a))));
        const base = L[p.idx + 1].a;
        for (let i = p.idx + 1; i < L.length; i++) { L[i].a = base + (L[i].a - base) * f; L[i].b = base + (L[i].b - base) * f; }
      }
    }
    if (idx >= L.length) {
      st.hold = false;
      if (a.sec.full) st.anchor = { sec: a.sec, idx: L.length - 1, paused: true, end: true };
      else { st.anchor = null; st.mode = 'captions'; }
      return true;
    }
    idx = Math.max(0, idx);
    st.anchor = { sec: a.sec, offset: now - L[idx].a };
    st.mode = 'karaoke'; st.hold = true; st.lastMatch = now;
    return true;
  }

  function tick(now) {
    if (st.phase === 'locked' && !st.manual && now - st.lastMatch > O.lostAfter) unlock(now, 'lost');
    if (st.phase === 'locked' && st.mode === 'karaoke') {
      const p = position(now);
      if (!p || p.ended) {
        const f = fullSec(st.song);
        st.hold = false;
        if (f) st.anchor = { sec: f, idx: f.lines.length - 1, paused: true, end: true }; // real lyrics stay on screen
        else { st.mode = 'captions'; st.anchor = null; }
      }
    }
  }

  // Current karaoke position on the anchored section.
  function position(now) {
    const a = st.anchor;
    if (!a) return null;
    const L = a.sec.lines;
    if (a.paused) return { lines: L, idx: a.idx, frac: 0, ended: false, waiting: true, paused: true, end: !!a.end };
    const t = now - a.offset;
    let idx = -1;
    for (let i = 0; i < L.length; i++) if (L[i].a <= t + 0.2) idx = i; else break;
    const ended = t > L[L.length - 1].b + 2.5;
    if (idx < 0) return { lines: L, idx: 0, frac: 0, ended, waiting: true, paused: false };
    const l = L[idx];
    return { lines: L, idx, frac: Math.max(0, Math.min(1, (t - l.a) / Math.max(0.6, l.b - l.a))), ended, waiting: false, paused: false };
  }

  return {
    feedChunk, verify, tick, position, nudge,
    select(id, now) { const s = byId.get(id); if (s) lock(s, now, true); },
    release(now) { unlock(now, 'user'); st.ev.clear(); },
    start() { if (st.phase === 'idle') st.phase = 'listening'; },
    hintFor(id, text) { const s = byId.get(id); return s ? hint(s, text, 0) : ''; },
    liveHint(now) { return st.phase === 'locked' ? hint(st.song, null, now) : ''; },
    get state() {
      return { phase: st.phase, song: pub(st.song), manual: st.manual, mode: st.mode, captions: st.captions, heard: st.heard, conf: st.conf,
        paused: !!(st.anchor && st.anchor.paused), hold: st.hold, hasLines: !!(st.song && mainSec(st.song)),
        known: st.song ? secsOf(st.song).reduce((n, s) => n + s.lines.length, 0) : 0 };
    },
    songs: songs.map((s) => { const m = mainSec(s); return { ...pub(s), lines: m ? m.lines.length : 0 }; }),
    debugScores(text) { return scoreSongs(grams(norm(text)), 0).slice(0, 5).map(([s, sc]) => [s.title, +sc.toFixed(2)]); },
  };
}
