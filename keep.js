// Keeps the chunks recorded during the show, and what the app decided about them, on this phone only (IndexedDB).
// Purpose: real concert audio to test the next version against. Nothing in this file uploads anything.
// Every call is best-effort: a storage failure must never disturb the app.
const NAME = 'lk-keep';
const MAX_CHUNKS = 900; // about two and a half hours
let dbp = null, n = -1, off = false;

function open() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(NAME, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('chunks', { autoIncrement: true });
        r.result.createObjectStore('events', { autoIncrement: true });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

function add(store, value) {
  return open().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).add(value);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  }));
}

export async function count() {
  try {
    const db = await open();
    return await new Promise((res, rej) => {
      const r = db.transaction('chunks').objectStore('chunks').count();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  } catch (e) { return 0; }
}

// rec: { at, blob, ...what the app heard and decided }
export async function keepChunk(rec) {
  if (off) return;
  try {
    if (n < 0) n = await count();
    if (n >= MAX_CHUNKS) return;
    await add('chunks', rec);
    n++;
  } catch (e) { off = true; } // storage full or unavailable: stop trying for this session
}

export function keepEvent(ev) {
  if (off) return;
  add('events', { at: Date.now(), ...ev }).catch(() => {});
}

export async function clearAll() {
  try {
    const db = await open();
    await new Promise((res, rej) => {
      const tx = db.transaction(['chunks', 'events'], 'readwrite');
      tx.objectStore('chunks').clear();
      tx.objectStore('events').clear();
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    n = 0; off = false;
    return true;
  } catch (e) { return false; }
}

// Everything in one store, oldest first. Blobs come back as handles, not loaded into memory.
export async function readAll(store) {
  const db = await open();
  return new Promise((res, rej) => {
    const out = [];
    const r = db.transaction(store).objectStore(store).openCursor();
    r.onsuccess = () => { const c = r.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
    r.onerror = () => rej(r.error);
  });
}

export const kept = () => Math.max(0, n);
