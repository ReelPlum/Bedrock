// Hold a handwritten word to open its menu: make it a link (or open or
// remove one), or correct what the recogniser read. Holding a lasso
// selection opens the same menu for the selected ink, which can also be
// made one word (whatever the automatic word splitting thinks) or deleted;
// linking or correcting a selection makes it one word first.

import { LINK_TYPES, linkType } from './links.js';

/** How much a held stroke grows as it lifts, and how long that takes. */
const LIFT_SCALE = 1.06;
const LIFT_MS = 160;

export class WordMenu {
  /** `describe(word)` says what the recogniser made of a word, e.g.
   *  { text, by: 'careful model' } or { waiting: 'Reading…' }. */
  constructor(el, canvas, stage, { onChange, describe, requestFrame, onFeedback } = {}) {
    this.el = el;
    this.canvas = canvas;
    this.stage = stage;
    this.onChange = onChange || (() => {});
    this.requestFrame = requestFrame || (() => {});
    // Called when the writer confirms or corrects a reading:
    // `{ strokes, kind, label, labelSource, reading, engine }`.
    this.onFeedback = onFeedback || (() => {});
    this.describe = describe || ((w) => (w.text != null ? { text: w.text } : { waiting: 'Not read yet' }));
    this.word = null;
    const $ = (id) => el.querySelector(`#${id}`);
    this.$ = $;
    const types = $('wm-link-type');
    for (const t of LINK_TYPES.filter((t) => t.available)) {
      types.append(Object.assign(document.createElement('option'), { value: t.id, textContent: t.label }));
    }
    types.addEventListener('change', () => {
      this._typeChanged();
      if (linkType(types.value).pick) this._browse();
    });
    // Kinds of link with a picker (notes in the host app) get a Browse button.
    const browse = Object.assign(document.createElement('button'), { type: 'button', id: 'wm-link-browse', textContent: 'Browse…', hidden: true });
    browse.addEventListener('click', () => this._browse());
    $('wm-link-target').after(browse);
    $('wm-close').addEventListener('click', () => this.close());
    $('wm-open').addEventListener('click', () => {
      const l = this.word?.link;
      if (l) linkType(l.type)?.open(l.target);
      this.close();
    });
    // Linking a selection leaves its words as they are.
    $('wm-link').addEventListener('click', () => this._show('link'));
    $('wm-unlink').addEventListener('click', () => {
      if (this.word && this._link('', '')) this.onChange();
      this.close();
    });
    $('wm-copy-here').addEventListener('click', () => {
      const stroke = this._firstStroke();
      if (stroke) linkType('note').copyHere?.(stroke);
      this.close();
    });
    $('wm-correct').addEventListener('click', () => { if (this._ensureWord()) this._show('correct'); });
    // "This is right": the reading becomes the writer's own checked text.
    $('wm-right').addEventListener('click', () => {
      const w = this.word;
      if (w?.id != null && w.text) this._check(w.text);
      this.close();
    });
    // Wrongly taken for maths, or maths taken for text: read it again with
    // the other recogniser.
    $('wm-kind').addEventListener('click', () => this._setKind(this.word?.kind === 'text' ? 'math' : 'text'));
    // A drawing or doodle: never read or spell-checked.
    $('wm-drawing').addEventListener('click', () => this._setKind('drawing'));
    $('wm-group').addEventListener('click', () => {
      this._ensureWord();
      this.close();
    });
    $('wm-ungroup').addEventListener('click', () => {
      if (this.canvas.ungroup_selection()) this.onChange();
      this.close();
    });
    $('wm-delete').addEventListener('click', () => {
      if (this.canvas.delete_selection()) this.onChange();
      this.close();
    });
    for (const b of el.querySelectorAll('.wm-cancel')) b.addEventListener('click', () => this._show('main'));
    $('wm-link-form').addEventListener('submit', (e) => { e.preventDefault(); this._saveLink(); });
    $('wm-correct-form').addEventListener('submit', (e) => { e.preventDefault(); this._saveText(); });
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    // Tapping elsewhere closes it.
    document.addEventListener('pointerdown', (e) => {
      if (!this.el.hidden && !this.el.contains(e.target)) this.close();
    }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.el.hidden) this.close(); });
  }

  get isOpen() { return !this.el.hidden; }

  /** The word under a stage position (CSS px), or null. */
  wordAt(x, y) {
    const [ox, oy, zoom] = this.canvas.camera();
    const wx = x / zoom + ox;
    const wy = y / zoom + oy;
    let best = null;
    let bestD = Infinity;
    for (const w of JSON.parse(this.canvas.words_json())) {
      const pad = w.letterHeight * 0.3;
      const [x0, y0, x1, y1] = w.bounds;
      if (wx < x0 - pad || wx > x1 + pad || wy < y0 - pad || wy > y1 + pad) continue;
      const d = Math.hypot(wx - (x0 + x1) / 2, wy - (y0 + y1) / 2);
      if (d < bestD) { best = w; bestD = d; }
    }
    return best;
  }

  /** Open the menu for the lasso selection, if a stage position is on it.
   *  True if it opened. */
  openSelectionAt(x, y) {
    const sel = JSON.parse(this.canvas.selection_json());
    if (!sel.bounds) return false;
    const [ox, oy, zoom] = this.canvas.camera();
    const wx = x / zoom + ox;
    const wy = y / zoom + oy;
    const pad = 12 / zoom; // as the core's grab area
    const [x0, y0, x1, y1] = sel.bounds;
    if (wx < x0 - pad || wx > x1 + pad || wy < y0 - pad || wy > y1 + pad) return false;
    this.openSelection(sel);
    return true;
  }

  /** Open the menu for a selection (from `canvas.selection_json()`). */
  openSelection(sel) {
    const word = sel.word && this._wordById(sel.word);
    const link = JSON.parse(this.canvas.selection_link_json());
    this.open(word || { id: null, bounds: sel.bounds, kind: 'text', text: null, link }, sel);
  }

  _wordById(id) {
    return JSON.parse(this.canvas.words_json()).find((w) => w.id === id) || null;
  }

  /** Say what the word (or selection, which stays as many words) is. */
  _setKind(kind) {
    if (!this.word) return;
    const ok = this.selection && !this.selection.word
      ? this.canvas.set_selection_kind(kind)
      : this.canvas.set_word_kind(this.word.id, kind);
    if (ok) {
      this.onChange();
      // "Not a word" on one word is the writer's answer about its reading.
      if (kind === 'drawing' && !(this.selection && !this.selection.word) && this.word.id != null) {
        const w = this.word;
        const reading = w.engine === 'user' ? null : w.text ?? null;
        this.onFeedback(this._wordById(w.id) || w, { labelSource: 'corrected', reading, engine: reading ? w.engine || null : null });
      }
    }
    this.close();
  }

  /** A selection that isn't one word yet becomes one. False if it can't. */
  _ensureWord() {
    if (!this.word) return false;
    if (this.selection && (this.word.id == null || !this.selection.grouped)) {
      const id = this.canvas.group_selection();
      const w = id && this._wordById(id);
      if (!w) return false;
      this.word = w;
      this.selection = { ...this.selection, word: id, grouped: true };
      this.onChange();
    }
    return this.word.id != null;
  }

  /** Open the menu for the word at a stage position. True if there was one. */
  openAt(x, y) {
    const w = this.wordAt(x, y);
    if (!w) return false;
    this.open(w);
    return true;
  }

  open(word, selection = null) {
    this.word = word;
    this.selection = selection;
    const $ = this.$;
    const n = selection?.strokes.length || 0;
    const pics = selection?.images?.length || 0;
    const maths = word.kind === 'math';
    const drawing = word.kind === 'drawing';
    const plural = (k, one) => `${k} ${one}${k === 1 ? '' : 's'}`;
    const what = [n && plural(n, 'stroke'), pics && plural(pics, 'picture')].filter(Boolean).join(' and ');
    $('wm-word').textContent = word.id == null ? (pics === 1 && !n ? 'Picture' : `${what} selected`)
      : drawing ? 'Not a word' : maths ? (selection ? 'Selected formula' : 'Formula') : selection ? 'Selected word' : 'Handwritten word';
    const reading = $('wm-reading');
    reading.replaceChildren();
    if (word.id != null) {
      const d = drawing ? { waiting: 'Left as a drawing: never read or spell-checked' } : this.describe(word);
      if (d.text != null) {
        reading.append(maths ? 'Read as LaTeX ' : 'Read as ', Object.assign(document.createElement('b'), { textContent: d.text === '' ? '(nothing)' : `“${d.text}”` }));
        if (d.by) reading.append(` · ${d.by}`);
      } else {
        reading.textContent = d.waiting;
      }
    }
    reading.hidden = word.id == null;
    $('wm-kind').textContent = drawing ? 'It is writing: read it' : maths ? 'Not maths: read it as text' : 'Read it as maths';
    $('wm-drawing').hidden = drawing;
    $('wm-correct').hidden = drawing;
    // Only for something the recogniser read and nobody has checked yet.
    $('wm-right').hidden = drawing || word.id == null || !word.text || word.engine === 'user';
    $('wm-group').hidden = !selection || (selection.word && selection.grouped) || (selection.word && n === 1);
    $('wm-ungroup').hidden = !selection?.grouped;
    $('wm-delete').hidden = !selection;
    // Pictures only: nothing to read or link, just delete (move and resize
    // them with the lasso).
    if (selection && !n) {
      for (const b of ['wm-kind', 'wm-drawing', 'wm-correct', 'wm-right', 'wm-group', 'wm-ungroup', 'wm-link']) $(b).hidden = true;
    } else {
      $('wm-link').hidden = false;
      $('wm-kind').hidden = false;
    }
    const l = word.link;
    const type = l && linkType(l.type);
    $('wm-link-now').hidden = !l;
    $('wm-link-now').textContent = l ? `Links to ${type ? type.describe(l.target) : l.target}` : '';
    $('wm-open').hidden = !l || !type;
    $('wm-unlink').hidden = !l;
    $('wm-link').textContent = l ? 'Change link…' : 'Make a link…';
    // Inside a host (Obsidian), other notes can link to this very word.
    $('wm-copy-here').hidden = !linkType('note').copyHere || !this._firstStroke();
    this._show('main');
    this.el.hidden = false;
    this._place();
    this._lift(selection?.strokes?.length ? selection.strokes : word.strokes || []);
  }

  /**
   * The held strokes lift off the paper while their menu is open: they grow
   * a little around their middle and cast a drop shadow (on the ink layer).
   */
  _lift(ids) {
    cancelAnimationFrame(this._liftFrame);
    const overlay = document.getElementById('overlay');
    const paper = document.getElementById('base');
    if (!ids.length) {
      paper?.classList.remove('behind-lift');
      this.canvas.set_lift([], 1);
      overlay?.classList.remove('lifted');
      this.requestFrame();
      return;
    }
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t0 = performance.now();
    const step = () => {
      const t = still ? 1 : Math.min(1, (performance.now() - t0) / LIFT_MS);
      const ease = 1 - (1 - t) ** 3;
      this.canvas.set_lift(ids, 1 + (LIFT_SCALE - 1) * ease);
      this.requestFrame();
      if (t < 1) this._liftFrame = requestAnimationFrame(step);
    };
    step();
    overlay?.classList.add('lifted');
    paper?.classList.add('behind-lift');
  }

  /** A stroke that stands for what the menu is open on. */
  _firstStroke() {
    return this.word?.strokes?.[0] || this.selection?.strokes?.[0] || null;
  }

  close() {
    if (!this.el.hidden) this._lift([]);
    this.el.hidden = true;
    this.word = null;
    this.selection = null;
    if (document.activeElement && this.el.contains(document.activeElement)) document.activeElement.blur();
  }

  _show(view) {
    const $ = this.$;
    $('wm-main').hidden = view !== 'main';
    $('wm-link-form').hidden = view !== 'link';
    $('wm-correct-form').hidden = view !== 'correct';
    if (view === 'link') {
      const l = this.word.link;
      const types = $('wm-link-type');
      const preferred = LINK_TYPES.find((t) => t.available && t.preferred);
      if (l && [...types.options].some((o) => o.value === l.type)) types.value = l.type;
      else if (!l && preferred) types.value = preferred.id;
      $('wm-link-target').value = l ? l.target : '';
      $('wm-link-error').hidden = true;
      this._typeChanged();
      $('wm-link-target').focus();
      // A new link to a host note starts in the host's picker.
      if (!l && linkType(types.value).pick) this._browse();
    } else if (view === 'correct') {
      $('wm-correct-text').value = this.word.text ?? '';
      $('wm-correct-text').focus();
    }
    if (!this.el.hidden) this._place();
  }

  /** Link (or unlink, with '') the word, or the whole selection. */
  _link(target, type) {
    if (this.selection && !this.selection.word) return this.canvas.set_selection_link(target, type);
    return this.canvas.set_word_link(this.word.id, target, type);
  }

  _typeChanged() {
    const t = linkType(this.$('wm-link-type').value);
    const input = this.$('wm-link-target');
    input.placeholder = t.placeholder;
    input.type = t.inputType;
    this.$('wm-link-browse').hidden = !t.pick;
  }

  /** Choose the target with the link kind's picker; links straight away. */
  async _browse() {
    const t = linkType(this.$('wm-link-type').value);
    const word = this.word;
    if (!t.pick || !word) return;
    let target = null;
    try { target = await t.pick(this.$('wm-link-target').value); } catch (e) { console.warn('picker failed', e); }
    // Ignore a pick that arrives after the menu moved on to something else.
    if (!target || this.word !== word || this.$('wm-link-type').value !== t.id) return;
    this.$('wm-link-target').value = target;
    this._saveLink();
  }

  _saveLink() {
    const t = linkType(this.$('wm-link-type').value);
    const target = t.normalize(this.$('wm-link-target').value);
    if (!target) {
      const err = this.$('wm-link-error');
      err.textContent = t.id === 'url' ? 'That doesn’t look like a web address.' : 'Enter a name.';
      err.hidden = false;
      return;
    }
    if (this._link(target, t.id)) this.onChange();
    this.close();
  }

  _saveText() {
    this._check(this.$('wm-correct-text').value);
    this.close();
  }

  /** Store `text` as what the word says, checked by the writer, and report
   *  it as feedback on the recogniser's reading (if it had one). */
  _check(text) {
    const w = this.word;
    const reading = w.engine === 'user' ? null : w.text;
    if (!this.canvas.correct_word(w.id, text, w.kind)) return;
    this.onChange();
    const label = text.trim();
    if (!label || w.kind === 'drawing') return;
    this.onFeedback(this._wordById(w.id) || w, {
      labelSource: reading != null && reading.trim() === label ? 'confirmed' : 'corrected',
      reading: reading || null,
      engine: reading ? w.engine || null : null,
    });
  }

  /** Below the word if it fits, otherwise above; always on screen. */
  _place() {
    const w = this.word;
    if (!w) return;
    const [ox, oy, zoom] = this.canvas.camera();
    const r = this.stage.getBoundingClientRect();
    const left = r.left + (w.bounds[0] - ox) * zoom;
    const top = r.top + (w.bounds[1] - oy) * zoom;
    const bottom = r.top + (w.bounds[3] - oy) * zoom;
    const mw = this.el.offsetWidth;
    const mh = this.el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = Math.max(12, Math.min(left, vw - mw - 12));
    const y = bottom + 10 + mh < vh - 12 ? bottom + 10 : Math.max(12, top - 10 - mh);
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}
