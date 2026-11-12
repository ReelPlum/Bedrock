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
// whenever it was written: checking it is the writer's own act.

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
   */
  constructor({ canvas, noteId, enabled, since, reading, enqueue = collect.enqueue, now = Date.now, storage = globalThis.localStorage }) {
    Object.assign(this, { canvas, noteId, enabled, since, reading, enqueue, now, storage });
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

  /** What `word` should be sent as now, or null. */
  plan(word, key) {
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
    return this.reading() ? null : { kind, label: '', labelSource: 'unchecked', reading: null, engine: null, checked: false };
  }

  /** Sends what is due. `force` sends unchecked readings without waiting
   *  for them to settle (the app is being hidden or the note closed).
   *  Returns how many samples were queued. */
  scan({ force = false } = {}) {
    const run = async () => {
      if (!this.enabled()) return 0;
      const note = this.noteId();
      const now = this.now();
      let n = 0;
      let channels = null;
      for (const word of JSON.parse(this.canvas.words_json())) {
        const key = `${note}:${word.id}`;
        const want = this.plan(word, key);
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
        if (!this.checks.has(key) && Math.min(...ink.map((s) => s.start)) < this.since()) continue;
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
        await this.enqueue(sample);
        this.sent.delete(key); // re-insert so it counts as newest
        this.sent.set(key, { id: sample.id, sig, source: want.labelSource });
        this.checks.delete(key);
        n++;
      }
      if (n) this._save();
      return n;
    };
    // One scan at a time, so a word is never sent twice by two scans.
    this.busy = (this.busy || Promise.resolve()).then(run, run);
    return this.busy;
  }
}
