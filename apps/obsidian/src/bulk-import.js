// Many PDFs at once (a GoodNotes library exported as PDFs), dropped on the
// settings: each becomes a .bedrock note at the vault's root, made the same
// way as importing a PDF into an open note (`import_pdf_as_one_note`).
//
// Built for hundreds of files: one file is read and held at a time, the PDF
// is read in a worker (PdfReader) so Obsidian never freezes, Obsidian gets
// to run between files, and a file that fails is listed with its reason
// while the rest go on. Free of Obsidian imports so it can be tested on its
// own and in the browser harness. (openspec: obsidian-plugin, "Many PDFs
// SHALL be imported at once from the settings".)

const EXTENSION = 'bedrock';
/** Characters a file name or an Obsidian link cannot hold (as newNote). */
const UNSAFE = /[\\/:*?"<>|#^[\]]/g;

const isPdfName = (name) => /\.pdf$/i.test(name);
/** `%PDF` within the first KB, as PDF readers accept it. */
function hasPdfHeader(buf) {
  const b = new Uint8Array(buf, 0, Math.min(buf.byteLength, 1024));
  for (let i = 0; i + 4 <= b.length; i++) {
    if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46) return true;
  }
  return false;
}

const messageOf = (e) => String(e?.message || e || 'unknown error');

/** The note's name for a PDF: its file name without folders or `.pdf`,
 *  with characters a file name or link cannot hold made spaces. */
export function noteBaseName(fileName) {
  const name = String(fileName || '').split(/[\\/]/).pop().replace(/\.pdf$/i, '');
  return name.replace(UNSAFE, ' ').trim() || 'Imported PDF';
}

/** The ArrayBuffer of exactly these bytes. */
function bufferOf(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export class BulkImport {
  /**
   * @param {object} o
   * @param {object} o.vault  Obsidian's Vault: getFiles, getAbstractFileByPath, createBinary
   * @param {(bytes: ArrayBuffer) => Promise<{ bedrock: Uint8Array|ArrayBuffer, warnings: string[] } | null>} o.convert  a PDF to a note's bytes, null if it has nothing to import
   * @param {(path: string, bytes: ArrayBuffer) => Promise<any>} [o.index]  write the new note's index note
   * @param {(state: object) => void} [o.onDone]  the import has finished (or was stopped)
   * @param {() => Promise<void>} [o.pause]  lets Obsidian run between files
   */
  constructor({ vault, convert, index = null, onDone = null, pause = () => new Promise((r) => setTimeout(r, 0)) }) {
    this.vault = vault;
    this.convert = convert;
    this.index = index;
    this.onDone = onDone;
    this.pause = pause;
    this.listeners = new Set();
    this.queue = [];
    this.state = BulkImport.empty();
    this.running = null;
  }

  static empty() {
    return { running: false, stopped: false, total: 0, done: 0, current: null, imported: [], failed: [] };
  }

  /** Calls `fn(state)` now and on every change; returns how to stop. */
  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.state = { ...this.state };
    for (const fn of this.listeners) {
      try { fn(this.state); } catch (_) { /* a closed settings page */ }
    }
  }

  /** Queue dropped files: `{ name, path?, read: () => Promise<ArrayBuffer> }`.
   *  Files dropped while an import runs join it; after one has finished,
   *  a drop starts a new count. */
  add(files) {
    const list = [...files];
    if (!list.length) return this.finished();
    if (!this.state.running) this.state = { ...BulkImport.empty(), running: true };
    this.queue.push(...list);
    this.state.total += list.length;
    this.emit();
    if (!this.running) this.running = this.run().finally(() => { this.running = null; });
    return this.finished();
  }

  /** Stop after the PDF being read; the rest are listed as not imported. */
  stop() {
    if (!this.state.running) return;
    this.state.stopped = true;
    this.emit();
  }

  /** Resolves to the state once nothing is left to import. */
  async finished() {
    while (this.running) await this.running;
    return this.state;
  }

  /** Names taken at the vault's root, ignoring case (macOS and iPadOS
   *  file names ignore it, so `physics.bedrock` would collide). */
  rootNames() {
    const names = new Set();
    for (const f of this.vault.getFiles()) if (!f.path.includes('/')) names.add(f.path.toLowerCase());
    return names;
  }

  freePath(base, taken) {
    for (let n = 0; ; n++) {
      const path = `${base}${n ? ` ${n}` : ''}.${EXTENSION}`;
      if (!taken.has(path.toLowerCase()) && !this.vault.getAbstractFileByPath(path)) return path;
    }
  }

  async run() {
    const taken = this.rootNames();
    while (this.queue.length) {
      const file = this.queue.shift();
      if (this.state.stopped) {
        this.state.failed.push({ name: file.name, reason: 'stopped' });
        this.state.done++;
        continue;
      }
      this.state.current = file.name;
      this.emit();
      await this.importOne(file, taken).catch((e) => this.state.failed.push({ name: file.name, reason: messageOf(e) }));
      this.state.done++;
      this.state.current = null;
      this.emit();
      // Let Obsidian draw and answer between files.
      await this.pause();
    }
    this.state.running = false;
    this.emit();
    try { this.onDone?.(this.state); } catch (_) { /* only a notice */ }
  }

  async importOne(file, taken) {
    const fail = (reason) => { this.state.failed.push({ name: file.name, reason }); };
    if (!isPdfName(file.name)) return fail('not a PDF');
    let bytes;
    try {
      bytes = await file.read();
    } catch (e) {
      return fail(`could not be read (${messageOf(e)})`);
    }
    if (!bytes || !hasPdfHeader(bytes)) return fail('not a PDF');
    let page;
    try {
      page = await this.convert(bytes);
    } catch (e) {
      return fail(messageOf(e));
    }
    bytes = null; // only the note is kept from here
    if (!page) return fail('no handwriting or pictures found');
    const note = bufferOf(page.bedrock);
    const base = noteBaseName(file.name);
    let path = null;
    for (let tries = 0; ; tries++) {
      const at = this.freePath(base, taken);
      taken.add(at.toLowerCase());
      try {
        await this.vault.createBinary(at, note);
        path = at;
        break;
      } catch (e) {
        // Made meanwhile (or differing only in case): the next name.
        if (/exist/i.test(messageOf(e)) && tries < 20) continue;
        return fail(`could not be saved (${messageOf(e)})`);
      }
    }
    const warnings = [...(page.warnings || [])];
    if (this.index) {
      try { await this.index(path, note); } catch (e) { warnings.push(`not added to search (${messageOf(e)})`); }
    }
    this.state.imported.push({ name: file.name, path, warnings });
  }
}

/** Reads PDFs in a worker (src/pdf-import-worker.js), one at a time. A
 *  reader that does not answer in `timeoutMs`, or crashes, is stopped and
 *  the PDF refused; the next PDF gets a new one. A reader is also started
 *  afresh every `freshEvery` PDFs: WebAssembly memory only grows, so this
 *  gives back what a big PDF took. */
export class PdfReader {
  /** `start()` resolves to a started Worker (or a stand-in); `paper()`
   *  is the paper new notes start with (the "Paper for new notes"
   *  setting), which each imported note is on. */
  constructor({ start, paper = () => 'grid', timeoutMs = 120_000, freshEvery = 25 }) {
    this.start = start;
    this.paper = paper;
    this.timeoutMs = timeoutMs;
    this.freshEvery = freshEvery;
    this.worker = null;
    this.used = 0;
    this.seq = 0;
    this.chain = Promise.resolve();
  }

  drop() {
    try { this.worker?.terminate(); } catch (_) { /* gone already */ }
    this.worker = null;
    this.used = 0;
  }

  /** The note made of the PDF's `bytes` (handed over to the worker), as
   *  `{ bedrock: ArrayBuffer, warnings, strokes }`, or null if no page has
   *  ink or pictures. */
  convert(bytes) {
    const run = this.chain.then(() => this.convertNow(bytes));
    this.chain = run.catch(() => null);
    return run;
  }

  async convertNow(bytes) {
    if (this.worker && this.used >= this.freshEvery) this.drop();
    if (!this.worker) this.worker = await this.start();
    const w = this.worker;
    this.used++;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const done = (fn, v) => {
        clearTimeout(timer);
        w.onmessage = w.onerror = null;
        this.cancel = null;
        fn(v);
      };
      this.cancel = () => done(reject, new Error('stopped'));
      const timer = setTimeout(() => {
        this.drop();
        done(reject, new Error('the PDF reader did not finish reading this PDF in time'));
      }, this.timeoutMs);
      w.onmessage = (e) => {
        const m = e.data || {};
        if (m.id !== id) return;
        if (m.error != null) done(reject, new Error(m.error));
        else done(resolve, m.page || null);
      };
      w.onerror = (e) => {
        e?.preventDefault?.();
        this.drop();
        done(reject, new Error(`the PDF reader stopped (${e?.message || 'it crashed'})`));
      };
      w.postMessage({ id, bytes, start: Date.now(), paper: this.paper() }, [bytes]);
    });
  }

  /** The plugin is unloaded: the PDF being read is given up. */
  close() {
    this.cancel?.();
    this.drop();
  }
}
