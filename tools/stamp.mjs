// Stamps one version into the page and every module URL, so a browser can never run a new script with an old page
// (GitHub Pages lets browsers reuse each file for ten minutes). Run before every deploy: node tools/stamp.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const v = Date.now().toString(36);
for (const f of ['index.html', 'app.js']) {
  const p = path.join(ROOT, f);
  let s = await readFile(p, 'utf8');
  s = s.replace(/(\.js)\?v=[\w.]+/g, `$1?v=${v}`)
    .replace(/(<meta name="app-version" content=")[^"]*(")/, `$1${v}$2`)
    .replace(/(const VERSION = ')[^']*(')/, `$1${v}$2`);
  await writeFile(p, s);
}
console.log('version', v);
