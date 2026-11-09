// What the web app may ask of Obsidian while it edits one .bedrock file.
// Takes Obsidian's objects as arguments (no imports), so tests can pass
// stand-ins.

/**
 * @param {object} o
 * @param {object} o.vault       Obsidian Vault
 * @param {() => object} o.file  the open TFile
 * @param {object} o.indexer     Indexer (index-note.js)
 * @param {object} o.kv          { get(key), set(key, value) } stored by the plugin
 * @param {(query: string, sourcePath: string) => Promise<string|null>} o.pickNote
 * @param {(target: string, sourcePath: string) => void} o.openLink
 * @param {() => void} [o.onReady]
 */
export function createSession({ vault, file, indexer, kv, pickNote, openLink, onReady }) {
  // mtime of our own last write, to tell our saves from outside changes.
  let ownMtime = null;
  let writing = Promise.resolve();
  let inFlight = 0;
  const session = {
    get ownMtime() { return ownMtime; },
    /** True if a modify event for the file was not our own save. */
    isOutsideChange(f) { return f === file() && !inFlight && f.stat.mtime !== ownMtime; },
    handlers: {
      ready: async () => { onReady?.(); return true; },
      read: async () => {
        const f = file();
        const data = await vault.readBinary(f);
        return { name: f.basename, created: f.stat.ctime, modified: f.stat.mtime, data };
      },
      write: async ({ data }) => {
        const f = file();
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        inFlight++;
        writing = writing.catch(() => {}).then(async () => {
          try {
            await vault.modifyBinary(f, buf);
            ownMtime = f.stat.mtime;
          } finally {
            inFlight--;
          }
          // Keep search and links in step with the handwriting, including
          // corrections the writer made to what was read.
          await indexer?.update(f.path, buf).catch((e) => console.warn('Bedrock: index not updated', e));
        });
        await writing;
        return true;
      },
      'get-kv': async ({ key }) => kv.get(`${file().path}\u0000${key.replace(/:.*/, '')}`) ?? null,
      'set-kv': async ({ key, value }) => { await kv.set(`${file().path}\u0000${key.replace(/:.*/, '')}`, value); return true; },
      'pick-note': async ({ query }) => pickNote(query || '', file().path),
      'open-link': async ({ target }) => { openLink(target, file().path); return true; },
    },
  };
  return session;
}
