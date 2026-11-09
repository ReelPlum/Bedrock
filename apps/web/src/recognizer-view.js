// "What the recogniser sees": a panel listing every word on the page as the
// exact image sent to the recogniser, with what it read (or why not).
// Each reading can be corrected (type or Scribble the real text, pick a
// spelling suggestion, or tick it as right): that becomes the word's text,
// with what the recogniser read kept beside it, so notes slowly collect
// real handwriting with checked labels. Turned on from the menu.

export class RecognizerView {
  constructor(el, handwriting, { onChange } = {}) {
    this.el = el;
    this.hw = handwriting;
    this.onChange = onChange || (() => {});
    this.list = el.querySelector('.rv-list');
    this.images = new Map(); // word id -> object URL of its image
    this.timer = null;
  }

  get visible() { return !this.el.hidden; }
  set visible(v) {
    this.el.hidden = !v;
    if (v) this.refresh(); else this._clear();
  }

  /** Call when words or their text may have changed. */
  update() {
    if (!this.visible) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 150);
  }

  async refresh() {
    // Don't rebuild under someone typing a correction; try again shortly.
    if (this.el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refresh(), 500);
      return;
    }
    const words = JSON.parse(this.hw.canvas.words_json());
    // The core lists words in reading order: line by line, left to right.
    const keep = new Set(words.map((w) => w.id));
    for (const [id, url] of this.images) if (!keep.has(id)) { URL.revokeObjectURL(url); this.images.delete(id); }
    const bad = new Set();
    if (this.hw.spelling && this.hw.dictionaryReady) {
      const b = this.hw.canvas.misspelled();
      for (let i = 0; i < b.length; i += 4) bad.add(b.slice(i, i + 4).join(','));
    }
    const rows = [];
    for (const w of words) {
      if (!this.images.has(w.id)) {
        const blob = await this.hw.render(w);
        if (!blob) continue;
        this.images.set(w.id, URL.createObjectURL(blob));
      }
      rows.push(this._row(w, bad.has(w.bounds.join(','))));
    }
    this.list.replaceChildren(...rows);
    this.el.querySelector('.rv-count').textContent = `${rows.length} word${rows.length === 1 ? '' : 's'}`;
  }

  _row(w, misspelled) {
    const li = document.createElement('li');
    li.dataset.word = w.id;
    const img = document.createElement('img');
    img.src = this.images.get(w.id);
    img.alt = '';
    const meta = document.createElement('div');
    meta.className = 'rv-meta';
    const kind = document.createElement('span');
    kind.className = 'rv-kind';
    const yours = w.engine === 'user';
    kind.textContent = w.kind === 'drawing' ? 'Not a word' : w.kind === 'math' ? 'Maths'
      : yours ? 'Yours'
        : w.text == null ? 'Text'
          : this.hw.isCareful(w) ? 'Careful' : 'Live';
    // The reading, editable: type (or Scribble) what it actually says.
    const input = document.createElement('input');
    input.className = 'rv-text';
    input.type = 'text';
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'What this word says');
    input.value = w.text ?? '';
    const status = this.hw.status.get(w.id);
    input.placeholder = w.text == null ? (status || (this.hw.enabled ? 'Waiting… or type it' : 'Type what this says')) : '(nothing read)';
    if (w.text == null) li.classList.add('pending');
    if (yours) li.classList.add('yours');
    if (misspelled) li.classList.add('misspelled');
    const save = (text) => {
      if (this.hw.canvas.correct_word(w.id, text, w.kind)) {
        this.onChange();
        this.refresh();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = w.text ?? ''; input.blur(); }
    });
    input.addEventListener('change', () => save(input.value));
    const ok = document.createElement('button');
    ok.className = 'rv-ok';
    ok.type = 'button';
    ok.textContent = '✓';
    ok.title = yours ? 'Confirmed' : 'This reading is right';
    ok.setAttribute('aria-label', ok.title);
    ok.disabled = yours || w.text == null;
    ok.addEventListener('click', () => save(input.value));
    meta.append(kind, input, ok);
    li.append(img, meta);
    if (yours && w.alternatives?.length) {
      const was = document.createElement('div');
      was.className = 'rv-was';
      was.textContent = `Read as: ${w.alternatives[0]}`;
      li.append(was);
    } else if (misspelled) {
      const chips = document.createElement('div');
      chips.className = 'rv-chips';
      for (const s of this.hw.canvas.suggestions(w.id).slice(0, 3)) {
        const c = document.createElement('button');
        c.type = 'button';
        c.textContent = s;
        c.addEventListener('click', () => save(s));
        chips.append(c);
      }
      if (chips.childElementCount) li.append(chips);
    }
    return li;
  }

  _clear() {
    for (const url of this.images.values()) URL.revokeObjectURL(url);
    this.images.clear();
    this.list.replaceChildren();
  }
}
