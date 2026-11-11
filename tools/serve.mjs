// Local helper server: key page, optional lyrics paste page, and the app itself for desktop testing.
// Binds to localhost only.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5173;
const SECRET = path.join(ROOT, '.secret.json');
const CATALOG = path.join(ROOT, 'catalog.json');
const PASTES = path.join(ROOT, '.cache', 'pastes');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.enc': 'application/octet-stream', '.ico': 'image/x-icon',
};
// Only these top-level files are served as the app (never .secret.json, catalog.json or .cache).
const PUBLIC = new Set(['index.html', 'app.js', 'matcher.js', 'audio.js', 'visuals.js', 'store.js', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'data.enc']);

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
      return json(res, 200, { groqKey: s.groqKey || '', catalog: c });
    }
    if (p === '/api/paste' && req.method === 'POST') {
      const { text } = JSON.parse(await readBody(req) || '{}');
      if (!text || text.length < 40) return json(res, 400, { ok: false });
      await mkdir(PASTES, { recursive: true });
      const name = `${Date.now()}.txt`;
      await writeFile(path.join(PASTES, name), text);
      return json(res, 200, { ok: true, name });
    }
    if (p === '/key' || p === '/paste') {
      return send(res, 200, MIME['.html'], await readFile(path.join(ROOT, 'tools', `${p.slice(1)}.html`)));
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
