// When Bedrock runs inside another app (the Obsidian plugin), that app is the
// "host". The web app then runs unchanged in an iframe, opened with
// `?host=<name>`, and talks to the host with postMessage:
//
//   * the note is a file the host owns: `HostStore` reads and writes it in
//     place of IndexedDB (same interface as NoteStore);
//   * links to the host's files are turned on, picked from the host's
//     folders and files in the canvas's own picker (link-picker.js) and
//     opened by the host;
//   * the host can ask to be shown a place in the note (a search hit, a
//     link to a word), and can be asked for a link to one;
//   * the note's name in the header is the host file's name: naming the
//     note renames the file, and renaming the file renames the note;
//   * the host can open the note view only (the plugin on a desktop
//     computer): it can be looked at, moved around and its links followed,
//     but nothing in it changes and it is never saved.
//
// Nothing here runs in the normal web app (`host` is null there). Keeping the
// differences in this one file lets the web app and every host ship from the
// same code. The protocol is documented in apps/obsidian/README.md.

import { linkType } from './links.js';
import { LinkPicker } from './link-picker.js';

const params = new URLSearchParams(location.search);
// The plugin's own page has no address to carry `?host=`: it sets
// BEDROCK_HOST instead (apps/obsidian/src/inline-app.js).
const name = params.get('host') || globalThis.BEDROCK_HOST || null;
// View only: set by the plugin's page (BEDROCK_VIEW_ONLY) or `?view=only`.
const viewOnly = globalThis.BEDROCK_VIEW_ONLY === true || params.get('view') === 'only';

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
    await this.rpc.call('write', { data: note.data, title: note.title }, transferable(note.data));
  }

  async remove() { /* the host deletes its own files */ }

  getKv(key) { return this.rpc.call('get-kv', { key }); }

  async setKv(key, value) {
    if (!key.endsWith(`:${HOST_NOTE}`)) return;
    await this.rpc.call('set-kv', { key, value });
  }
}

export const HOST_NOTE = 'host';

/** What a view-only note does not show: everything that draws, inserts or
 *  changes the note (the menu's settings rows by the control they hold). */
export const VIEW_ONLY_HIDDEN = [
  '#toolbar', '#stroke-pop', '#btn-undo', '#btn-redo',
  '[data-action="import-pdf"]', '[data-action="insert-image"]', '[data-action="paste"]',
  '.row:has(#paper)', '.row:has(#dock)', '.row:has(#pressure)', '.row:has(#smoothing)', '.row:has(#smoother)',
  '.row:has(#finger-draw)', '.row:has(#scribble-erase)', '.row:has(#show-recognizer)', '.row:has(#hover-preview)',
  '#record-trace',
];

/** The buffer of a saved file, to hand to the host without a copy: a
 *  save is built fresh and not used again once written. Only a buffer the
 *  bytes fill alone, so nothing else is taken with it. */
export function transferable(data) {
  const b = data?.buffer;
  return data instanceof Uint8Array && b instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === b.byteLength ? [b] : [];
}

function connect() {
  if (!name || window.parent === window) return null;
  const rpc = channel(window.parent);
  let picker = null;
  document.documentElement.dataset.host = name;
  // The host keeps the list of notes and makes new ones.
  const style = document.createElement('style');
  style.textContent = '#btn-library, [data-action="new"], [data-action="open"], [data-action="export-all"] { display: none !important; }';
  document.head.append(style);
  if (viewOnly) {
    document.documentElement.dataset.viewOnly = 'true';
    // Nothing that draws, inserts or changes the note: the tools, undo and
    // redo, the pen's settings, inserting, pasting and importing.
    const ro = document.createElement('style');
    ro.textContent = `${VIEW_ONLY_HIDDEN.join(', ')} { display: none !important; } #stage { cursor: grab; }`;
    document.head.append(ro);
  }

  Object.assign(linkType('note'), {
    available: true,
    // Offered first when making a link.
    preferred: true,
    /** Show the vault's folders and files to choose from. Resolves to a
     *  link target, or null if the picker was closed. */
    pick: () => (picker ||= new LinkPicker(rpc)).pick(),
    open: (target) => rpc.call('open-link', { type: 'note', target }),
    /** Put a link to a place in this note (the word with this stroke) on
     *  the clipboard, for pasting into one of the host's notes. */
    copyHere: (stroke) => rpc.call('copy-link', { stroke }),
  });

  return {
    name,
    /** The note can be looked at but not changed, and is never saved. */
    viewOnly,
    noteId: HOST_NOTE,
    rpc,
    store: () => new HostStore(rpc),
    /** Let the host run app functions it needs (e.g. save before closing). */
    on: (event, fn) => rpc.on(event, fn),
    /** What a new note starts with, if the host made it about something:
     *  `{ noteLinks: [{ target, type, text }], tags: [] }`, or null. */
    start: () => rpc.call('start'),
    /** What every new note starts with: `{ paper }`, the paper chosen in
     *  the host's settings. */
    defaults: () => rpc.call('defaults'),
    /** The note's name is its file's name: ask the host to rename the
     *  file to `title`. Resolves to `{ name }`, the file's name after. */
    rename: (title) => rpc.call('rename', { title }),
    /** The WebAssembly the host compiled once for all its notes, or null
     *  (the app then compiles it itself). */
    wasm: () => rpc.call('wasm').catch(() => null),
    /** Tell the host the app is ready for events. */
    ready: () => rpc.call('ready'),
  };
}

export const host = connect();
