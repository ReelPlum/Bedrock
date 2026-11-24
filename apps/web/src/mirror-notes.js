// Note mirrors: a copy of the handwriting of every note, kept up to date in
// the training data backend as the writer adds and erases strokes, so
// recognition can later be trained on notes exactly as they were written
// (the `note-mirrors` spec, and the backend's).
//
// Only ink leaves the device: each stroke's id, start time and raw pen
// samples. No title, typed text, pictures, file name, folder, brush or
// colour, and no highlighter strokes. The backend's id for a note is a
// random id made here, not the app's note id.
//
// What was sent is remembered per note (the stroke ids), so each change is
// sent once: strokes written since are added, strokes gone since are
// erased (the backend then deletes their ink too; an erased stroke that
// comes back, by undo, is sent again under a new id), and a note gone from the
// library is deleted. Notes already in the library when mirroring is turned
// on are sent in full, whatever version of the note format they were saved
// in (`note_ink_json` reads them all).
//
// Uploads wait in a queue in IndexedDB (`bedrock-mirror`) like samples do,
// so writing offline loses nothing. They need the contributor secret
// (collect.js), so only this device can change or delete its mirrors.

import * as collect from './collect.js';

/** What a mirror upload may hold, as the backend checks it. */
export const MAX_ADD_STROKES = 800;
export const MAX_ADD_POINTS = 50_000;
export const MAX_ERASE = 16;
/** Uploads per request, and a body size that stays under the backend's 1 MB. */
export const UPLOADS_PER_REQUEST = 5;
const MAX_BODY = 900 * 1024;
const SEND_EVERY_MS = 60_000;
const RETRY_MS = [5_000, 30_000, 120_000, 600_000];

/** The uploads that make a mirror match `strokes` (`[{ id, start, points }]`
 *  in drawing order) when it holds `sent` (stroke ids). */
export function plan({ mirror, channels, strokes, sent, now = Date.now(), uuid = collect.uuidv7, extra = {} }) {
  const had = new Set(sent);
  const has = new Set(strokes.map((s) => s.id));
  const added = strokes.filter((s) => !had.has(s.id));
  const erased = sent.filter((id) => !has.has(id));
  const width = channels.length;
  const upload = (add, erase) => ({
    format: 'bedrock-note-mirror', version: 1, id: uuid(now), note: mirror, channels,
    add, erase, written: now, ...extra,
  });
  const out = [];
  let add = [];
  let points = 0;
  let bytes = 0;
  for (const s of added) {
    const p = s.points.length / width;
    const b = s.points.length * 8 + 64;
    if (add.length && (add.length >= MAX_ADD_STROKES || points + p > MAX_ADD_POINTS || bytes + b > MAX_BODY / 2)) {
      out.push(upload(add, []));
      add = [];
      points = 0;
      bytes = 0;
    }
    add.push({ id: s.id, start: s.start, points: s.points });
    points += p;
    bytes += b;
  }
  if (add.length) out.push(upload(add, []));
  for (let i = 0; i < erased.length; i += MAX_ERASE) out.push(upload([], erased.slice(i, i + MAX_ERASE)));
  return out;
}

/** The uploads that go in one request: at most 5, at most 16 erased
 *  strokes in all, and under the size limit (always at least one). */
export function fitRequest(queued) {
  const out = [];
  let erase = 0;
  let bytes = 0;
  for (const u of queued) {
    const b = JSON.stringify(u).length;
    if (out.length && (out.length >= UPLOADS_PER_REQUEST || erase + u.erase.length > MAX_ERASE || bytes + b > MAX_BODY)) break;
    out.push(u);
    erase += u.erase.length;
    bytes += b;
  }
  return out;
}

/** A new stroke id for the mirror (16 hex digits, like the note's own). */
function randomStrokeId() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** A note's ink, from `note_ink_json` or the open canvas, with highlighters
 *  already left out. */
function strokesOf(ink) {
  return (ink.strokes || []).map((s) => ({ id: String(s.id), start: s.start, points: s.points }));
}

export class NoteMirrors {
  /**
   * @param {object} o
   * @param {object} o.store `{ get(note), put(rec), remove(note), all(), clear() }`: what was sent per note
   * @param {object} o.queue `{ put(uploads), first(n), remove(ids), clear(), count() }`
   * @param {() => boolean} o.enabled mirroring is on and saving is set up
   * @param {(uploads) => Promise<{done: string[]}>} o.send sends one request
   */
  constructor({ store, queue, enabled, send, now = Date.now, uuid = collect.uuidv7, strokeId = randomStrokeId, extra = () => ({}) }) {
    Object.assign(this, { store, queue, enabled, send, now, uuid, strokeId, extra });
    this.busy = null;
    this.flushing = null;
    this.retries = 0;
    this.retryTimer = null;
  }

  /** One at a time, so a change is never planned twice. */
  _serial(run) {
    this.busy = (this.busy || Promise.resolve()).then(run, run);
    return this.busy;
  }

  /** Makes the mirror of `note` (the app's id) match its ink now.
   *  `ink`: `{ channels, strokes }`, or for the open note `{ channels, ids,
   *  stroke(id) }` so only new strokes' ink is read. `modified`: the
   *  library's time for the note, so an unchanged note is skipped later.
   *  Returns how many uploads were queued. */
  sync(note, ink, modified = null) {
    return this._serial(async () => {
      if (!this.enabled()) return 0;
      const rec = (await this.store.get(note)) || { note, mirror: this.uuid(this.now()), sent: [], modified: null };
      const ids = ink.ids ? ink.ids.map(String) : (ink.strokes || []).map((s) => String(s.id));
      const had = new Set(rec.sent);
      // A stroke erased from the mirror is never stored there again, so one
      // that comes back (an erase undone) is sent under a new id.
      const erased = new Set(rec.erased || []);
      const alias = {};
      const mirrorId = (id) => {
        let m = rec.alias?.[id] ?? id;
        if (!had.has(m) && erased.has(m)) {
          do m = this.strokeId(); while (erased.has(m) || had.has(m));
        }
        if (m !== id) alias[id] = m;
        return m;
      };
      let strokes;
      if (ink.ids) {
        // Only the new strokes' ink is read; the rest is known by id.
        strokes = ids.map((id) => {
          const m = mirrorId(id);
          if (had.has(m)) return { id: m };
          const s = ink.stroke(id);
          return s && { ...s, id: m };
        }).filter(Boolean);
      } else {
        strokes = strokesOf(ink).map((s) => ({ ...s, id: mirrorId(s.id) }));
      }
      const uploads = plan({ mirror: rec.mirror, channels: ink.channels, strokes, sent: rec.sent, now: this.now(), uuid: this.uuid, extra: this.extra() });
      const now = new Set(strokes.map((s) => s.id));
      for (const id of rec.sent) if (!now.has(id)) erased.add(id);
      if (uploads.length) await this.queue.put(uploads);
      await this.store.put({ ...rec, sent: strokes.map((s) => s.id), erased: [...erased], alias, modified });
      if (uploads.length) this.sendSoon();
      return uploads.length;
    });
  }

  /** The writer deleted the note: its mirror is deleted. */
  remove(note) {
    return this._serial(async () => {
      const rec = await this.store.get(note);
      if (!rec) return 0;
      if (this.enabled()) {
        await this.queue.put([{ format: 'bedrock-note-mirror', version: 1, id: this.uuid(this.now()), note: rec.mirror, channels: ['x', 'y'], add: [], erase: [], deleted: true, written: this.now() }]);
        this.sendSoon();
      }
      await this.store.remove(note);
      return 1;
    });
  }

  /** Brings every note in the library up to date: `notes` is the library's
   *  `[{ id, modified }]`; `inkOf(id)` reads a stored note's ink
   *  (`note_ink_json` on its file). A note whose mirror is up to date for
   *  its `modified` is not read again; `skip` (the open note) is synced
   *  from the canvas instead. Notes gone from the library are deleted.
   *  Returns how many notes were read. */
  async library(notes, inkOf, skip = null) {
    if (!this.enabled()) return 0;
    let read = 0;
    const present = new Set(notes.map((n) => n.id));
    for (const n of notes) {
      if (n.id === skip) continue;
      const rec = await this.store.get(n.id);
      if (rec && rec.modified === n.modified) continue;
      let ink;
      try {
        ink = await inkOf(n.id);
      } catch (_) {
        continue; // a damaged note is left as it is
      }
      if (!ink) continue;
      await this.sync(n.id, ink, n.modified);
      read++;
    }
    for (const rec of await this.store.all()) if (!present.has(rec.note) && rec.note !== skip) await this.remove(rec.note);
    return read;
  }

  /** Forgets every mirror on this device (after "Delete my
   *  contributions"): the next sync starts afresh. */
  async forget() {
    await this._serial(async () => {
      await this.queue.clear();
      await this.store.clear();
    });
  }

  sendSoon(ms = SEND_EVERY_MS) {
    if (this.sendTimer) return;
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.flush().catch(() => {});
    }, ms);
  }

  /** Sends what is waiting, one request at a time. */
  flush() {
    this.flushing ||= (async () => {
      await null;
      try {
        for (;;) {
          if (!this.enabled()) return;
          const batch = fitRequest(await this.queue.first(UPLOADS_PER_REQUEST));
          if (!batch.length) break;
          const { done } = await this.send(batch);
          await this.queue.remove(done);
          this.retries = 0;
          if (!done.length) throw { later: true };
        }
      } catch (e) {
        if (!e?.later) throw e;
        if (!e.stop) {
          clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => this.flush().catch(() => {}), RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)]);
        }
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }
}

// ---- Storage on the device (IndexedDB `bedrock-mirror`, version 1) --------
//
// `notes`: `{ note, mirror, sent: [stroke id], erased: [stroke id], alias:
// { note's stroke id: mirror's stroke id }, modified }` keyed by the app's
// note id. `erased` and `alias` came with the fix for undone erases; a
// record without them reads as having none. `queue`: uploads (`bedrock-note-mirror` version 1) keyed by
// their id, oldest first (ids are UUID version 7).

const DB_NAME = 'bedrock-mirror';
let dbPromise = null;
function db() {
  dbPromise ||= new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('notes', { keyPath: 'note' });
      open.result.createObjectStore('queue', { keyPath: 'id' });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return dbPromise;
}

async function tx(name, mode, run) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(name, mode);
    const out = run(t.objectStore(name));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const deviceStore = {
  get: (note) => tx('notes', 'readonly', (s) => s.get(note)),
  put: (rec) => tx('notes', 'readwrite', (s) => s.put(rec)),
  remove: (note) => tx('notes', 'readwrite', (s) => s.delete(note)),
  all: () => tx('notes', 'readonly', (s) => s.getAll()),
  clear: () => tx('notes', 'readwrite', (s) => s.clear()),
};

export const deviceQueue = {
  put: (uploads) => tx('queue', 'readwrite', (s) => { for (const u of uploads) s.put(u); }),
  first: (n) => tx('queue', 'readonly', (s) => s.getAll(null, n)),
  remove: (ids) => tx('queue', 'readwrite', (s) => { for (const id of ids) s.delete(id); }),
  clear: () => tx('queue', 'readwrite', (s) => s.clear()),
  count: () => tx('queue', 'readonly', (s) => s.count()),
};

/** Deletes everything this device keeps about mirrors (after "Delete my
 *  contributions"). Works whether or not mirroring was ever on. */
export async function forgetOnDevice() {
  if (typeof indexedDB === 'undefined') return;
  await deviceQueue.clear().catch(() => {});
  await deviceStore.clear().catch(() => {});
}
