// Matcher checks against the real catalog.
//  1. Synthetic: noisy copies of catalog lines must lock on the right song; stage chatter must not lock.
//  2. Hold-out on real audio: one recording of a song is removed from the index and its raw transcript is replayed
//     in overlapping 10-second chunks, as the phone does. It must lock on that song or stay silent.
//  3. Unknown songs: a song is removed from the index completely and replayed. Any lock is a false lock.
// Run with --sweep to compare lock thresholds, -v for per-song output.
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

const trCache = new Map();
async function trOf(sec) {
  if (!sec.f) return null;
  if (!trCache.has(sec.f)) {
    const file = path.join(ROOT, '.cache', 'tr', `${sec.f}.${catalog.model}.json`);
    trCache.set(sec.f, existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null);
  }
  return trCache.get(sec.f);
}

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
function chunks(tr, len = 10, hop = 6) {
  const out = [];
  const dur = tr.duration || Math.max(...(tr.words || []).map((w) => w.end), 0);
  for (let from = 0; from < dur - 3; from += hop) {
    const to = from + len;
    const segments = [];
    for (const s of tr.segments || []) {
      const ws = (tr.words || []).filter((w) => w.start >= s.start - 0.05 && w.end <= s.end + 0.05 && w.start >= from && w.start < to);
      if (!ws.length) continue;
      segments.push({ start: ws[0].start - from, end: ws[ws.length - 1].end - from, text: ws.map((w) => w.word).join(' '), no_speech_prob: s.no_speech_prob, avg_logprob: s.avg_logprob, compression_ratio: s.compression_ratio });
    }
    const words = (tr.words || []).filter((w) => w.start >= from && w.start < to).map((w) => ({ word: w.word, start: w.start - from, end: w.end - from }));
    out.push({ t0: 500 + from, t1: 500 + Math.min(to, dur), tr: { segments, words } });
  }
  return out;
}

function synthetic(opts) {
  seed = 7;
  const r = { ok: 0, wrong: 0, none: 0 };
  for (const song of catalog.songs) {
    const sec = song.sections.find((s) => s.lines.length >= 4);
    if (!sec) continue;
    const m = createMatcher(catalog, opts); m.start();
    m.feedChunk(chunkFromLines(sec.lines.slice(0, 3), 100));
    m.feedChunk(chunkFromLines(sec.lines.slice(1, 4), 106));
    const st = m.state;
    if (st.phase !== 'locked') r.none++; else if (st.song.id === song.id) r.ok++; else r.wrong++;
  }
  return r;
}

async function holdout(opts) {
  const r = { ok: 0, wrong: 0, none: 0, karaoke: 0 };
  for (const song of catalog.songs) {
    const held = song.sections.find((s) => s.src === 'it');
    const rest = song.sections.filter((s) => s.src === 'dz');
    if (!held || !rest.length) continue;
    const tr = await trOf(held);
    if (!tr) continue;
    const m = createMatcher({ ...catalog, songs: catalog.songs.map((s) => (s === song ? { ...s, sections: rest } : s)) }, opts); m.start();
    let got = null, k = false;
    for (const c of chunks(tr)) {
      m.feedChunk(c);
      if (m.state.phase === 'locked' && !got) got = m.state.song;
      if (m.state.phase === 'locked' && m.state.mode === 'karaoke') k = true;
    }
    if (!got) r.none++; else if (got.id === song.id) { r.ok++; if (k) r.karaoke++; } else { r.wrong++; if (verbose) console.log(`    wrong: ${song.title} -> ${got.title}`); }
  }
  return r;
}

async function unknown(opts) {
  const r = { silent: 0, falseLock: 0 };
  for (const song of catalog.songs) {
    const sec = song.sections[0];
    const tr = sec && await trOf(sec);
    if (!tr) continue;
    const m = createMatcher({ ...catalog, songs: catalog.songs.filter((s) => s !== song) }, opts); m.start();
    let got = null;
    for (const c of chunks(tr)) { m.feedChunk(c); if (m.state.phase === 'locked' && !got) got = m.state.song; }
    if (got) { r.falseLock++; if (verbose) console.log(`    false lock: ${song.title} -> ${got.title}`); } else r.silent++;
  }
  return r;
}

// Web lyrics against real audio: the song keeps only its web lyrics, and its Deezer clip transcript is replayed.
async function webHoldout(opts) {
  const r = { ok: 0, wrong: 0, none: 0, karaoke: 0 };
  for (const song of catalog.songs) {
    const webSec = song.sections.find((s) => s.src === 'web');
    const held = song.sections.find((s) => s.src === 'dz' && !s.live);
    if (!webSec || !held) continue;
    const tr = await trOf(held);
    if (!tr) continue;
    const m = createMatcher({ ...catalog, songs: catalog.songs.map((s) => (s === song ? { ...s, sections: [webSec] } : s)) }, opts); m.start();
    let got = null, k = false;
    for (const c of chunks(tr)) {
      m.feedChunk(c);
      if (m.state.phase === 'locked' && !got) got = m.state.song;
      if (m.state.phase === 'locked' && m.state.mode === 'karaoke' && !m.state.paused) k = true;
    }
    if (!got) { r.none++; if (verbose) console.log(`    web none: ${song.title}`); } else if (got.id === song.id) { r.ok++; if (k) r.karaoke++; } else { r.wrong++; console.log(`    web wrong: ${song.title} -> ${got.title}`); }
  }
  return r;
}

function chatterLocks(opts) {
  const lines = ['ערב טוב לכולם תודה רבה שבאתם אני כל כך מתרגשת להיות פה איתכם הערב', 'אני רוצה לראות את כל הידיים למעלה תעשו רעש', 'השיר הבא נכתב לפני הרבה שנים והוא מלווה אותי כל החיים', 'תודה רבה לנגנים המדהימים שלי ולכל הצוות שעובד מאחורי הקלעים', 'אני אוהבת אתכם אתם הקהל הכי טוב שיש'];
  const m = createMatcher(catalog, opts); m.start();
  lines.forEach((x, i) => m.feedChunk({ t0: 100 + i * 6, t1: 110 + i * 6, tr: { segments: [{ start: 0, end: 9, text: x, no_speech_prob: 0, avg_logprob: -0.3, compression_ratio: 1 }], words: x.split(' ').map((w, k) => ({ word: w, start: k * 0.5, end: k * 0.5 + 0.4 })) } }));
  return m.state.phase === 'locked';
}

if (process.argv.includes('--sweep')) {
  for (const lockChunk of [0.5, 0.7, 0.9, 1.1]) for (const lockEv of [0.9, 1.2, 1.5]) {
    const o = { lockChunk, lockEv };
    const s = synthetic(o), h = await holdout(o), u = await unknown(o);
    console.log(`chunk ${lockChunk} ev ${lockEv} | synthetic ok ${s.ok} wrong ${s.wrong} none ${s.none} | holdout ok ${h.ok} wrong ${h.wrong} none ${h.none} | unknown falseLock ${u.falseLock}/${u.falseLock + u.silent} | chatter ${chatterLocks(o) ? 'LOCK' : 'ok'}`);
  }
} else {
  const s = synthetic({}), h = await holdout({}), u = await unknown({});
  const chat = chatterLocks({});
  console.log(`synthetic: ${JSON.stringify(s)}`);
  console.log(`hold-out (other store's clip vs Deezer-only index): ${JSON.stringify(h)}`);
  console.log(`unknown songs: ${JSON.stringify(u)}`);
  console.log(`web lyrics vs the song's own clip: ${JSON.stringify(await webHoldout({}))}`);
  console.log(`stage chatter: ${chat ? 'FALSE LOCK' : 'no lock'}`);
  if (s.wrong > 1 || h.wrong > 1 || u.falseLock > 3 || chat) { console.error('FAIL'); process.exit(1); }
  console.log('PASS');
}
