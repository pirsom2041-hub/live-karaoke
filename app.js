import { createMatcher } from './matcher.js?v=mwcd3tjw';
import { createAudio } from './audio.js?v=mwcd3tjw';
import { createVisuals, hueOf } from './visuals.js?v=mwcd3tjw';
import { loadBundle, setlist } from './store.js?v=mwcd3tjw';
import { keepChunk, keepEvent, count as keptCount, clearAll as clearKept, kept } from './keep.js?v=mwcd3tjw';

// Stamped by tools/stamp.mjs into this file, the module URLs above and the page.
const VERSION = 'mwcd3tjw';

const $ = (id) => document.getElementById(id);
const now = () => performance.now() / 1000;
const params = new URLSearchParams(location.search);
const demo = params.has('demo');
// Diagnostics (opt-in through the link): uploads each recorded chunk and its transcript so the capture can be inspected.
const diagTopic = /^[a-z0-9-]{12,64}$/.test(params.get('diag') || '') ? params.get('diag') : null;
let diagN = 0;
const bootAt = Date.now();

let bundle = null, matcher = null, audio = null, visuals = null, wake = null;
let live = false, lastKey = '', lastSung = -1, lastSongId = null, verifying = false, lastVerify = -99;
const verifyFailed = new Map();
const net = { state: 'idle', extra: '' };

addEventListener('error', (e) => { $('err').textContent = `${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno}`; });
addEventListener('unhandledrejection', (e) => { $('err').textContent = String(e.reason && e.reason.message || e.reason); });

boot();

// The page must be the one this script was written for. Browsers may keep an older copy of the page for a while;
// with it, elements this script draws into are missing. One reload with a fresh URL fetches the current page.
function pageIsStale() {
  const meta = document.querySelector('meta[name="app-version"]');
  return !meta || meta.content !== VERSION;
}

function reloadIfStale() {
  if (!pageIsStale()) return false;
  let tried = null;
  try { tried = sessionStorage.getItem('lk.reload'); } catch { /* storage unavailable */ }
  if (tried === VERSION) return false; // already tried for this version: carry on with what there is
  try { sessionStorage.setItem('lk.reload', VERSION); } catch { return false; }
  const u = new URL(location.href);
  u.searchParams.set('r', Date.now().toString(36));
  location.replace(u.toString());
  return true;
}

// Backstop for an old page: create the elements newer versions added.
function ensureDom() {
  const mk = (tag, id, cls, text) => { const e = document.createElement(tag); e.id = id; if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  if (!$('pace')) {
    const wrap = mk('div', 'pace'), badge = $('badge');
    badge.before(wrap);
    const slower = mk('button', 'slower', 'pc', 'לאט יותר'), faster = mk('button', 'faster', 'pc', 'מהר יותר');
    slower.hidden = faster.hidden = true;
    wrap.append(slower, badge, faster);
  }
  if (!$('hint')) $('pace').after(mk('div', 'hint'));
  if (!$('next3')) $('next2').after(mk('p', 'next3', 'ln'));
  if (!$('stanzas')) $('stage').after(mk('div', 'stanzas'));
  if (!$('deck')) $('stage').before(mk('div', 'deck'));
  if (!$('keptRow')) {
    const row = mk('div', 'keptRow', 'row');
    const info = mk('span', 'keptN');
    info.style.cssText = 'flex:2;font-size:12px;color:var(--dim)';
    row.append(info, mk('button', 'keptClear', 'tb', 'מחיקת הקלטות'));
    $('logList').after(row);
  }
}

async function boot() {
  const hosted = !['localhost', '127.0.0.1'].includes(location.hostname);
  if (hosted && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // A new service worker took over while an old page is on screen: load the page it would serve.
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!live && pageIsStale()) location.reload(); });
  }
  if (hosted && reloadIfStale()) return;
  ensureDom();
  visuals = createVisuals($('fx'));
  requestAnimationFrame(frame);
  try {
    bundle = await loadBundle();
  } catch (e) {
    $('count').textContent = '';
    $('startMsg').className = 'bad';
    $('startMsg').textContent = e.message === 'nokey'
      ? 'צריך לפתוח את האפליקציה פעם אחת דרך הקישור האישי (קוד ה-QR).'
      : 'לא הצלחתי לטעון את השירים. בדוק חיבור לרשת ונסה שוב.';
    return;
  }
  let savedPace = 1;
  try { const v = parseFloat(localStorage.getItem('lk.pace')); if (v > 0.4 && v < 2.5) savedPace = v; } catch { /* storage unavailable */ }
  matcher = createMatcher(bundle.catalog, { onEvent, pace: savedPace });
  audio = createAudio({
    getKey: () => bundle.groqKey,
    model: () => bundle.catalog.liveModel || 'whisper-large-v3',
    onChunk,
    onStatus: (s, extra) => { net.state = s; net.extra = extra || ''; },
    hint: () => matcher.liveHint(now()),
  });
  const full = matcher.songs.filter((s) => s.lines >= 12).length;
  $('count').textContent = `${matcher.songs.length} שירים טעונים, ${full} מהם עם מילים מלאות`;
  $('go').disabled = false;
  buildSongList('');
  buildDeck();
  renderLog();
  wire();
  if (demo) startDemo();
  // End-to-end test hook, local server only: start without a tap and report state.
  if (params.has('auto') && location.hostname === 'localhost') {
    await start();
    setInterval(() => {
      const s = matcher.state;
      fetch('/api/report', { method: 'POST', body: JSON.stringify({ kept: kept(), t: Math.round(now()), phase: s.phase, song: s.song && s.song.id, mode: s.mode, paused: s.paused, conf: +s.conf.toFixed(2), heardChars: s.heard.length, known: s.known, net: audio.net }) }).catch(() => {});
    }, 3000);
  }
}

function wire() {
  $('go').onclick = start;
  $('bSongs').onclick = () => { $('sheetSongs').classList.add('on'); };
  $('bLog').onclick = () => { renderLog(); $('sheetLog').classList.add('on'); };
  document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => b.closest('.sheet').classList.remove('on'); });
  $('q').oninput = (e) => buildSongList(e.target.value);
  $('songList').onclick = (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    matcher.select(li.dataset.id, now());
    keepEvent({ type: 'pick', song: li.dataset.id });
    $('sheetSongs').classList.remove('on');
  };
  // Deck: the songs as big buttons whenever no song is open. One tap opens a song.
  $('deck').onclick = (e) => {
    const c = e.target.closest('button[data-id]');
    if (!c) return;
    matcher.select(c.dataset.id, now());
    keepEvent({ type: 'pick', song: c.dataset.id });
  };
  $('keptClear').onclick = async () => {
    if (confirm('למחוק את ההקלטות שנשמרו בפלאפון?')) { await clearKept(); renderLog(); }
  };
  $('other').onclick = () => { matcher.release(now()); keepEvent({ type: 'release' }); };
  // Stanza bar: one tap jumps to a stanza (the chorus coming back, for example) and starts it now.
  $('stanzas').onclick = (e) => {
    const b = e.target.closest('button[data-k]');
    if (b && matcher.jump(+b.dataset.k, now())) { lastKey = ''; keepEvent({ type: 'jump', k: +b.dataset.k }); if (navigator.vibrate) navigator.vibrate(15); }
  };
  // Tap the lyrics: start the waiting line now, or jump to the next one. Tap the line above: go back one.
  $('stage').onclick = (e) => {
    const dir = e.target.closest('#prev') ? -1 : 1;
    if (matcher.nudge(dir, now())) { lastKey = ''; keepEvent({ type: 'tap', dir }); if (navigator.vibrate) navigator.vibrate(15); }
  };
  // Pace buttons: the estimated timing of the lyrics, for every song, remembered on this phone.
  const pace = (f) => {
    const v = matcher.setPace(matcher.state.pace * f, now());
    try { localStorage.setItem('lk.pace', String(v)); } catch { /* storage unavailable */ }
    if (navigator.vibrate) navigator.vibrate(15);
  };
  $('slower').onclick = (e) => { e.stopPropagation(); pace(1.15); };
  $('faster').onclick = (e) => { e.stopPropagation(); pace(1 / 1.15); };
  $('bTorch').onclick = () => { visuals.setTorch(true); $('torch').classList.add('on'); $('live').style.visibility = 'hidden'; };
  $('torch').onclick = () => { visuals.setTorch(false); $('torch').classList.remove('on'); $('live').style.visibility = ''; };
  $('share').onclick = shareLog;
  $('clear').onclick = () => { if (confirm('למחוק את יומן ההופעה?')) { setlist.clear(); renderLog(); } };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && live) keepAwake(); });
}

async function start() {
  $('go').disabled = true;
  $('startMsg').className = ''; $('startMsg').textContent = 'מבקש גישה למיקרופון...';
  try {
    await audio.start();
  } catch (e) {
    $('go').disabled = false;
    $('startMsg').className = 'bad';
    $('startMsg').textContent = 'אין גישה למיקרופון. צריך לאשר אותה בהגדרות האתר ולנסות שוב.';
    return;
  }
  goLive();
  keepAwake();
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { /* optional */ }
}

function goLive() {
  live = true;
  matcher.start();
  $('start').classList.remove('on');
  $('live').classList.add('on');
}

async function keepAwake() {
  try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch { /* optional */ }
}

async function onChunk(c) {
  const hyp = matcher.feedChunk(c);
  if (c.blob) {
    // Kept on this phone only, for testing the next version against a real show.
    const st = matcher.state, tr = c.tr;
    keepChunk({
      at: Date.now(), t0: c.t0, t1: c.t1, blob: c.blob, model: c.meta && c.meta.model, level: c.meta && c.meta.level,
      text: (tr.text || '').slice(0, 500),
      words: (tr.words || []).slice(0, 80).map((w) => [w.word, +Number(w.start).toFixed(2), +Number(w.end).toFixed(2)]),
      segs: (tr.segments || []).slice(0, 12).map((g) => [+Number(g.start).toFixed(2), +Number(g.end).toFixed(2), +Number(g.avg_logprob).toFixed(2), +Number(g.no_speech_prob).toFixed(2)]),
      phase: st.phase, song: st.song && st.song.id, mode: st.mode, paused: st.paused, hyp,
    });
  }
  if (diagTopic && c.blob) sendDiag(c, hyp);
  // A weak candidate gets a second transcription of the same audio, hinted with that song's lyrics.
  if (!hyp || !c.blob || verifying || matcher.state.phase === 'locked') return;
  // Each second pass spends transcription quota: at most one every 20 seconds, and a song that just failed waits 45.
  const t = now();
  if (t - lastVerify < 20 || t - (verifyFailed.get(hyp.id) || -99) < 45) return;
  verifying = true; lastVerify = t;
  try {
    const hintText = matcher.hintFor(hyp.id, c.tr.text || '');
    const tr = hintText ? await audio.transcribe(c.blob, hintText) : null;
    if (!tr) return;
    const v = matcher.verify({ t0: c.t0, t1: c.t1, tr }, hyp.id);
    if (!(v && v.ok)) verifyFailed.set(hyp.id, t);
    if (diagTopic) diagNote({ verify: hyp.title, before: hyp.score, after: v && v.score, ok: !!(v && v.ok), text: (tr.text || '').slice(0, 200) });
  } finally { verifying = false; }
}

function sendDiag(c, hyp) {
  const s = matcher.state, tr = c.tr;
  const info = {
    n: ++diagN, dur: +(c.t1 - c.t0).toFixed(1), m: c.meta, hyp,
    text: (tr.text || '').slice(0, 260),
    q: (tr.segments || []).slice(0, 4).map((g) => [g.avg_logprob, g.no_speech_prob].map((x) => +Number(x).toFixed(2))),
    top: matcher.debugScores(tr.text || '').slice(0, 3), phase: s.phase, song: s.song && s.song.title, mode: s.mode, paused: s.paused,
  };
  if (diagN === 1) { info.ua = navigator.userAgent; info.v = VERSION; }
  if ($('err').textContent) info.err = $('err').textContent.slice(0, 140);
  fetch(`https://ntfy.sh/${diagTopic}?filename=c${diagN}.webm&message=${encodeURIComponent(JSON.stringify(info))}`, { method: 'PUT', body: c.blob }).catch(() => {});
  $('heard').style.color = '#ffd27a';
}

function diagNote(obj) {
  fetch(`https://ntfy.sh/${diagTopic}`, { method: 'POST', body: JSON.stringify(obj) }).catch(() => {});
}

function onEvent(ev) {
  keepEvent({ type: ev.type, song: ev.song && ev.song.id, manual: ev.manual, why: ev.why, pace: ev.pace });
  if (ev.type === 'lock' || ev.type === 'unlock') buildDeck();
  if (ev.type === 'pace') { try { localStorage.setItem('lk.pace', String(ev.pace)); } catch { /* storage unavailable */ } }
  if (ev.type === 'lock') {
    setlist.add(ev.song, ev.manual);
    const h = hueOf(ev.song.title);
    visuals.setHue(h);
    document.documentElement.style.setProperty('--h', h);
    const t = $('songTitle');
    t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop');
    if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
  }
}

// ---------- rendering ----------
const idle = (t) => ({ bass: 0.2 + 0.08 * Math.sin(t * 1.3), mid: 0.2, high: 0.1, level: 0.22 + 0.06 * Math.sin(t * 0.7), beat: false, pulse: 0, bins: null });

function frame() {
  requestAnimationFrame(frame);
  const t = now();
  const lv = audio && audio.running ? audio.levels() : idle(t);
  visuals.draw(t, lv);
  if (live && matcher) {
    matcher.tick(t);
    const s = matcher.state;
    audio.setMode(s.phase !== 'locked' ? 'search' : s.paused ? 'waiting' : 'locked');
    render(t);
  }
}

const CHIP = { listening: 'מקשיבה', offline: 'אין רשת', slow: 'רשת איטית', limited: 'הפסקה קצרה', error: 'תקלה', idle: 'מקשיבה' };

function render(t) {
  const s = matcher.state;
  const locked = s.phase === 'locked';

  const chipText = net.state === 'error' && net.extra === 'key' ? 'בעיה במפתח' : locked && net.state === 'listening' ? (s.manual ? 'נבחר' : 'זוהה') : CHIP[net.state] || 'מקשיבה';
  setText('chipT', chipText);
  $('chip').classList.toggle('warn', net.state !== 'listening' && net.state !== 'idle');

  const songId = locked ? s.song.id : null;
  if (songId !== lastSongId) {
    lastSongId = songId;
    const el = $('songTitle');
    el.classList.toggle('idle', !locked);
    el.textContent = locked ? s.song.title : 'בחר שיר, או חכה לזיהוי';
    $('songMeta').textContent = locked ? (s.song.album || '') : '';
    $('torchT').textContent = locked ? s.song.title : 'ליאת בנאי';
    $('other').classList.toggle('on', locked);
    buildStanzas(locked ? s.stanzas : []);
  }
  $('conf').firstElementChild.style.width = `${Math.round(s.conf * 100)}%`;
  setText('heard', s.heard ? `שמעתי: ${s.heard}` : '');

  $('deck').classList.toggle('on', !locked);
  $('stage').classList.toggle('off', !locked);
  const p = locked && s.mode === 'karaoke' ? matcher.position(t) : null;
  // Crowd mode: the line being sung, in giant letters.
  if (visuals.torch) setText('torchT', p ? p.lines[p.idx].x : locked ? s.song.title : 'ליאת בנאי');
  $('slower').hidden = $('faster').hidden = !(p && s.full);
  if (p) {
    const L = p.lines, i = p.idx;
    const key = `k|${songId}|${i}|${L.length}|${p.paused ? 'p' : 'r'}|${p.end ? 'e' : ''}|${p.wait ? 'w' : ''}`;
    if (key !== lastKey) {
      lastKey = key; lastSung = -1;
      setBadge(p.paused ? 'מילים' : 'קריוקי', true);
      setText('hint', p.end ? 'סוף המילים. הקשה מחזירה להתחלה, או בחירת בית למטה' : p.wait ? 'מחכה להמשך. הקשה כשהיא מתחילה את השורה, או בחירת בית למטה' : p.paused ? 'הקשה על המסך ברגע שהיא מתחילה את השורה הזאת' : 'הקשה: לשורה הבאה · הקשה על השורה שמעל: חזרה');
      $('prev').textContent = i > 0 ? L[i - 1].x : '';
      setCurrent(L[i].x, false);
      $('next1').textContent = L[i + 1] ? L[i + 1].x : '';
      $('next2').textContent = L[i + 2] ? L[i + 2].x : '';
      $('next3').textContent = L[i + 3] ? L[i + 3].x : '';
      markStanza(s.stanzas, i);
    }
    const spans = $('cur').children;
    const sung = p.waiting ? 0 : Math.min(spans.length, Math.ceil(p.frac * spans.length + 0.001));
    if (sung !== lastSung) {
      lastSung = sung;
      for (let k = 0; k < spans.length; k++) spans[k].classList.toggle('sung', k < sung);
    }
  } else {
    const c = s.captions, n = c.length;
    const key = `c|${n ? c[n - 1].a : 0}|${n}|${songId}|${s.hasLines}`;
    if (key !== lastKey) {
      lastKey = key; lastSung = -1;
      setBadge('חי', false);
      setText('hint', !locked ? '' : s.hasLines ? 'המילים שיש לי לשיר הזה נגמרו. הקשה מחזירה אותן להתחלה' : 'אין לי מילים לשיר הזה, מוצג מה שנשמע');
      $('prev').textContent = n > 1 ? c[n - 2].x : '';
      setCurrent(n ? c[n - 1].x : '', true);
      $('next1').textContent = '';
      $('next3').textContent = '';
      $('next2').textContent = n ? '' : 'המילים יופיעו כאן ברגע שהיא תתחיל לשיר';
    }
  }
}

function setText(id, text) { const el = $(id); if (el.textContent !== text) el.textContent = text; }

function setBadge(text, strong) {
  const b = $('badge');
  b.textContent = text;
  b.classList.toggle('k', strong);
}

function setCurrent(text, caption) {
  const cur = $('cur');
  cur.classList.toggle('cap', caption);
  cur.textContent = '';
  const words = text.split(/\s+/).filter(Boolean);
  words.forEach((w, i) => {
    const sp = document.createElement('span');
    sp.textContent = w;
    cur.append(sp);
    if (i < words.length - 1) cur.append(' ');
  });
  cur.classList.remove('swap'); void cur.offsetWidth; cur.classList.add('swap');
}

// The deck: songs with full lyrics first, in the catalog's popularity order. Songs already sung tonight go last.
function buildDeck() {
  const el = $('deck');
  el.textContent = '';
  const sung = new Set(setlist.all().filter((e) => e.at >= bootAt).map((e) => e.id));
  const rank = (s) => (sung.has(s.id) ? 2 : s.lines >= 12 ? 0 : 1);
  const items = matcher.songs.filter((s) => s.lines > 0).map((s, i) => [s, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]);
  for (const [s] of items) {
    const b = document.createElement('button');
    b.className = sung.has(s.id) ? 'card done' : 'card';
    b.dataset.id = s.id;
    const t = document.createElement('b'); t.textContent = s.title;
    const sm = document.createElement('small'); sm.textContent = sung.has(s.id) ? 'הושר' : s.lines >= 12 ? 'מילים מלאות' : 'קטע מהשיר';
    b.append(t, sm);
    el.append(b);
  }
}

function buildStanzas(list) {
  const el = $('stanzas');
  el.textContent = '';
  if (!list || list.length < 2) return;
  list.forEach((z, k) => {
    const b = document.createElement('button');
    b.className = 'sz'; b.dataset.k = k; b.textContent = z.label;
    el.append(b);
  });
}

function markStanza(list, idx) {
  let cur = -1;
  (list || []).forEach((z, k) => { if (z.i <= idx) cur = k; });
  const kids = $('stanzas').children;
  for (let k = 0; k < kids.length; k++) {
    const on = k === cur;
    if (kids[k].classList.contains('on') !== on) {
      kids[k].classList.toggle('on', on);
      if (on) kids[k].scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }
}

// ---------- sheets ----------
function buildSongList(q) {
  const ul = $('songList');
  ul.textContent = '';
  const needle = q.trim();
  const items = matcher.songs.filter((s) => !needle || s.title.includes(needle)).sort((a, b) => (b.lines >= 12) - (a.lines >= 12));
  if (!items.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'לא נמצא שיר כזה'; ul.append(li); return; }
  for (const s of items) {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    const b = document.createElement('b'); b.textContent = s.title;
    const sm = document.createElement('small');
    sm.textContent = s.lines >= 12 ? 'מילים מלאות' : s.lines ? 'קטע מהשיר' : 'בלי מילים';
    if (s.lines >= 12) sm.className = 'full';
    li.append(b, sm);
    ul.append(li);
  }
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

function renderLog() {
  const ul = $('logList');
  ul.textContent = '';
  const list = setlist.all();
  if (!list.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'השירים שיזוהו בהופעה יירשמו כאן'; ul.append(li); }
  list.forEach((e) => {
    const li = document.createElement('li');
    const tm = document.createElement('time'); tm.textContent = hhmm(e.at);
    const b = document.createElement('b'); b.textContent = e.title;
    li.append(tm, b);
    ul.append(li);
  });
  if (audio) $('stats').textContent = `ok ${audio.net.ok} · fail ${audio.net.fail} · ${audio.net.lastMs} ms · ${net.state}`;
  keptCount().then((k) => { $('keptN').textContent = k ? `${k} קטעי הקלטה שמורים בפלאפון, לשיפור הגרסה הבאה. הם לא נשלחים לשום מקום.` : 'אין הקלטות שמורות בפלאפון.'; });
}

async function shareLog() {
  const list = setlist.all();
  if (!list.length) return;
  const text = `הסטליסט של ליאת בנאי · ${new Date(list[0].at).toLocaleDateString('he-IL')}\n` + list.map((e, i) => `${i + 1}. ${e.title} (${hhmm(e.at)})`).join('\n');
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); $('share').textContent = 'הועתק'; setTimeout(() => { $('share').textContent = 'שיתוף'; }, 1500); }
  } catch { /* cancelled */ }
}

// ---------- demo (no microphone): replays a catalog song through the matcher ----------
function startDemo() {
  const want = params.get('demo');
  const song = bundle.catalog.songs.find((s) => want && s.title.includes(want) && s.sections.length) || bundle.catalog.songs.find((s) => s.sections.some((x) => x.lines.length >= 6));
  if (!song) return;
  const sec = [...song.sections].sort((a, b) => b.lines.length - a.lines.length)[0];
  audio.startDemo();
  goLive();
  // ?pick: the manual route, exactly as tapping the song in the list. No audio is fed.
  if (params.has('idle')) return; // the deck, with nothing open
  if (params.has('pick')) { matcher.select(song.id, now()); if (params.has('crowd')) $('bTorch').click(); return; }
  // The song "started" nine seconds ago; wall time of a line = w0 + its time in the section.
  const w0 = now() - 9 - sec.lines[0].a;
  const feed = (end) => {
    const from = end - 10;
    const lines = sec.lines.filter((l) => w0 + l.a >= from && w0 + l.b <= end);
    const segments = lines.map((l) => ({ start: w0 + l.a - from, end: w0 + l.b - from, text: l.x, no_speech_prob: 0, avg_logprob: -0.2, compression_ratio: 1 }));
    const words = segments.flatMap((g) => {
      const ws = g.text.split(/\s+/), d = (g.end - g.start) / ws.length;
      return ws.map((w, k) => ({ word: w, start: g.start + k * d, end: g.start + (k + 1) * d }));
    });
    onChunk({ t0: from, t1: end, tr: { segments, words } });
  };
  feed(now() - 4); feed(now());
  setInterval(() => feed(now()), 3000);
}
