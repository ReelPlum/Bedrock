// When Bedrock runs inside another app (the Obsidian plugin), that app is the
// "host". The web app then runs unchanged in an iframe, opened with
// `?host=<name>`, and talks to the host with postMessage:
//
//   * the note is a file the host owns: `HostStore` reads and writes it in
//     place of IndexedDB (same interface as NoteStore);
//   * links to the host's notes are turned on, picked with the host's own
//     file picker and opened by the host.
//
// Nothing here runs in the normal web app (`host` is null there). Keeping the
// differences in this one file lets the web app and every host ship from the
// same code. The protocol is documented in apps/obsidian/README.md.

import { linkType } from './links.js';

const params = new URLSearchParams(location.search);
const name = params.get('host');

/** A request/response channel to the parent window. */
function channel(target) {
  let seq = 0;
  const waiting = new Map();
  const handlers = new Map();
  window.addEventListener('message', async (e) => {
    const m = e.data;
    if (e.source !== target || !m || m.bedrock !== 1) return;
    if (m.reply != null) {
      const w = waiting.get(m.reply);
      waiting.delete(m.reply);
      if (w) (m.error != null ? w.reject(new Error(m.error)) : w.resolve(m.result));
    } else if (m.event) {
      const h = handlers.get(m.event);
      let result = null;
      let error = null;
      try { result = h ? await h(m.args) : null; } catch (err) { error = String(err?.message || err); }
      if (m.seq != null) target.postMessage({ bedrock: 1, reply: m.seq, result, error }, '*');
    }
  });
  return {
    call(method, args = {}, transfer = []) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        target.postMessage({ bedrock: 1, seq: id, method, args }, '*', transfer);
      });
    },
    on(event, fn) { handlers.set(event, fn); },
  };
}

/** The host's file as a one-note store. Ids are ignored: whatever the app
 *  saves is the host's file. */
export class HostStore {
  constructor(rpc) { this.rpc = rpc; }

  async list() {
    const r = await this.rpc.call('read');
    return [{ id: HOST_NOTE, title: r.name, created: r.created, modified: r.modified }];
  }

  /** The file, or null while it is empty (a new note). */
  async get() {
    const r = await this.rpc.call('read');
    if (!r.data || !r.data.byteLength) return null;
    return { id: HOST_NOTE, title: r.name, created: r.created, modified: r.modified, data: new Uint8Array(r.data) };
  }

  /** Only the host's note is written: the app's placeholder note before
   *  the file has loaded must never overwrite it. */
  async put(note) {
    if (note.id !== HOST_NOTE) return;
    await this.rpc.call('write', { data: note.data, title: note.title });
  }

  async remove() { /* the host deletes its own files */ }

  getKv(key) { return this.rpc.call('get-kv', { key }); }

  async setKv(key, value) {
    if (!key.endsWith(`:${HOST_NOTE}`)) return;
    await this.rpc.call('set-kv', { key, value });
  }
}

export const HOST_NOTE = 'host';

function connect() {
  if (!name || window.parent === window) return null;
  const rpc = channel(window.parent);
  document.documentElement.dataset.host = name;
  // The host keeps the list of notes and makes new ones.
  const style = document.createElement('style');
  style.textContent = '#btn-library, [data-action="new"], [data-action="open"], [data-action="export-all"] { display: none !important; }';
  document.head.append(style);

  Object.assign(linkType('note'), {
    available: true,
    // Offered first when making a link.
    preferred: true,
    /** Ask the host to show its note picker. Resolves to a link target, or
     *  null if the picker was closed. */
    pick: (query) => rpc.call('pick-note', { query }),
    open: (target) => rpc.call('open-link', { type: 'note', target }),
  });

  return {
    name,
    noteId: HOST_NOTE,
    rpc,
    store: () => new HostStore(rpc),
    /** Let the host run app functions it needs (e.g. save before closing). */
    on: (event, fn) => rpc.on(event, fn),
    /** Tell the host the app is ready for events. */
    ready: () => rpc.call('ready'),
  };
}

export const host = connect();
