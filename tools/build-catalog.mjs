// Builds catalog.json: song list from Deezer + iTunes, official preview clips, Whisper transcripts with timings.
// Usage: node tools/build-catalog.mjs            (list + download + transcribe what the quota allows + build)
//        node tools/build-catalog.mjs --no-it    (skip iTunes previews when transcribing)
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const AUDIO = path.join(CACHE, 'audio');
const TR = path.join(CACHE, 'tr');
const MODEL = process.env.KARAOKE_MODEL || 'whisper-large-v3';
const DEEZER_ARTIST = 12408800;
const ARTIST_HE = 'ליאת בנאי';
const ARTIST_RE = /ליאת בנאי|liat banai/i;
const HE = /[א-ת]/;
// Same song under two names (verified by shared lyrics in the transcripts): shown with both, " · " separates them.
const ZILZALTA = 'אתה זלזלת · אין לך מילה', KMO_SHELANU = 'אהבה כמו שלנו · אהבה עיוורת';
const ALIAS = { 'אבא סליחה': 'אבא סליחה טעיתי', 'דואט הפרידה': 'הפרידה', 'תהיה רצינית': 'תהיה רציני', 'אל תבית': 'אל תביט', 'יסורי אהבה': 'ייסורי אהבה',
  'את זלזלת': ZILZALTA, 'אתה זלזלת': ZILZALTA, 'אין לך מילה': ZILZALTA, 'אהבה כמו שלנו': KMO_SHELANU, 'אהבה עיוורת': KMO_SHELANU };
// iTunes lists three albums with transliterated titles. Durations collide across albums, so the mapping is explicit.
const LATIN = {
  'ahava iveret': 'אהבה עיוורת', 'ulay tachzor': 'אולי תחזור', 'shakran': 'שקרן', 'ein kamoni': 'אין כמוני', 'bachur chatih': 'בחור חתיך',
  'rokedet al habar': 'רוקדת על הבר', 'nasi lishkoach': 'נסי לשכוח', 'kchi oto': 'קחי אותו',
  'layla afel': 'לילה אפל', 'hachafla shel hadance': 'החאפלה של הדאנס', 'chapes acheret': 'חפש אחרת', 'sug b': 'סוג ב', 'al tabit': 'אל תביט',
  'trufot shel savta': 'תרופות של סבתא', 'ten li': 'תן לי', 'yesh li shamaim': 'יש לי שמיים', 'leehov otach halayla': 'לאוהב אותך הלילה',
  'lo echpat li': 'לא אכפת לי', 'rak lichyot': 'רק לחיות', 'chashuv li': 'חשוב לי',
  'ba li alecha': 'בא לי עליך', 'al telech': 'אל תלך', 'kol mila kveda': 'כל מילה כבדה', 'rachok rachok': 'רחוק רחוק', 'kol hanedarim': 'כל הנדרים',
  'ma asita li': 'מה עשית לי', 'hakesem vehatzchok': 'הקסם והצחוק', 'malkat haleylot': 'מלכת הלילות',
};
const HALLU = [/תודה (רבה )?(על|ש)(ה)?צפי/, /כתוביות/, /תרגום:/, /תמלול:/, /amara/i, /subtitles/i, /^תודה\.?$/, /^תודה רבה\.?$/];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const readJson = async (p, d) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return d; } };

function cleanTitle(t) {
  let s = String(t).replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\bfeat\..*$/i, ' ').replace(/\s+-\s+single$/i, '')
    .replace(/["'׳״.,!?]/g, '').replace(/\s+/g, ' ').trim();
  return ALIAS[s] || s;
}

async function listDeezer() {
  const out = new Map();
  const add = (t, album, year) => {
    if (!t.preview || out.has(t.id)) return;
    out.set(t.id, { src: 'dz', id: t.id, rawTitle: t.title, album, year, dur: t.duration, rank: t.rank || 0, preview: t.preview });
  };
  const albums = (await getJson(`https://api.deezer.com/artist/${DEEZER_ARTIST}/albums?limit=100`)).data || [];
  for (const al of albums) {
    const tr = (await getJson(`https://api.deezer.com/album/${al.id}/tracks?limit=100`)).data || [];
    for (const t of tr) add(t, al.title, (al.release_date || '').slice(0, 4));
    await sleep(120);
  }
  for (let index = 0; index < 300; index += 100) {
    const r = await getJson(`https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${ARTIST_HE}"`)}&limit=100&index=${index}`);
    for (const t of r.data || []) if (ARTIST_RE.test(t.artist?.name || '')) add(t, t.album?.title || '', '');
    if (!r.next) break;
    await sleep(120);
  }
  return [...out.values()];
}

async function listItunes() {
  const r = await getJson(`https://itunes.apple.com/search?term=${encodeURIComponent(ARTIST_HE)}&country=il&entity=song&limit=200`);
  return (r.results || []).filter((t) => ARTIST_RE.test(t.artistName || '') && t.previewUrl).map((t, i) => ({
    src: 'it', id: t.trackId, rawTitle: t.trackName, album: t.collectionName || '', year: (t.releaseDate || '').slice(0, 4),
    dur: Math.round((t.trackTimeMillis || 0) / 1000), order: i, preview: t.previewUrl,
  }));
}

async function download(t) {
  const ext = t.src === 'dz' ? 'mp3' : 'm4a';
  const file = path.join(AUDIO, `${t.src}_${t.id}.${ext}`);
  if (!existsSync(file)) {
    const r = await fetch(t.preview);
    if (!r.ok) { console.warn('  download failed', t.rawTitle, r.status); return null; }
    await writeFile(file, Buffer.from(await r.arrayBuffer()));
    await sleep(80);
  }
  return file;
}

async function transcribe(file, key) {
  const out = path.join(TR, `${path.basename(file)}.${MODEL}.json`);
  if (existsSync(out)) return readJson(out, null);
  const buf = await readFile(file);
  for (let attempt = 0; attempt < 4; attempt++) {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/mp4' }), path.basename(file));
    fd.append('model', MODEL); fd.append('language', 'he'); fd.append('response_format', 'verbose_json'); fd.append('temperature', '0');
    fd.append('timestamp_granularities[]', 'word'); fd.append('timestamp_granularities[]', 'segment');
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd });
    if (r.ok) {
      const j = await r.json();
      j._limits = Object.fromEntries([...r.headers].filter(([k]) => k.startsWith('x-ratelimit')));
      await writeFile(out, JSON.stringify(j));
      return j;
    }
    if (r.status === 429) {
      const wait = Number(r.headers.get('retry-after') || 20);
      const msg = (await r.text()).slice(0, 200);
      if (wait > 120) { console.warn(`  rate limit, retry-after ${wait}s: ${msg}`); return 'LIMIT'; }
      console.log(`  rate limit, waiting ${wait}s`); await sleep((wait + 1) * 1000); continue;
    }
    console.warn('  transcribe failed', r.status, (await r.text()).slice(0, 200));
    await sleep(1500);
  }
  return null;
}

// Whisper output -> timed lines. Segments are phrase-sized; long ones are split at the widest word gap.
function toLines(tr) {
  const lines = [];
  const words = tr.words || [];
  for (const s of tr.segments || []) {
    const text = (s.text || '').trim();
    if (!text) continue;
    if ((s.no_speech_prob > 0.6 && s.avg_logprob < -1) || s.compression_ratio > 2.4) continue;
    if (HALLU.some((re) => re.test(text))) continue;
    const ws = words.filter((w) => w.start >= s.start - 0.05 && w.end <= s.end + 0.05);
    if (ws.length >= 9 || s.end - s.start > 7) {
      let cut = -1, best = 0;
      for (let i = Math.floor(ws.length * 0.3); i < Math.ceil(ws.length * 0.7) && i < ws.length - 1; i++) {
        const gap = ws[i + 1].start - ws[i].end;
        if (gap >= best) { best = gap; cut = i; }
      }
      if (cut > 0) {
        const A = ws.slice(0, cut + 1), B = ws.slice(cut + 1);
        lines.push({ a: A[0].start, b: A[A.length - 1].end, x: A.map((w) => w.word).join(' ').trim() });
        lines.push({ a: B[0].start, b: B[B.length - 1].end, x: B.map((w) => w.word).join(' ').trim() });
        continue;
      }
    }
    lines.push({ a: s.start, b: s.end, x: text });
  }
  const clean = lines.map((l) => ({ a: +l.a.toFixed(2), b: +l.b.toFixed(2), x: l.x.replace(/[.,!?"]/g, '').replace(/\s+/g, ' ').trim() })).filter((l) => l.x.length > 1);
  // One- and two-word fragments match anything; fold them into the neighbouring line.
  const wc = (l) => l.x.split(' ').length;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const l = clean[i], prev = out[out.length - 1], next = clean[i + 1];
    if (wc(l) <= 2) {
      if (prev && l.a - prev.b <= 1.5 && wc(prev) <= 7) { prev.x += ' ' + l.x; prev.b = l.b; continue; }
      if (next && next.a - l.b <= 1.5) { clean[i + 1] = { a: l.a, b: next.b, x: l.x + ' ' + next.x }; continue; }
    }
    out.push({ ...l });
  }
  return out;
}

async function main() {
  await mkdir(AUDIO, { recursive: true }); await mkdir(TR, { recursive: true });
  const secret = await readJson(path.join(ROOT, '.secret.json'), {});
  const skipIt = process.argv.includes('--no-it');

  console.log('Listing tracks...');
  const dz = await listDeezer();
  const it = await listItunes();
  console.log(`  Deezer: ${dz.length} tracks, iTunes: ${it.length} tracks`);

  for (const t of it) {
    t.title = cleanTitle(t.rawTitle);
    if (!HE.test(t.title)) {
      const he = LATIN[t.title.toLowerCase()];
      if (he) t.title = cleanTitle(he); else console.warn('  no Hebrew title for', t.rawTitle);
    }
  }
  for (const t of dz) t.title = cleanTitle(t.rawTitle);
  for (const t of [...dz, ...it]) {
    // Distributor metadata: the 313-second track sold as "אהבה אבודה" on the best-of album is "מחפשת את הדרך".
    if (t.title === 'אהבה אבודה' && t.dur >= 310) t.title = 'מחפשת את הדרך';
  }

  // Group into songs, then into distinct recordings (same source + same duration = same recording on another album).
  const songs = new Map();
  for (const t of [...dz, ...it]) {
    if (/מחרוזת|medley/i.test(t.rawTitle)) continue;
    const key = t.title.replace(/\s/g, '');
    if (!songs.has(key)) songs.set(key, { title: t.title, tracks: [] });
    songs.get(key).tracks.push(t);
  }
  const list = [...songs.values()].map((s) => {
    const recs = [];
    for (const t of s.tracks) {
      if (recs.some((r) => r.src === t.src && Math.abs(r.dur - t.dur) <= 1)) continue;
      recs.push(t);
    }
    const order = Math.min(...s.tracks.map((t) => (t.src === 'it' ? t.order : 999)));
    const rank = Math.max(...s.tracks.map((t) => t.rank || 0));
    const first = s.tracks.find((t) => t.src === 'dz') || s.tracks[0];
    const years = s.tracks.map((t) => +t.year).filter(Boolean);
    return { title: s.title, album: first.album, year: years.length ? Math.max(...years) : 0, dur: first.dur, order, rank, recs };
  }).sort((a, b) => a.order - b.order || b.rank - a.rank);
  console.log(`  ${list.length} songs, ${list.reduce((n, s) => n + s.recs.length, 0)} distinct recordings`);

  console.log('Downloading previews...');
  for (const s of list) for (const r of s.recs) r.file = await download(r);

  if (!secret.groqKey) {
    await writeFile(path.join(CACHE, 'tracks.json'), JSON.stringify(list.map((s) => ({ title: s.title, album: s.album, year: s.year, recs: s.recs.map((r) => `${r.src}:${r.dur}s`) })), null, 1));
    console.log('No Groq key yet: stopping before transcription. Track list saved to .cache/tracks.json');
    return;
  }

  console.log(`Transcribing with ${MODEL}...`);
  let limited = false, done = 0, lastLimits = null;
  // Deezer clips for every song first, then iTunes clips in popularity order.
  const jobs = [];
  for (const s of list) for (const r of s.recs) if (r.src === 'dz' && r.file) jobs.push([s, r]);
  if (!skipIt) for (const s of list) for (const r of s.recs) if (r.src === 'it' && r.file) jobs.push([s, r]);
  for (const [s, r] of jobs) {
    if (limited) { r.tr = await readJson(path.join(TR, `${path.basename(r.file)}.${MODEL}.json`), null); continue; }
    const j = await transcribe(r.file, secret.groqKey);
    if (j === 'LIMIT') { limited = true; continue; }
    r.tr = j;
    if (j) { done++; lastLimits = j._limits || lastLimits; if (done % 10 === 0) console.log(`  ${done}/${jobs.length}`); }
  }
  if (lastLimits) console.log('  rate limit headers:', JSON.stringify(lastLimits));
  if (limited) console.log('  Stopped early at the rate limit; re-run later to add the rest.');

  const catalog = { artist: ARTIST_HE, builtAt: new Date().toISOString(), model: MODEL, songs: [] };
  for (const s of list) {
    const sections = [];
    for (const r of s.recs) {
      if (!r.tr) continue;
      const lines = toLines(r.tr);
      if (lines.length >= 2) sections.push({ src: r.src, live: /live|לייב/i.test(r.rawTitle), f: path.basename(r.file), lines });
    }
    catalog.songs.push({ id: `s${catalog.songs.length + 1}`, title: s.title, album: s.album, year: s.year, dur: s.dur, sections });
  }
  // Full lyrics from the web (tools/fetch-lyrics.mjs). They become the song's main section; the clip transcripts stay
  // alongside for matching. Web lyrics carry no timing, so each line gets a duration from the song's own measured pace.
  const web = await readJson(path.join(CACHE, 'mz', 'lyrics.json'), []);
  const WEB_ALIAS = { 'דימעה אחרונה': 'דמעה אחרונה', 'חפש אחת': 'חפש אחרת', 'ייסוריי אהבה': 'ייסורי אהבה', 'לנצח לאוהב': 'לנצח לאהוב',
    'על השקרים שלך': 'כל השקרים שלך', 'אני בוכה': KMO_SHELANU, 'שילגיה': 'שלגיה' };
  const best = new Map();
  for (const w of web) {
    let title = cleanTitle(w.title);
    title = WEB_ALIAS[title] || title;
    let song = catalog.songs.find((s) => s.title === title || s.title.split(' · ').includes(title));
    if (!song) {
      song = { id: `s${catalog.songs.length + 1}`, title, album: '', year: 0, dur: 0, sections: [] };
      catalog.songs.push(song);
      console.log('  web lyrics for a song not in the stores:', title);
    }
    const n = w.lines.filter(Boolean).length;
    if (!best.has(song) || n > best.get(song).n) best.set(song, { n, lines: w.lines });
  }
  for (const [song, w] of best) {
    // Pace: seconds per word measured on this song's own clips, from line start to line start (gaps included).
    // Lines on the site are often half-phrases of two or three words, so timing follows the words, with a floor.
    let spw = 1.0;
    const timed = song.sections.filter((x) => x.lines.length >= 3).sort((x, y) => y.lines.length - x.lines.length)[0];
    if (timed) {
      const words = timed.lines.slice(0, -1).reduce((n, l) => n + l.x.split(' ').length, 0);
      spw = Math.min(1.5, Math.max(0.5, (timed.lines[timed.lines.length - 1].a - timed.lines[0].a) / words));
    }
    let t = 0, brk = false;
    const lines = [];
    for (const raw of w.lines) {
      if (!raw) { brk = true; continue; }
      const x = raw.replace(/[.,!?"]/g, '').replace(/\s+/g, ' ').trim();
      if (!x) continue;
      const d = Math.max(2.4, x.split(' ').length * spw);
      const line = { a: +t.toFixed(2), b: +(t + d - 0.3).toFixed(2), x };
      if (brk && lines.length) line.s = 1; // first line of a stanza
      brk = false;
      lines.push(line);
      t += d;
    }
    song.sections.unshift({ src: 'web', full: true, lines });
  }
  console.log(`  full web lyrics attached to ${best.size} songs`);

  await writeFile(path.join(ROOT, 'catalog.json'), JSON.stringify(catalog));
  const withLyrics = catalog.songs.filter((s) => s.sections.length).length;
  console.log(`catalog.json: ${catalog.songs.length} songs, ${withLyrics} with lyric sections, ${catalog.songs.reduce((n, s) => n + s.sections.reduce((m, x) => m + x.lines.length, 0), 0)} lines`);
}
main().catch((e) => { console.error(e); process.exit(1); });
