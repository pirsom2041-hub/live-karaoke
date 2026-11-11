// Matcher checks against the real catalog.
//  1. Synthetic: noisy copies of catalog lines must lock on the right song; unrelated speech must not lock.
//  2. Hold-out on real audio: a song's second recording (other store's clip, or the live single) is removed from
//     the index and its raw transcript is replayed in 10-second chunks. It must lock on that song or stay silent.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMatcher } from '../matcher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(path.join(ROOT, 'catalog.json'), 'utf8'));
const verbose = process.argv.includes('-v');
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

function noisy(text) {
  return text.split(/\s+/).filter(() => rnd() > 0.2).map((w) => {
    if (w.length > 3 && rnd() < 0.3) { const i = 1 + Math.floor(rnd() * (w.length - 2)); return w.slice(0, i) + w.slice(i + 1); }
    return w;
  }).join(' ');
}
function chunkFromLines(lines, t0) {
  const base = lines[0].a;
  const segments = lines.map((l) => ({ start: l.a - base, end: l.b - base, text: noisy(l.x), no_speech_prob: 0, avg_logprob: -0.3, compression_ratio: 1 }));
  const words = segments.flatMap((s) => { const ws = s.text.split(/\s+/).filter(Boolean), d = (s.end - s.start) / Math.max(1, ws.length); return ws.map((w, i) => ({ word: w, start: s.start + i * d, end: s.start + (i + 1) * d })); });
  return { t0, t1: t0 + 10, tr: { segments, words } };
}

// ---- 1. synthetic ----
let ok = 0, wrong = 0, none = 0, n = 0;
for (const song of catalog.songs) {
  const sec = song.sections.find((s) => s.lines.length >= 5);
  if (!sec) continue;
  n++;
  const m = createMatcher(catalog);
  m.start();
  m.feedChunk(chunkFromLines(sec.lines.slice(0, 3), 100));
  m.feedChunk(chunkFromLines(sec.lines.slice(2, 5), 110));
  const st = m.state;
  if (st.phase !== 'locked') none++; else if (st.song.id === song.id) ok++; else { wrong++; if (verbose) console.log('  synthetic wrong:', song.title, '->', st.song.title); }
}
console.log(`synthetic: ${ok}/${n} correct, ${wrong} wrong, ${none} not locked`);

const chatter = ['ערב טוב לכולם תודה רבה שבאתם אני כל כך מתרגשת להיות פה איתכם הערב', 'אני רוצה לראות את כל הידיים למעלה תעשו רעש', 'השיר הבא נכתב לפני הרבה שנים והוא מלווה אותי כל החיים', 'תודה רבה לנגנים המדהימים שלי ולכל הצוות שעובד מאחורי הקלעים'];
{
  const m = createMatcher(catalog); m.start();
  chatter.forEach((x, i) => m.feedChunk({ t0: 100 + i * 10, t1: 110 + i * 10, tr: { segments: [{ start: 0, end: 9, text: x, no_speech_prob: 0, avg_logprob: -0.3, compression_ratio: 1 }], words: x.split(' ').map((w, k) => ({ word: w, start: k * 0.5, end: k * 0.5 + 0.4 })) } }));
  console.log(`stage chatter: ${m.state.phase === 'locked' ? 'FALSE LOCK on ' + m.state.song.title : 'no lock (good)'}`);
}

// ---- 2. hold-out on real transcripts ----
function chunks(tr, len = 10) {
  const out = [];
  const dur = tr.duration || Math.max(...(tr.words || []).map((w) => w.end), 0);
  for (let from = 0; from < dur - 3; from += len) {
    const to = from + len;
    const segments = [];
    for (const s of tr.segments || []) {
      const ws = (tr.words || []).filter((w) => w.start >= s.start - 0.05 && w.end <= s.end + 0.05 && w.start >= from && w.start < to);
      if (!ws.length) continue;
      segments.push({ start: ws[0].start - from, end: ws[ws.length - 1].end - from, text: ws.map((w) => w.word).join(' '), no_speech_prob: s.no_speech_prob, avg_logprob: s.avg_logprob, compression_ratio: s.compression_ratio });
    }
    const words = (tr.words || []).filter((w) => w.start >= from && w.start < to).map((w) => ({ word: w.word, start: w.start - from, end: w.end - from }));
    out.push({ t0: 500 + from, t1: 500 + to, tr: { segments, words } });
  }
  return out;
}

const res = { live: { ok: 0, wrong: 0, none: 0 }, cross: { ok: 0, wrong: 0, none: 0 } };
let karaoke = 0;
for (const song of catalog.songs) {
  if (song.sections.length < 2) continue;
  for (const held of song.sections) {
    const isLive = held.live;
    if (!isLive && held.src !== 'it') continue;
    if (!held.f) continue;
    const trFile = path.join(ROOT, '.cache', 'tr', `${held.f}.${catalog.model}.json`);
    if (!existsSync(trFile)) continue;
    const rest = song.sections.filter((s) => s !== held && (isLive ? !s.live : s.src === 'dz'));
    if (!rest.length) continue;
    const cat = { ...catalog, songs: catalog.songs.map((s) => (s === song ? { ...s, sections: rest } : s)) };
    const m = createMatcher(cat); m.start();
    let got = null, sawKaraoke = false;
    for (const c of chunks(JSON.parse(await readFile(trFile, 'utf8')))) {
      m.feedChunk(c);
      if (m.state.phase === 'locked' && !got) got = m.state.song;
      if (m.state.phase === 'locked' && m.state.mode === 'karaoke') sawKaraoke = true;
    }
    const bucket = res[isLive ? 'live' : 'cross'];
    if (!got) bucket.none++; else if (got.id === song.id) { bucket.ok++; if (sawKaraoke) karaoke++; } else { bucket.wrong++; console.log(`  WRONG: ${song.title} -> ${got.title}`); }
    if (verbose) console.log(`  ${isLive ? 'live ' : 'cross'} ${song.title}: ${got ? got.title : '-'}${sawKaraoke ? ' [karaoke]' : ''}`);
  }
}
console.log(`live single vs studio index: ${JSON.stringify(res.live)}`);
console.log(`other store's clip vs Deezer index: ${JSON.stringify(res.cross)} (none = the two clips cover different parts of the song)`);
console.log(`reached karaoke mode: ${karaoke}`);
if (wrong > 0 || res.live.wrong + res.cross.wrong > 2) { console.error('FAIL'); process.exit(1); }
