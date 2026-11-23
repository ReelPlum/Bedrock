// What the web app may ask of Obsidian while it edits one .bedrock file.
// Takes Obsidian's objects as arguments (no imports), so tests can pass
// stand-ins.

/** How long writing pauses before the index note is brought up to date. */
export const INDEX_DELAY_MS = 2500;

/** Stroke ids are up to 16 hex digits (docs/note-format.md). */
export const isStrokeId = (s) => typeof s === 'string' && /^[0-9a-f]{1,16}$/i.test(s);

/** The ink a view was asked to show when it was opened, as stroke ids.
 *  `eState` is Obsidian's ephemeral state: `bedrock.strokes` when the plugin
 *  redirected a search hit from an index note, or `subpath` when a link
 *  such as `[[Physics.bedrock#^9f2c4e1a7b3d5f60]]` was followed. */
export function strokesOfState(eState) {
  const own = eState?.bedrock?.strokes;
  if (Array.isArray(own)) return own.filter(isStrokeId);
  const m = typeof eState?.subpath === 'string' && /^#\^([0-9a-f]{1,16})$/i.exec(eState.subpath);
  return m ? [m[1].toLowerCase()] : [];
}

/** The link another note uses to point at the word with this stroke. */
export const linkToStroke = (linktext, stroke) => `[[${linktext}#^${stroke}]]`;

/**
 * @param {object} o
 * @param {object} o.vault       Obsidian Vault
 * @param {() => object} o.file  the open TFile
 * @param {object} o.indexer     Indexer (index-note.js)
 * @param {object} o.kv          { get(key), set(key, value) } stored by the plugin
 * @param {(query: string, sourcePath: string) => Promise<string|null>} o.pickNote
 * @param {(target: string, sourcePath: string) => void} o.openLink
 * @param {(stroke: string, sourcePath: string) => Promise<void>} [o.copyLink]  put a link to the word with this stroke on the clipboard
 * @param {(report: object) => Promise<string>} [o.sendReport]  send an error report from the canvas ("Share with the Bedrock team")
 * @param {{ job: (name: string, fn: () => any) => any }} [o.perf]  times reads, writes and index updates (perf.js)
 * @param {() => void} [o.onReady]
 * @param {() => Promise<WebAssembly.Module|null>} [o.wasm]  the canvas's WebAssembly, compiled once by the plugin
 * @param {number} [o.indexDelayMs]  how long writing must pause before the index note is written
 */
export function createSession({ vault, file, indexer, kv, pickNote, openLink, copyLink, sendReport, onReady, perf, wasm, indexDelayMs = INDEX_DELAY_MS }) {
  const job = (name, fn) => (perf ? perf.job(name, fn) : fn());
  // The index note follows the file once writing pauses, not after every
  // autosave: each index write makes Obsidian re-read the note for search,
  // links and the graph, on the main thread the canvas shares with it.
  let indexBytes = null;
  let indexTimer = null;
  let indexing = Promise.resolve();
  const flushIndex = () => {
    clearTimeout(indexTimer);
    indexTimer = null;
    const buf = indexBytes;
    indexBytes = null;
    if (buf && indexer) {
      indexing = indexing.then(() => job('index', () => indexer.update(file().path, buf)))
        .catch((e) => console.warn('Bedrock: index not updated', e));
    }
    return indexing;
  };
  // mtime of our own last write, to tell our saves from outside changes.
  let ownMtime = null;
  let writing = Promise.resolve();
  let inFlight = 0;
  const session = {
    get ownMtime() { return ownMtime; },
    /** Write the index note now if a save is waiting for it (the view
     *  closes). Resolves once it is written. */
    flushIndex,
    /** True if a modify event for the file was not our own save. */
    isOutsideChange(f) { return f === file() && !inFlight && f.stat.mtime !== ownMtime; },
    handlers: {
      ready: async () => { onReady?.(); return true; },
      // Sent as a compiled module (structured clone shares its code).
      wasm: async () => (wasm ? (await wasm().catch(() => null)) : null),
      read: async () => {
        const f = file();
        const data = await job('read', () => vault.readBinary(f));
        return { name: f.basename, created: f.stat.ctime, modified: f.stat.mtime, data };
      },
      write: async ({ data }) => {
        const f = file();
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        // The app hands the file's buffer over (no copy); copy only a part.
        const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
        const buf = whole ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        inFlight++;
        writing = writing.catch(() => {}).then(async () => {
          try {
            await job('write', () => vault.modifyBinary(f, buf));
            ownMtime = f.stat.mtime;
          } finally {
            inFlight--;
          }
          // Keep search and links in step with the handwriting, including
          // corrections the writer made to what was read, once writing pauses.
          indexBytes = buf;
          clearTimeout(indexTimer);
          indexTimer = setTimeout(flushIndex, indexDelayMs);
        });
        await writing;
        return true;
      },
      'get-kv': async ({ key }) => kv.get(`${file().path}\u0000${key.replace(/:.*/, '')}`) ?? null,
      'set-kv': async ({ key, value }) => { await kv.set(`${file().path}\u0000${key.replace(/:.*/, '')}`, value); return true; },
      'pick-note': async ({ query }) => pickNote(query || '', file().path),
      'open-link': async ({ target }) => { openLink(target, file().path); return true; },
      'send-report': async ({ report } = {}) => {
        if (!sendReport || !report || typeof report !== 'object') throw new Error('Sending is not switched on here.');
        return { id: await sendReport(report) };
      },
      'copy-link': async ({ stroke }) => {
        if (!copyLink || !isStrokeId(stroke)) return false;
        await copyLink(stroke, file().path);
        return true;
      },
    },
  };
  return session;
}
