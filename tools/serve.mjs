// Local helper server: key page and the app itself for desktop testing.
// Binds to localhost only.
import http from 'node:http';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5173;
const SECRET = path.join(ROOT, '.secret.json');
const CATALOG = path.join(ROOT, 'catalog.json');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.enc': 'application/octet-stream', '.ico': 'image/x-icon',
};
// Only these top-level files are served as the app (never .secret.json, catalog.json or .cache).
const PUBLIC = new Set(['index.html', 'app.js', 'matcher.js', 'audio.js', 'visuals.js', 'store.js', 'keep.js', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'data.enc']);

const readJson = async (p, d) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return d; } };
const readBody = (req) => new Promise((res, rej) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 5e6) req.destroy(); });
  req.on('end', () => res(b)); req.on('error', rej);
});
const send = (res, code, type, data) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(data); };
const json = (res, code, obj) => send(res, code, MIME['.json'], JSON.stringify(obj));

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);

    if (p === '/api/key' && req.method === 'POST') {
      const { key } = JSON.parse(await readBody(req) || '{}');
      const k = String(key || '').trim();
      if (!/^gsk_[A-Za-z0-9]{20,}$/.test(k)) return json(res, 400, { ok: false, error: 'format' });
      const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${k}` } });
      if (!r.ok) return json(res, 400, { ok: false, error: 'rejected', status: r.status });
      const s = await readJson(SECRET, {});
      s.groqKey = k;
      await writeFile(SECRET, JSON.stringify(s, null, 2));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/status') {
      const s = await readJson(SECRET, {});
      const c = await readJson(CATALOG, null);
      return json(res, 200, { hasKey: !!s.groqKey, songs: c ? c.songs.length : 0 });
    }
    if (p === '/api/dev-bundle') {
      const s = await readJson(SECRET, {});
      const c = await readJson(CATALOG, { songs: [] });
      return json(res, 200, { groqKey: s.groqKey || '', exportTopic: s.diagTopic || '', catalog: c });
    }
    if (p === '/api/report' && req.method === 'POST') { // end-to-end test hook (?auto=1)
      await mkdir(path.join(ROOT, '.cache', 'e2e'), { recursive: true });
      await appendFile(path.join(ROOT, '.cache', 'e2e', 'report.jsonl'), `${await readBody(req)}
`);
      return json(res, 200, { ok: true });
    }
    if (p === '/key') {
      return send(res, 200, MIME['.html'], await readFile(path.join(ROOT, 'tools', 'key.html')));
    }
    const rel = p === '/' ? 'index.html' : p.slice(1);
    if (!PUBLIC.has(rel)) return send(res, 404, 'text/plain', 'not found');
    const data = await readFile(path.join(ROOT, rel));
    return send(res, 200, MIME[path.extname(rel)] || 'application/octet-stream', data);
  } catch (e) {
    if (e.code === 'ENOENT') return send(res, 404, 'text/plain', 'not found');
    console.error(e);
    return send(res, 500, 'text/plain', 'error');
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}/  (key page: http://localhost:${PORT}/key)`));
