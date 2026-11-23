// Local-first storage: every note lives in IndexedDB on this device first.
// Saving never waits on a network; cloud sync (see cloud.js) is layered on top.
//
// Folders live in their own store as { id, name, parent, created } (parent
// is a folder id, or null at the top). A note names its folder in `folder`
// (null or missing: the top). An export turns them into real directories
// (library.js).
//
// Version 3: `meta` holds each note's { id, title, created, modified, folder }
// beside its record in `notes` (which also has the file bytes, `data`), so
// the notes list and folder deletes never read every note's file. Both are
// written in one transaction. Opening a version 2 database copies the
// metadata of every note into `meta`; `notes` records are not changed.

const DB_NAME = 'bedrock';
const DB_VERSION = 3;

const metaOf = ({ id, title, created, modified, folder }) => ({ id, title, created, modified, folder: folder || null });

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
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
      // Version 2: folders. Notes saved before have no `folder`: the top.
      if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
      // Version 3: metadata beside the notes, copied from the notes there.
      if (!db.objectStoreNames.contains('meta')) {
        const meta = db.createObjectStore('meta', { keyPath: 'id' });
        const cursor = r.transaction.objectStore('notes').openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          meta.put(metaOf(c.value));
          c.continue();
        };
      }
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
    const all = await req(this._tx('meta').getAll());
    return all.map(metaOf).sort((a, b) => b.modified - a.modified);
  }

  async get(id) {
    return (await req(this._tx('notes').get(id))) || null;
  }

  /** note: { id, title, created, modified, folder, data: Uint8Array (.bedrock) } */
  async put(note) {
    const tx = this.db.transaction(['notes', 'meta'], 'readwrite');
    tx.objectStore('notes').put(note);
    tx.objectStore('meta').put(metaOf(note));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('save aborted'));
    });
  }

  async remove(id) {
    const tx = this.db.transaction(['notes', 'meta'], 'readwrite');
    tx.objectStore('notes').delete(id);
    tx.objectStore('meta').delete(id);
    await done(tx);
  }

  /** Put a note in a folder (null: the top). */
  async move(id, folder) {
    const tx = this.db.transaction(['notes', 'meta'], 'readwrite');
    const notes = tx.objectStore('notes');
    const rec = await req(notes.get(id));
    if (rec) {
      const moved = { ...rec, folder: folder || null };
      notes.put(moved);
      tx.objectStore('meta').put(metaOf(moved));
    }
    await done(tx);
  }

  /** All folders, as saved. */
  async listFolders() {
    return req(this._tx('folders').getAll());
  }

  /** Create or rename a folder: { id, name, parent, created }. */
  async putFolder(folder) {
    await req(this._tx('folders', 'readwrite').put({ ...folder, parent: folder.parent || null }));
  }

  /** Delete a folder with the folders and notes inside it, in one go.
   *  Returns the ids of the notes deleted. */
  async removeFolder(id) {
    const tx = this.db.transaction(['folders', 'notes', 'meta'], 'readwrite');
    const folders = tx.objectStore('folders');
    const notes = tx.objectStore('notes');
    const meta = tx.objectStore('meta');
    const all = await req(folders.getAll());
    const gone = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const f of all) if (!gone.has(f.id) && gone.has(f.parent)) { gone.add(f.id); grew = true; }
    }
    const deleted = [];
    for (const n of await req(meta.getAll())) {
      if (n.folder && gone.has(n.folder)) { notes.delete(n.id); meta.delete(n.id); deleted.push(n.id); }
    }
    for (const f of gone) folders.delete(f);
    await done(tx);
    return deleted;
  }

  async getKv(key) {
    return req(this._tx('kv').get(key));
  }

  async setKv(key, value) {
    await req(this._tx('kv', 'readwrite').put(value, key));
  }
}

/** Ask the browser to keep this site's storage (the notes, and the cached
 *  recognition models) instead of clearing it when space runs low or, in
 *  Safari, after seven days without a visit. The app asks once per page
 *  load, after the first save, never at start: Firefox shows a prompt.
 *  Resolves to whether storage is kept; never throws. */
export async function keepStorage(storage = globalThis.navigator?.storage) {
  try {
    if (!storage?.persist) return false;
    if (storage.persisted && (await storage.persisted())) return true;
    return !!(await storage.persist());
  } catch (_) {
    return false;
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
