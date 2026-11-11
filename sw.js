// Offline support without version mix-ups.
//  - Files requested with ?v=N never change: cache first, exact URL. A page and its scripts therefore always match.
//  - The page itself and the data bundle: network first (fresh when online), cache when there is no signal.
const C = 'lk-v2';
const CORE = ['./', 'manifest.webmanifest', 'icon.svg', 'data.enc'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(C).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(url, key, cache) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 4000);
  try {
    // Fetch by URL (not by the original request object): a navigation request cannot be re-issued with options.
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-cache' });
    clearTimeout(to);
    if (r.ok) cache.put(key, r.clone());
    return r;
  } catch (err) {
    clearTimeout(to);
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(C);
    if (u.searchParams.has('v')) {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    }
    if (e.request.mode === 'navigate') return networkFirst(u.href, './', cache); // one cached copy of the page
    return networkFirst(u.href, u.pathname, cache);
  })());
});
