// Sending every word written in a note to the training data backend, when
// the writer has turned "Send every word I write in notes" on (it needs the
// consent on /train first).
//
// Each word is sent once its reading has settled, as `unchecked`: the label
// is what the recogniser read, and training leaves it out until the writer
// or a reviewer checks it. When the writer later says the reading is right,
// corrects it, or says it is not a word, a new sample of the same ink is
// sent that `supersedes` the earlier one, so the backend keeps only the
// newest. A checked word is never replaced by an unchecked one.
//
// Only words written after the setting was turned on are sent by
// themselves. A word the writer checks while the setting is on is sent
// whenever it was written: checking it is the writer's own act. So is
// importing a PDF: every word of an imported note is sent at once.

import * as collect from './collect.js';

/** An unchecked reading is sent once it has not changed for this long, so
 *  the careful model (which re-reads after a pause) usually gets its say. */
export const SETTLE_MS = 20_000;
const SENT_KEY = 'bedrock.sharedWords.v1';
const MAX_KEPT = 5000;

export class WordSharer {
  /**
   * @param {object} o
   * @param {object} o.canvas the note's canvas (`words_json`, `stroke_json`, `meta_json`)
   * @param {() => string} o.noteId
   * @param {() => boolean} o.enabled the setting is on and collect is ready
   * @param {() => number} o.since when the setting was turned on, Unix ms
   * @param {() => boolean} o.reading true when the recogniser is on (else words are sent without text)
   * @param {() => boolean} [o.ready] saving is set up on /train (for imported notes)
   */
  constructor({ canvas, noteId, enabled, since, reading, ready = () => collect.isReady(), enqueue = collect.enqueue, now = Date.now, storage = globalThis.localStorage }) {
    Object.assign(this, { canvas, noteId, enabled, since, reading, ready, enqueue, now, storage });
    this.settleMs = SETTLE_MS;
    this.seen = new Map(); // key -> { sig, at }: when an unchecked reading was first seen
    this.checks = new Map(); // key -> { labelSource, reading, engine }: what the writer just did
    this.busy = null;
    this.sent = new Map();
    try {
      for (const [k, v] of JSON.parse(storage.getItem(SENT_KEY) || '[]')) this.sent.set(k, v);
    } catch (_) { /* private mode or damaged: start afresh */ }
  }

  _save() {
    // Oldest first; keep the newest few thousand.
    while (this.sent.size > MAX_KEPT) this.sent.delete(this.sent.keys().next().value);
    try { this.storage.setItem(SENT_KEY, JSON.stringify([...this.sent])); } catch (_) { /* private mode */ }
  }

  /** Forget what was sent (after "Delete my contributions"). */
  forget() {
    this.sent.clear();
    this.seen.clear();
    this._save();
  }

  /** The writer confirmed, corrected, or said a word is not a word. */
  checked(word, info) {
    if (!this.enabled() || word?.id == null) return Promise.resolve(0);
    this.checks.set(`${this.noteId()}:${word.id}`, info);
    return this.scan();
  }

  /** What `word` should be sent as now, or null. `imported`: the note was
   *  just imported, so a word without a reading is sent without text
   *  rather than waiting for the recogniser. */
  plan(word, key, imported = false) {
    if (word.id == null || !(word.strokes || []).length) return null;
    const check = this.checks.get(key);
    const kind = word.kind === 'math' ? 'math' : word.kind === 'drawing' ? 'drawing' : 'text';
    if (kind === 'drawing') {
      return { kind, label: '', labelSource: 'corrected', reading: check?.reading || null, engine: check?.engine || null, checked: true };
    }
    if (word.engine === 'user') {
      // Checked in an earlier session: the reading it replaced, if any, is
      // the first alternative.
      const alt = (word.alternatives || [])[0] || null;
      return {
        kind,
        label: word.text,
        labelSource: check?.labelSource || (alt ? 'corrected' : 'confirmed'),
        reading: check ? check.reading : alt,
        engine: check ? check.engine : null,
        checked: true,
      };
    }
    if (word.text != null) return { kind, label: word.text, labelSource: 'unchecked', reading: word.text, engine: word.engine || null, checked: false };
    // Not read: wait for the recogniser, unless it is off.
    return this.reading() && !imported ? null : { kind, label: '', labelSource: 'unchecked', reading: null, engine: null, checked: false };
  }

  /** Sends what is due. `force` sends unchecked readings without waiting
   *  for them to settle (the app is being hidden or the note closed).
   *  `imported`: the open note was just imported from a PDF; importing is
   *  the writer's own act, so every word is sent now, with the reading the
   *  PDF held, whenever it was written and even with "Send every word"
   *  off (saving must be set up on /train).
   *  Returns how many samples were queued. */
  scan({ force = false, imported = false } = {}) {
    if (imported) force = true;
    const run = async () => {
      if (!(imported ? this.ready() : this.enabled())) return 0;
      const note = this.noteId();
      const now = this.now();
      const batch = [];
      let channels = null;
      for (const word of JSON.parse(this.canvas.words_json())) {
        const key = `${note}:${word.id}`;
        const want = this.plan(word, key, imported);
        if (!want) continue;
        const sig = `${want.kind}|${want.labelSource}|${want.label}`;
        const prev = this.sent.get(key);
        if (prev?.sig === sig) continue;
        if (!want.checked) {
          if (prev && prev.source !== 'unchecked') continue; // never downgrade
          const seen = this.seen.get(key);
          if (!seen || seen.sig !== sig) this.seen.set(key, { sig, at: now });
          if (!force && now - (this.seen.get(key).at) < this.settleMs) continue;
        }
        const ink = word.strokes.map((id) => this.canvas.stroke_json(id)).filter(Boolean).map((j) => JSON.parse(j));
        if (!ink.length) continue;
        // Written before the setting was on: only sent if the writer checks
        // it now.
        if (!imported && !this.checks.has(key) && Math.min(...ink.map((s) => s.start)) < this.since()) continue;
        channels ||= JSON.parse(this.canvas.meta_json()).channels;
        const sample = collect.fromNote({
          strokes: ink,
          channels,
          label: want.label,
          labelSource: want.labelSource,
          kind: want.kind,
          language: want.kind === 'math' ? 'zxx' : 'en',
          reading: want.reading,
          engine: want.engine,
          supersedes: prev ? [prev.id] : [],
        });
        batch.push({ key, sample, sig, source: want.labelSource });
      }
      if (!batch.length) return 0;
      // One write for all of them: an imported page can hold hundreds.
      await this.enqueue(batch.map((b) => b.sample));
      for (const { key, sample, sig, source } of batch) {
        this.sent.delete(key); // re-insert so it counts as newest
        this.sent.set(key, { id: sample.id, sig, source });
        this.checks.delete(key);
      }
      this._save();
      return batch.length;
    };
    // One scan at a time, so a word is never sent twice by two scans.
    this.busy = (this.busy || Promise.resolve()).then(run, run);
    return this.busy;
  }
}
