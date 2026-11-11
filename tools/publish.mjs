// Encrypts catalog + API key into data.enc and writes link.html (personal link + QR) for the phone.
// Usage: node tools/publish.mjs https://<user>.github.io/<repo>/
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, createCipheriv } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = path.join(ROOT, '.secret.json');
const secret = JSON.parse(await readFile(SECRET, 'utf8'));
const catalog = JSON.parse(await readFile(path.join(ROOT, 'catalog.json'), 'utf8'));
if (!secret.groqKey) throw new Error('no Groq key saved');

if (process.argv[2]) secret.baseUrl = process.argv[2].replace(/\/?$/, '/');
if (!secret.linkKey) secret.linkKey = randomBytes(32).toString('base64url');
await writeFile(SECRET, JSON.stringify(secret, null, 2));

// The published bundle carries only what the phone needs.
for (const s of catalog.songs) for (const sec of s.sections) delete sec.f;
const plain = gzipSync(Buffer.from(JSON.stringify({ groqKey: secret.groqKey, catalog })));
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', Buffer.from(secret.linkKey, 'base64url'), iv);
const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
await writeFile(path.join(ROOT, 'data.enc'), Buffer.concat([iv, ct, cipher.getAuthTag()]));
console.log(`data.enc: ${Math.round((ct.length + 28) / 1024)} KB, ${catalog.songs.length} songs`);

if (secret.baseUrl) {
  const link = `${secret.baseUrl}#k=${secret.linkKey}`;
  const QR = (await import('qrcode')).default;
  const img = await QR.toDataURL(link, { margin: 2, scale: 8, errorCorrectionLevel: 'M' });
  await writeFile(path.join(ROOT, 'link.html'), `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>קישור לפלאפון</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0b14;color:#f3eefc;font:18px system-ui,Arial">
<div style="text-align:center;padding:24px"><h1 style="margin:0 0 6px">סרוק עם הפלאפון</h1>
<p style="color:#c9c0de;margin:0 0 18px">פותחים את המצלמה, מכוונים לקוד, ופותחים את הקישור ב-Chrome.</p>
<img src="${img}" alt="QR" style="border-radius:16px;max-width:80vw">
<p style="font-size:12px;color:#8d84a6;direction:ltr;word-break:break-all;max-width:520px">${link}</p></div></body></html>`);
  console.log('link.html written');
}
