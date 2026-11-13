// What the web app may ask of Obsidian while it edits one .bedrock file.
// Takes Obsidian's objects as arguments (no imports), so tests can pass
// stand-ins.

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
 * @param {() => void} [o.onReady]
 */
export function createSession({ vault, file, indexer, kv, pickNote, openLink, copyLink, sendReport, onReady }) {
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
