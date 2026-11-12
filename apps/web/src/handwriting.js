// Handwriting: words -> recognised text -> spell check -> red wavy underline.
//
// The core lays out the page into words (and says which look like maths);
// this module renders each new or changed word into a small image, has the
// recogniser read it, stores the answer in the note (tied to the exact
// strokes, so it survives saving and is dropped when the word changes), and
// draws a red wavy line under words the spell checker doesn't know.
//
// The recogniser is pluggable: by default a worker running TrOCR for text and
// Pix2Text MFR for formulas, on the device. Anything with the same shape can
// be set as `engine` (a native recogniser later, or a fake in tests):
//   async ({ kind: 'text' | 'math', image: Blob, word, quality: 'fast' | 'careful' })
//     => ({ text, engine })

import { MODELS } from './models.js';

const IDLE_MS = 700; // recognise once the pen has rested this long
const CAREFUL_IDLE_MS = 4000; // the careful re-read starts after this long
const LETTER_PX = 40; // letter height in the image sent to the recogniser
const PAD_PX = 12;

export class Handwriting {
  constructor(canvas, marks, { onTextChanged, onStatus, onWordStatus } = {}) {
    this.canvas = canvas;
    this.marks = marks; // <canvas> above the ink for the underlines
    this.onTextChanged = onTextChanged || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onWordStatus = onWordStatus || (() => {});
    this.status = new Map(); // word id -> 'Reading…' or the error, until it has text
    this.enabled = true;
    this.spelling = true;
    this.engine = null; // null: the built-in worker, created on first use
    this.workers = new Map(); // 'all' -> the recogniser Worker
    this.pending = new Map(); // request id -> { resolve, reject }
    this.inFlight = new Set(); // word ids being recognised
    this.failed = new Map(); // 'fast:id' / 'careful:id' -> attempts
    // 'live': the fast model as you write; 'careful': only the larger model,
    // once the pen rests; 'both': live, then the careful model re-reads.
    this.mode = 'both';
    this.timer = null;
    this.carefulTimer = null;
    this.carefulRun = 0; // bumped to stop a careful pass when writing resumes
    this.seq = 0;
    this.dictionaryReady = false;
    this.dpr = 1;
  }

  /** Load the spell-check word list: gzip (decompressed by the browser), or
   *  plain text where a host can't serve .gz files. */
  async loadDictionary(urls = ['dict/en.txt.gz', 'dict/en.txt']) {
    try {
      let res = null;
      for (const url of urls) {
        res = await fetch(url).catch(() => null);
        if (res && res.ok) break;
      }
      if (!res || !res.ok) throw new Error('no word list');
      // Some hosts already undo the gzip (Content-Encoding): check the magic.
      const bytes = new Uint8Array(await res.arrayBuffer());
      let text;
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        if (typeof DecompressionStream !== 'function') return false;
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        text = await new Response(stream).text();
      } else {
        text = new TextDecoder().decode(bytes);
      }
      this.dictionaryReady = this.canvas.load_dictionary(text) > 0;
      this.onTextChanged();
      return this.dictionaryReady;
    } catch (_) {
      return false;
    }
  }

  /** Call when strokes change: recognition waits until the pen rests. */
  schedule() {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    clearTimeout(this.carefulTimer);
    this.carefulRun++;
    if (this.mode !== 'careful') this.timer = setTimeout(() => this.run(), IDLE_MS);
    if (this.mode !== 'live') this.carefulTimer = setTimeout(() => this.runCareful(), CAREFUL_IDLE_MS);
  }

  _tries(quality, id) { return this.failed.get(`${quality}:${id}`) || 0; }

  /** Live: recognise every word that has no text yet, with the fast model. */
  async run() {
    if (!this.enabled || this.mode === 'careful') return;
    if (this.canvas.is_drawing()) return this.schedule();
    const words = JSON.parse(this.canvas.words_json());
    const todo = words.filter((w) => w.kind !== 'drawing' && w.text == null && !this.inFlight.has(w.id) && this._tries('fast', w.id) < 2);
    await Promise.all(todo.map((w) => this._recognise(w, 'fast')));
  }

  /** True if the careful model already read this word (formulas have one
   *  model, so any answer counts), or the writer said what it says. */
  isCareful(w) {
    // A reading from an imported PDF (GoodNotes's own) is kept too.
    return w.text != null && (w.kind === 'math' || w.engine === 'user' || w.engine === 'pdf-text' || (w.engine || '').startsWith(MODELS.text.careful));
  }

  /** Careful: re-read words with the larger model, one at a time, stopping
   *  as soon as writing resumes. */
  async runCareful() {
    if (!this.enabled || this.mode === 'live') return;
    const run = this.carefulRun;
    const words = JSON.parse(this.canvas.words_json());
    const todo = words.filter((w) => w.kind !== 'drawing' && !this.isCareful(w) && !this.inFlight.has(w.id) && this._tries('careful', w.id) < 2);
    for (const w of todo) {
      if (run !== this.carefulRun || !this.enabled || this.canvas.is_drawing()) return;
      await this._recognise(w, 'careful');
    }
    // Pass finished: give the larger model's memory back until next time,
    // unless it is the only model in use.
    if (todo.length && this.mode === 'both') this.releaseModel('text-careful');
  }

  async _recognise(word, quality = 'fast') {
    this.inFlight.add(word.id);
    this._setStatus(word.id, 'Reading…');
    try {
      const image = await this.render(word);
      if (!image) return;
      const { text, engine } = await this._engine()({ kind: word.kind, image, word, quality });
      if (typeof text === 'string' && this.canvas.set_word_text(word.id, text, word.kind, engine || 'unknown', -1)) {
        this.status.delete(word.id);
        this.onTextChanged();
      }
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      this.failed.set(`${quality}:${word.id}`, this._tries(quality, word.id) + 1);
      this._setStatus(word.id, `Failed: ${msg}`);
      this.onStatus({ error: msg });
    } finally {
      this.inFlight.delete(word.id);
    }
  }

  _setStatus(id, text) {
    this.status.set(id, text);
    this.onWordStatus(id, text);
  }

  /** Which model a request uses (the worker loads each one on first use). */
  _slot(kind, quality) {
    return kind === 'math' ? 'math' : quality === 'careful' ? 'text-careful' : 'text-fast';
  }

  /** One worker for all models: iPad Safari can't run a second WebAssembly
   *  runtime, so they share one. */
  _worker(slot = 'all') {
    let w = this.workers.get(slot);
    if (w) return w;
    w = new Worker(new URL('./recognizer-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.status) return this.onStatus(m);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) {
        // Out of memory leaves the worker's heap unusable: start afresh.
        if (/memory/i.test(m.error)) this.dropWorker('all');
        p.reject(new Error(m.error));
      } else p.resolve(m);
    };
    w.onerror = (e) => {
      this.onStatus({ error: e.message || 'recogniser failed to start' });
      this.dropWorker('all');
    };
    this.workers.set(slot, w);
    return w;
  }

  /** Free one model's memory in the worker; it reloads from the browser's
   *  cache when next needed. */
  releaseModel(slot) {
    this.workers.get('all')?.postMessage({ release: slot });
  }

  /** Stop the worker and free all its memory. */
  dropWorker(slot = 'all') {
    const w = this.workers.get(slot);
    if (!w) return;
    w.terminate();
    this.workers.delete(slot);
    for (const [id, p] of this.pending) {
      if (p.slot === slot) { this.pending.delete(id); p.reject(new Error('recogniser stopped')); }
    }
  }

  _engine() {
    if (this.engine) return this.engine;
    return ({ kind, image, quality }) => new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject, slot: 'all' });
      this._worker().postMessage({ id, kind, image, quality });
    });
  }

  /** Linked words get a solid underline in the link colour, like a link. */
  _drawLinks(g, dpr) {
    const b = this.canvas.link_bounds();
    if (!b.length) return;
    const m = this.marks;
    const [ox, oy, zoom] = this.canvas.camera();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.strokeStyle = getComputedStyle(m).getPropertyValue('--link').trim() || '#2f6bff';
    g.lineWidth = 2;
    g.lineCap = 'round';
    for (let i = 0; i < b.length; i += 4) {
      const xa = (b[i] - ox) * zoom;
      const xb = (b[i + 2] - ox) * zoom;
      const y = (b[i + 3] - oy) * zoom + 3;
      if (xb < 0 || xa > m.clientWidth || y < -10 || y > m.clientHeight + 10) continue;
      g.beginPath();
      g.moveTo(xa, y);
      g.lineTo(xb, y);
      g.stroke();
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Draw a word's strokes black on white, scaled to a standard letter
   *  height, as the recognisers expect. Returns a PNG Blob. */
  async render(word) {
    const ink = this.canvas.word_ink(word.id);
    if (!ink.length) return null;
    const [x0, y0, x1, y1] = word.bounds;
    const s = LETTER_PX / Math.max(word.letterHeight, 1e-6);
    const w = Math.min(2048, Math.ceil((x1 - x0) * s + 2 * PAD_PX));
    const h = Math.min(1024, Math.ceil((y1 - y0) * s + 2 * PAD_PX));
    const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#000';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    let i = 0;
    while (i < ink.length) {
      const n = ink[i];
      g.lineWidth = Math.max(2, Math.min(6, ink[i + 1] * s));
      i += 2;
      g.beginPath();
      for (let k = 0; k < n; k++) {
        const x = PAD_PX + (ink[i + 2 * k] - x0) * s;
        const y = PAD_PX + (ink[i + 2 * k + 1] - y0) * s;
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      if (n === 1) g.lineTo(PAD_PX + (ink[i] - x0) * s + 0.01, PAD_PX + (ink[i + 1] - y0) * s);
      g.stroke();
      i += 2 * n;
    }
    if (c.convertToBlob) return c.convertToBlob({ type: 'image/png' });
    return new Promise((res) => c.toBlob(res, 'image/png'));
  }

  /** Draw the link underlines and the red wavy spelling underlines for the
   *  current view. Call every frame. Returns how many spelling marks. */
  draw() {
    const m = this.marks;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cw = Math.round(m.clientWidth * dpr);
    const ch = Math.round(m.clientHeight * dpr);
    if (m.width !== cw || m.height !== ch) { m.width = cw; m.height = ch; }
    const g = m.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, m.width, m.height);
    this._drawLinks(g, dpr);
    if (!this.spelling || !this.dictionaryReady) return 0;
    const bad = this.canvas.misspelled();
    if (!bad.length) return 0;
    const [ox, oy, zoom] = this.canvas.camera();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.strokeStyle = getComputedStyle(m).getPropertyValue('--spelling').trim() || '#e5484d';
    g.lineWidth = 1.5;
    g.lineCap = 'round';
    let drawn = 0;
    for (let i = 0; i < bad.length; i += 4) {
      const xa = (bad[i] - ox) * zoom;
      const xb = (bad[i + 2] - ox) * zoom;
      const y = (bad[i + 3] - oy) * zoom + 4;
      if (xb < 0 || xa > m.clientWidth || y < -10 || y > m.clientHeight + 10) continue;
      // A sine wave in screen pixels: same size at every zoom, like a
      // spell checker in a text editor.
      const amp = 1.6;
      const wave = 6;
      g.beginPath();
      for (let x = xa; x <= xb; x += 1) {
        const yy = y + amp * Math.sin(((x - xa) / wave) * 2 * Math.PI);
        if (x === xa) g.moveTo(x, yy); else g.lineTo(x, yy);
      }
      g.stroke();
      drawn++;
    }
    return drawn;
  }
}
