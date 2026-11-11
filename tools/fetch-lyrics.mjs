// Fetches the artist's lyric pages from mizrahit.co (public, robots.txt allows /lyrics.php) into .cache/mz/lyrics.json.
// One request at a time with a pause; pages are cached on disk, so a re-run costs nothing.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, '.cache', 'mz');
const BASE = 'http://www.mizrahit.co/';
const SINGER = 81;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) personal-lyrics-fetch';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const text = (html) => decode(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

async function get(url, file) {
  if (existsSync(file)) return readFile(file, 'utf8');
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const html = await r.text();
  await writeFile(file, html);
  await sleep(400);
  return html;
}

function extractLyrics(html) {
  const open = html.indexOf('<div id="songText"');
  if (open < 0) return [];
  const start = html.indexOf('>', open) + 1;
  const end = html.indexOf('</div>', start);
  const lines = html.slice(start, end).split(/<br\s*\/?>/i).map(text);
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  // collapse runs of blank lines into a single stanza break
  return lines.filter((l, i) => l || (i > 0 && lines[i - 1]));
}

await mkdir(DIR, { recursive: true });
const list = await get(`${BASE}lyrics.php?singer=${SINGER}`, path.join(DIR, 'singer.html'));
const seen = new Map();
for (const m of list.matchAll(/<a[^>]+href=["'][^"']*lyrics\.php\?id=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
  const title = text(m[2]).replace(/^.*?\s-\s/, '').trim();
  if (title && !seen.has(m[1])) seen.set(m[1], title);
}
console.log(`${seen.size} lyric pages listed`);
const out = [];
for (const [id, title] of seen) {
  try {
    const html = await get(`${BASE}lyrics.php?id=${id}`, path.join(DIR, `p${id}.html`));
    const lines = extractLyrics(html);
    if (lines.filter(Boolean).length >= 4) out.push({ id, title, lines });
    else console.warn('  no lyrics found on page', id);
  } catch (e) { console.warn('  failed', id, e.message); }
}
await writeFile(path.join(DIR, 'lyrics.json'), JSON.stringify(out));
const n = out.map((o) => o.lines.filter(Boolean).length);
console.log(`${out.length} pages with lyrics, ${n.reduce((a, b) => a + b, 0)} lines, median ${n.sort((a, b) => a - b)[Math.floor(n.length / 2)]} lines per song`);
