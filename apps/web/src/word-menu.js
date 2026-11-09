// Hold a handwritten word to open its menu: make it a link (or open or
// remove one), or correct what the recogniser read.

import { LINK_TYPES, linkType } from './links.js';

export class WordMenu {
  constructor(el, canvas, stage, { onChange } = {}) {
    this.el = el;
    this.canvas = canvas;
    this.stage = stage;
    this.onChange = onChange || (() => {});
    this.word = null;
    const $ = (id) => el.querySelector(`#${id}`);
    this.$ = $;
    const types = $('wm-link-type');
    for (const t of LINK_TYPES.filter((t) => t.available)) {
      types.append(Object.assign(document.createElement('option'), { value: t.id, textContent: t.label }));
    }
    types.addEventListener('change', () => this._typeChanged());
    $('wm-close').addEventListener('click', () => this.close());
    $('wm-open').addEventListener('click', () => {
      const l = this.word?.link;
      if (l) linkType(l.type)?.open(l.target);
      this.close();
    });
    $('wm-link').addEventListener('click', () => this._show('link'));
    $('wm-unlink').addEventListener('click', () => {
      if (this.word && this.canvas.set_word_link(this.word.id, '', '')) this.onChange();
      this.close();
    });
    $('wm-correct').addEventListener('click', () => this._show('correct'));
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

  /** Open the menu for the word at a stage position. True if there was one. */
  openAt(x, y) {
    const w = this.wordAt(x, y);
    if (!w) return false;
    this.open(w);
    return true;
  }

  open(word) {
    this.word = word;
    const $ = this.$;
    $('wm-word').textContent = word.text ? `“${word.text}”` : 'Handwritten word';
    const l = word.link;
    const type = l && linkType(l.type);
    $('wm-link-now').hidden = !l;
    $('wm-link-now').textContent = l ? `Links to ${type ? type.describe(l.target) : l.target}` : '';
    $('wm-open').hidden = !l || !type;
    $('wm-unlink').hidden = !l;
    $('wm-link').textContent = l ? 'Change link…' : 'Make a link…';
    this._show('main');
    this.el.hidden = false;
    this._place();
  }

  close() {
    this.el.hidden = true;
    this.word = null;
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
      if (l && [...types.options].some((o) => o.value === l.type)) types.value = l.type;
      $('wm-link-target').value = l ? l.target : '';
      $('wm-link-error').hidden = true;
      this._typeChanged();
      $('wm-link-target').focus();
    } else if (view === 'correct') {
      $('wm-correct-text').value = this.word.text ?? '';
      $('wm-correct-text').focus();
    }
    if (!this.el.hidden) this._place();
  }

  _typeChanged() {
    const t = linkType(this.$('wm-link-type').value);
    const input = this.$('wm-link-target');
    input.placeholder = t.placeholder;
    input.type = t.inputType;
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
    if (this.canvas.set_word_link(this.word.id, target, t.id)) this.onChange();
    this.close();
  }

  _saveText() {
    const text = this.$('wm-correct-text').value;
    if (this.canvas.correct_word(this.word.id, text, this.word.kind)) this.onChange();
    this.close();
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
