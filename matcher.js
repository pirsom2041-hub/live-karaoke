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
    lockChunk: 1.1,    // chunk score (in "typical lines") needed to lock
    lockEv: 1.5,       // accumulated evidence needed to lock
    lockRatio: 1.8,    // lead over the runner-up
    switchChunk: 1.6,  // chunk score for another song that steals the lock
    decay: 0.6,
    lostAfter: 60,     // seconds without any match before the lock is released
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
  const mkLine = (l) => {
    const n = norm(l.x);
    const g = [...grams(n)];
    return { a: l.a, b: l.b, x: l.x, n, g, w: weigh(g), k: n ? n.split(' ').length : 0 };
  };
  const songs = catalog.songs.map((s) => {
    const tn = norm(s.title);
    const tg = [...grams(tn)];
    return {
      id: s.id, title: s.title, album: s.album, year: s.year, dur: s.dur,
      tg, tw: weigh(tg), tk: tn.split(' ').length,
      sections: s.sections.map((sec) => ({ src: sec.src, live: !!sec.live, lines: sec.lines.map(mkLine).filter((l) => l.k > 0) })),
      learned: null,
    };
  });
  const byId = new Map(songs.map((s) => [s.id, s]));
  const allW = songs.flatMap((s) => s.sections.flatMap((sec) => sec.lines.map((l) => l.w))).sort((a, b) => a - b);
  const unit = allW.length ? allW[Math.floor(allW.length / 2)] : 60;

  const cont = (g, w, T) => { let c = 0; for (const x of g) if (T.has(x)) c += idf(x); return w ? c / w : 0; };
  const secsOf = (s) => (s.learned ? [...s.sections, s.learned] : s.sections);

  // ---- state ----
  const st = {
    phase: 'idle',       // idle | listening | locked
    song: null, manual: false, mode: 'captions', // karaoke | captions
    anchor: null,        // { sec, offset }
    lastMatch: 0, lockedAt: 0, miss: 0,
    ev: new Map(), captions: [], pending: [], heard: '', conf: 0, lastCapEnd: 0,
  };

  function scoreSongs(T, t0) {
    const out = [];
    for (const s of songs) {
      let sc = 0;
      const seen = new Set();
      for (const sec of secsOf(s)) for (const l of sec.lines) {
        if (seen.has(l.n)) continue;
        if (sec.learned && l.b > t0 - 2) continue; // never match a chunk against what it just taught us
        seen.add(l.n);
        const c = cont(l.g, l.w, T);
        if (c >= O.lineMin) sc += l.w * c * c;
      }
      if (s.tw && cont(s.tg, s.tw, T) >= 0.85) sc += s.tw * (s.tk >= 2 ? 1.5 : 0.8);
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
    for (const sec of secsOf(song)) sec.lines.forEach((l, i) => {
      if (sec.learned && l.b > t0 - 2) return;
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
      if (st.anchor && st.anchor.sec === sec && Math.abs(center.offset - st.anchor.offset) <= 3) sup *= 1.3;
      if (!best || sup > best.sup) best = { sup, group };
    }
    const tw = best.group.reduce((n, c) => n + c.w, 0);
    const offset = best.group.reduce((n, c) => n + c.offset * c.w, 0) / tw;
    return { sec, offset, support: tw / unit };
  }

  function learn(song, caps) {
    if (!caps.length) return;
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
    st.phase = 'locked'; st.song = song; st.manual = !!manual; st.mode = 'captions'; st.anchor = null;
    st.lastMatch = now; st.lockedAt = now; st.miss = 0;
    learn(song, st.pending.filter((c) => c.a > now - 75));
    st.pending = [];
    if (prev !== song) O.onEvent({ type: 'lock', song: pub(song), manual: !!manual, at: now });
  }

  function unlock(now, why) {
    if (st.phase !== 'locked') return;
    O.onEvent({ type: 'unlock', song: pub(st.song), why, at: now });
    st.phase = 'listening'; st.song = null; st.manual = false; st.anchor = null; st.mode = 'captions'; st.pending = [];
  }

  const pub = (s) => s && { id: s.id, title: s.title, album: s.album, year: s.year };

  // tr: Whisper verbose_json for audio recorded between t0 and t1.
  function feedChunk({ t0, t1, tr }) {
    if (st.phase === 'idle') st.phase = 'listening';
    const segs = (tr.segments || []).filter((s) => {
      const x = (s.text || '').trim();
      if (!x) return false;
      if ((s.no_speech_prob > 0.6 && s.avg_logprob < -0.8) || s.compression_ratio > 2.4) return false;
      return !HALLU.some((re) => re.test(x));
    });
    const inSeg = (w) => segs.some((s) => w.start >= s.start - 0.1 && w.end <= s.end + 0.1);
    const words = (tr.words || []).filter(inSeg).map((w) => ({ n: norm(w.word), s: t0 + w.start, e: t0 + w.end })).filter((w) => w.n);
    const text = segs.map((s) => s.text.trim()).join(' ');
    st.heard = text;
    for (const [k, v] of st.ev) { const nv = v * O.decay; if (nv < 0.05) st.ev.delete(k); else st.ev.set(k, nv); }
    if (!text) { tick(t1); return; }

    const T = grams(norm(text));
    const caps = segs.map((s) => ({ a: t0 + s.start, b: t0 + s.end, x: s.text.trim().replace(/[.,!?"]/g, '') }))
      .filter((c) => c.a >= st.lastCapEnd - 0.4);
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
      const m = matchLines(st.song, T, words, t0);
      if (m && m.support >= 0.7) {
        const same = st.anchor && st.anchor.sec === m.sec && Math.abs(st.anchor.offset - m.offset) < 1.5;
        st.anchor = { sec: m.sec, offset: same ? st.anchor.offset * 0.3 + m.offset * 0.7 : m.offset };
        st.mode = 'karaoke'; st.lastMatch = t1; st.miss = 0;
      } else {
        st.miss++;
        const p = st.anchor && position(t1);
        if (!p || p.ended || st.miss >= 2) { st.mode = 'captions'; st.anchor = null; }
      }
      if (st.mode === 'captions') learn(st.song, caps);
      st.conf = Math.min(1, evOf(st.song) / 3);
    } else {
      st.pending.push(...caps);
      st.pending = st.pending.filter((c) => c.a > t1 - 90);
      st.conf = top ? Math.min(1, evOf(top[0]) / 3) * 0.6 : 0;
    }
    tick(t1);
  }

  function tick(now) {
    if (st.phase === 'locked' && !st.manual && now - st.lastMatch > O.lostAfter) unlock(now, 'lost');
    if (st.phase === 'locked' && st.mode === 'karaoke') {
      const p = position(now);
      if (!p || p.ended) { st.mode = 'captions'; st.anchor = null; }
    }
  }

  // Current karaoke position on the anchored section.
  function position(now) {
    if (!st.anchor) return null;
    const { sec, offset } = st.anchor;
    const t = now - offset;
    const L = sec.lines;
    let idx = -1;
    for (let i = 0; i < L.length; i++) if (L[i].a <= t + 0.2) idx = i; else break;
    const last = L[L.length - 1];
    const ended = t > last.b + 2.5;
    if (idx < 0) return { lines: L, idx: 0, frac: 0, ended, waiting: true };
    const l = L[idx];
    return { lines: L, idx, frac: Math.max(0, Math.min(1, (t - l.a) / Math.max(0.6, l.b - l.a))), ended, waiting: false };
  }

  return {
    feedChunk, tick, position,
    select(id, now) { const s = byId.get(id); if (s) lock(s, now, true); },
    release(now) { unlock(now, 'user'); st.ev.clear(); },
    start() { if (st.phase === 'idle') st.phase = 'listening'; },
    get state() {
      return { phase: st.phase, song: pub(st.song), manual: st.manual, mode: st.mode, captions: st.captions, heard: st.heard, conf: st.conf,
        known: st.song ? secsOf(st.song).reduce((n, s) => n + s.lines.length, 0) : 0 };
    },
    songs: songs.map(pub),
    debugScores(text) { return scoreSongs(grams(norm(text)), 0).slice(0, 5).map(([s, sc]) => [s.title, +sc.toFixed(2)]); },
  };
}
