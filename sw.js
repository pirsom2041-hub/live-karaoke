// Network first (so republished versions arrive), cache fallback (so the app opens with no signal).
const C = 'lk-v1';
const SHELL = ['./', 'index.html', 'app.js', 'matcher.js', 'audio.js', 'visuals.js', 'store.js', 'manifest.webmanifest', 'icon.svg', 'data.enc'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(C).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(C);
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 3500);
      const r = await fetch(e.request, { signal: ctl.signal, cache: 'no-cache' });
      clearTimeout(to);
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    } catch (err) {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
