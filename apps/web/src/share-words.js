// Sending the handwriting in notes to the training data backend, when the
// writer has turned "Send every word I write in notes" on (it needs the
// consent on /train first).
//
// A note is sent one line of handwriting at a time (`bedrock-training`
// version 3): the line's ink, and where the app cut it into words with each
// word's text. Keeping the line in one piece means a wrong cut ("to gether")
// can be fixed in review, and the reader can learn where words end.
//
// A word's text is `unchecked` (what the recogniser read; training leaves it
// out until the writer or a reviewer checks it) until the writer says the
// reading is right, corrects it, or says it is not a word. A line is sent
// once its readings have settled, and at once when the writer checks a word
// in it. Whenever a line changes (a new reading, a word checked, words added
// or regrouped), it is sent again, and the new sample `supersedes` every
// earlier one that holds any of the same strokes, so the backend keeps only
// the newest. A checked word is never sent unchecked again.
//
// Only words written after the setting was turned on are sent by
// themselves. A word the writer checks while the setting is on is sent
// whenever it was written: checking it is the writer's own act. So is
// importing a PDF: every line of an imported note is sent at once.

import * as collect from './collect.js';

/** An unchecked reading is sent once it has not changed for this long, so
 *  the careful model (which re-reads after a pause) usually gets its say. */
export const SETTLE_MS = 20_000;
/** What was sent, line by line: `[[sample id, { note, strokes, sig, words }]]`. */
const LINES_KEY = 'bedrock.sharedLines.v1';
/** Words sent one at a time by earlier versions: `[["note:word", { id, sig, source }]]`. */
const WORDS_KEY = 'bedrock.sharedWords.v1';
const MAX_LINES = 3000;
/** The backend's limits for one sample; a longer line is sent in pieces. */
const MAX_STROKES = 800;
const MAX_POINTS = 50_000;
const MAX_SUPERSEDES = 50;

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
    this.seen = new Map(); // line signature -> when it was first seen
    this.checks = new Map(); // "note:word" -> { labelSource, reading, engine }: what the writer just did
    this.busy = null;
    this.lines = new Map(); // sample id -> { note, strokes: [stroke id], sig, words: [{ s, kind, label, src }] }
    this.sent = new Map(); // "note:word" -> { id, sig, source }, from earlier versions
    const read = (key, into) => {
      try {
        for (const [k, v] of JSON.parse(storage.getItem(key) || '[]')) into.set(k, v);
      } catch (_) { /* private mode or damaged: start afresh */ }
    };
    read(LINES_KEY, this.lines);
    read(WORDS_KEY, this.sent);
  }

  _save() {
    // Oldest first; keep the newest few thousand.
    while (this.lines.size > MAX_LINES) this.lines.delete(this.lines.keys().next().value);
    try {
      this.storage.setItem(LINES_KEY, JSON.stringify([...this.lines]));
      if (this.sent.size) this.storage.setItem(WORDS_KEY, JSON.stringify([...this.sent]));
      else this.storage.removeItem(WORDS_KEY);
    } catch (_) { /* private mode */ }
  }

  /** Forget what was sent (after "Delete my contributions"). */
  forget() {
    this.lines.clear();
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
   *  for them to settle, and lines whose words are not all read yet (the
   *  app is being hidden or the note closed). `imported`: the open note was
   *  just imported from a PDF; importing is the writer's own act, so every
   *  line is sent now, with the reading the PDF held, whenever it was
   *  written and even with "Send every word" off (saving must be set up
   *  on /train). Returns how many samples were queued. */
  scan({ force = false, imported = false } = {}) {
    if (imported) force = true;
    const run = async () => {
      if (!(imported ? this.ready() : this.enabled())) return 0;
      const note = this.noteId();
      const now = this.now();
      const ink = new Map(); // stroke id -> stroke JSON
      const inkOf = (id) => {
        if (!ink.has(id)) {
          const j = this.canvas.stroke_json(id);
          ink.set(id, j ? JSON.parse(j) : null);
        }
        return ink.get(id);
      };

      // How each word was last sent, by its strokes, from the lines sent
      // earlier from this note.
      const sentWords = new Map();
      for (const rec of this.lines.values()) if (rec.note === note) for (const w of rec.words) sentWords.set(w.s, w);

      // The words of each line that may be sent now.
      const channels = JSON.parse(this.canvas.meta_json()).channels;
      const byLine = new Map();
      for (const word of JSON.parse(this.canvas.words_json())) {
        const key = `${note}:${word.id}`;
        const strokes = (word.strokes || []).map(inkOf).filter(Boolean);
        if (!strokes.length) continue;
        // Written before the setting was on: only sent if the writer checks
        // it now.
        if (!imported && !this.checks.has(key) && Math.min(...strokes.map((s) => s.start)) < this.since()) continue;
        const line = byLine.get(word.line) || { words: [], unread: false };
        byLine.set(word.line, line);
        const want = this.plan(word, key, imported);
        if (!want) {
          line.unread = true; // wait for the recogniser
          continue;
        }
        const s = [...word.strokes].map(String).sort().join(',');
        let plan = want;
        if (!want.checked) {
          // Never send a checked word as unchecked again: keep how it was
          // checked.
          const was = sentWords.get(s) || legacyWord(this.sent.get(key));
          if (was && was.src !== 'unchecked') plan = { ...want, kind: was.kind, label: was.label, labelSource: was.src, reading: null, engine: null, checked: true };
        }
        line.words.push({ key, s, ids: word.strokes.map(String), strokes, ...plan });
      }

      const batch = [];
      const seen = new Map();
      for (const line of byLine.values()) {
        if (!line.words.length || (line.unread && !force)) continue;
        for (const words of pieces(line.words, channels.length)) {
          const sig = words.map((w) => `${w.s}|${w.kind}|${w.labelSource}|${w.label}`).sort().join('\n');
          const ids = new Set(words.flatMap((w) => w.ids));
          const before = [...this.lines].filter(([, r]) => r.note === note && r.strokes.some((id) => ids.has(id)));
          if (before.length === 1 && before[0][1].sig === sig) continue;
          // Due at once when the writer has just checked a word in it;
          // otherwise once its readings have stopped changing.
          const fresh = words.some((w) => w.checked && (this.checks.has(w.key) || sentWords.get(w.s)?.label !== w.label || sentWords.get(w.s)?.src !== w.labelSource));
          const first = this.seen.get(sig) ?? now;
          seen.set(sig, first);
          if (!force && !fresh && now - first < this.settleMs) continue;
          const legacy = words.map((w) => this.sent.get(w.key)?.id).filter(Boolean);
          const sample = collect.fromLine({
            words: words.map((w) => ({ strokes: w.strokes, kind: w.kind, label: w.label, labelSource: w.labelSource, reading: w.reading, engine: w.engine })),
            channels,
            supersedes: [...before.map(([id]) => id), ...legacy].slice(0, MAX_SUPERSEDES),
          });
          batch.push({ sample, before: before.map(([id]) => id), words, sig });
        }
      }
      this.seen = seen;
      if (!batch.length) return 0;
      // One write for all of them: an imported page can hold hundreds.
      await this.enqueue(batch.map((b) => b.sample));
      for (const { sample, before, words, sig } of batch) {
        for (const id of before) this.lines.delete(id);
        this.lines.set(sample.id, {
          note,
          strokes: words.flatMap((w) => w.ids),
          sig,
          words: words.map((w) => ({ s: w.s, kind: w.kind, label: w.label, src: w.labelSource })),
        });
        for (const w of words) {
          this.sent.delete(w.key);
          this.checks.delete(w.key);
        }
      }
      this._save();
      return batch.length;
    };
    // One scan at a time, so a line is never sent twice by two scans.
    this.busy = (this.busy || Promise.resolve()).then(run, run);
    return this.busy;
  }
}

/** A word sent on its own by an earlier version, as `{ kind, label, src }`. */
function legacyWord(rec) {
  if (!rec?.sig) return null;
  const [kind, src, ...label] = rec.sig.split('|');
  return { kind, src, label: label.join('|') };
}

/** A line's words in pieces the backend takes: at most 800 strokes and
 *  50,000 points each, whole words only. Almost every line is one piece. */
function pieces(words, channels) {
  const out = [[]];
  let strokes = 0;
  let points = 0;
  for (const w of words) {
    const p = w.strokes.reduce((n, s) => n + s.points.length, 0) / channels;
    if (out.at(-1).length && (strokes + w.strokes.length > MAX_STROKES || points + p > MAX_POINTS)) {
      out.push([]);
      strokes = 0;
      points = 0;
    }
    out.at(-1).push(w);
    strokes += w.strokes.length;
    points += p;
  }
  return out;
}
