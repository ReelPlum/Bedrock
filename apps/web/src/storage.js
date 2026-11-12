// Local-first storage: every note lives in IndexedDB on this device first.
// Saving never waits on a network; cloud sync (see cloud.js) is layered on top.

const DB_NAME = 'bedrock';
const DB_VERSION = 1;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class NoteStore {
  static async open(name = DB_NAME) {
    const r = indexedDB.open(name, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'id' });
        s.createIndex('modified', 'modified');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    const store = new NoteStore();
    store.db = await req(r);
    return store;
  }

  _tx(store, mode = 'readonly') {
    return this.db.transaction(store, mode).objectStore(store);
  }

  /** Metadata for all notes, newest first (without the note bytes). */
  async list() {
    const all = await req(this._tx('notes').getAll());
    return all
      .map(({ id, title, created, modified }) => ({ id, title, created, modified }))
      .sort((a, b) => b.modified - a.modified);
  }

  async get(id) {
    return (await req(this._tx('notes').get(id))) || null;
  }

  /** note: { id, title, created, modified, data: Uint8Array (.bedrock), camera: [x, y, zoom] } */
  async put(note) {
    const tx = this.db.transaction('notes', 'readwrite');
    tx.objectStore('notes').put(note);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('save aborted'));
    });
  }

  async remove(id) {
    await req(this._tx('notes', 'readwrite').delete(id));
  }

  async getKv(key) {
    return req(this._tx('kv').get(key));
  }

  async setKv(key, value) {
    await req(this._tx('kv', 'readwrite').put(value, key));
  }
}

/** Random 64-bit seed as [hi, lo] u32 for stroke ids. */
export function randomSeed() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return [a[0], a[1]];
}

export function newNoteId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
