// Loads the encrypted bundle (catalog + API key) and keeps small per-device state.
const K = { key: 'lk.key', setlist: 'lk.setlist' };
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function loadBundle() {
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    return (await fetch('/api/dev-bundle')).json();
  }
  const m = location.hash.match(/k=([A-Za-z0-9_-]{20,})/);
  if (m) { ls.set(K.key, m[1]); history.replaceState(null, '', location.pathname + location.search); }
  const k = ls.get(K.key, '');
  if (!k) throw new Error('nokey');
  const buf = new Uint8Array(await (await fetch('data.enc', { cache: 'no-cache' })).arrayBuffer());
  const key = await crypto.subtle.importKey('raw', b64u(k), 'AES-GCM', false, ['decrypt']);
  const gz = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
  const text = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}

export const setlist = {
  all() { return ls.get(K.setlist, []); },
  add(song, manual) {
    const list = this.all();
    const last = list[list.length - 1];
    if (last && last.id === song.id && Date.now() - last.at < 8 * 60000) return list;
    list.push({ id: song.id, title: song.title, at: Date.now(), manual: !!manual });
    ls.set(K.setlist, list);
    return list;
  },
  clear() { ls.set(K.setlist, []); },
};
