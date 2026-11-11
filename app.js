import { createMatcher } from './matcher.js';
import { createAudio } from './audio.js';
import { createVisuals, hueOf } from './visuals.js';
import { loadBundle, setlist } from './store.js';

const $ = (id) => document.getElementById(id);
const now = () => performance.now() / 1000;
const params = new URLSearchParams(location.search);
const demo = params.has('demo');

let bundle = null, matcher = null, audio = null, visuals = null, wake = null;
let live = false, lastKey = '', lastSung = -1, lastSongId = null;
const net = { state: 'idle', extra: '' };

addEventListener('error', (e) => { $('err').textContent = `${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno}`; });
addEventListener('unhandledrejection', (e) => { $('err').textContent = String(e.reason && e.reason.message || e.reason); });

boot();

async function boot() {
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
  matcher = createMatcher(bundle.catalog, { onEvent });
  audio = createAudio({
    getKey: () => bundle.groqKey,
    model: () => bundle.catalog.liveModel || 'whisper-large-v3',
    onChunk,
    onStatus: (s, extra) => { net.state = s; net.extra = extra || ''; },
  });
  $('count').textContent = `${matcher.songs.length} שירים טעונים`;
  $('go').disabled = false;
  buildSongList('');
  renderLog();
  wire();
  if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (demo) startDemo();
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
    $('sheetSongs').classList.remove('on');
  };
  $('other').onclick = () => matcher.release(now());
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

function onChunk(c) {
  matcher.feedChunk(c);
  audio.setMode(matcher.state.phase === 'locked');
}

function onEvent(ev) {
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
  if (live && matcher) { matcher.tick(t); render(t); }
}

const CHIP = { listening: 'מקשיבה', offline: 'אין רשת', slow: 'רשת איטית', limited: 'הפסקה קצרה', error: 'תקלה', idle: 'מקשיבה' };

function render(t) {
  const s = matcher.state;
  const locked = s.phase === 'locked';

  const chipText = net.state === 'error' && net.extra === 'key' ? 'בעיה במפתח' : locked && net.state === 'listening' ? 'זוהה' : CHIP[net.state] || 'מקשיבה';
  setText('chipT', chipText);
  $('chip').classList.toggle('warn', net.state !== 'listening' && net.state !== 'idle');

  const songId = locked ? s.song.id : null;
  if (songId !== lastSongId) {
    lastSongId = songId;
    const el = $('songTitle');
    el.classList.toggle('idle', !locked);
    el.textContent = locked ? s.song.title : 'מקשיבה ומחפשת את השיר...';
    $('songMeta').textContent = locked ? [s.song.album, s.song.year || ''].filter(Boolean).join(' · ') : '';
    $('torchT').textContent = locked ? s.song.title : 'ליאת בנאי';
    $('other').classList.toggle('on', locked);
  }
  $('conf').firstElementChild.style.width = `${Math.round(s.conf * 100)}%`;
  setText('heard', s.heard ? `שמעתי: ${s.heard}` : '');

  const p = locked && s.mode === 'karaoke' ? matcher.position(t) : null;
  if (p) {
    const L = p.lines, i = p.idx;
    const key = `k|${songId}|${i}|${L.length}|${L[i].x}`;
    if (key !== lastKey) {
      lastKey = key; lastSung = -1;
      setBadge(true);
      $('prev').textContent = i > 0 ? L[i - 1].x : '';
      setCurrent(L[i].x, false);
      $('next1').textContent = L[i + 1] ? L[i + 1].x : '';
      $('next2').textContent = L[i + 2] ? L[i + 2].x : '';
    }
    const spans = $('cur').children;
    const sung = p.waiting ? 0 : Math.min(spans.length, Math.ceil(p.frac * spans.length + 0.001));
    if (sung !== lastSung) {
      lastSung = sung;
      for (let k = 0; k < spans.length; k++) spans[k].classList.toggle('sung', k < sung);
    }
  } else {
    const c = s.captions, n = c.length;
    const key = `c|${n ? c[n - 1].a : 0}|${n}`;
    if (key !== lastKey) {
      lastKey = key; lastSung = -1;
      setBadge(false);
      $('prev').textContent = n > 1 ? c[n - 2].x : '';
      setCurrent(n ? c[n - 1].x : '', true);
      $('next1').textContent = '';
      $('next2').textContent = n ? '' : 'המילים יופיעו כאן ברגע שהיא תתחיל לשיר';
    }
  }
}

function setText(id, text) { const el = $(id); if (el.textContent !== text) el.textContent = text; }

function setBadge(karaoke) {
  const b = $('badge');
  b.textContent = karaoke ? 'קריוקי' : 'חי';
  b.classList.toggle('k', karaoke);
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

// ---------- sheets ----------
function buildSongList(q) {
  const ul = $('songList');
  ul.textContent = '';
  const needle = q.trim();
  const items = matcher.songs.filter((s) => !needle || s.title.includes(needle));
  if (!items.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'לא נמצא שיר כזה'; ul.append(li); return; }
  for (const s of items) {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    const b = document.createElement('b'); b.textContent = s.title;
    const sm = document.createElement('small'); sm.textContent = s.album || '';
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
  const song = bundle.catalog.songs.find((s) => s.sections.some((x) => x.lines.length >= 5));
  if (!song) return;
  const sec = song.sections.find((x) => x.lines.length >= 5);
  audio.startDemo();
  goLive();
  const t0 = now();
  const secT = () => now() - t0 + sec.lines[0].a - 1;
  setInterval(() => {
    const end = secT(), from = end - 8, tNow = now();
    const lines = sec.lines.filter((l) => l.a >= from && l.b <= end);
    const segments = lines.map((l) => ({ start: l.a - from, end: l.b - from, text: l.x, no_speech_prob: 0, avg_logprob: -0.2, compression_ratio: 1 }));
    const words = lines.flatMap((l) => {
      const ws = l.x.split(/\s+/), d = (l.b - l.a) / ws.length;
      return ws.map((w, i) => ({ word: w, start: l.a - from + i * d, end: l.a - from + (i + 1) * d }));
    });
    onChunk({ t0: tNow - 8, t1: tNow, tr: { segments, words } });
  }, 2500);
}
