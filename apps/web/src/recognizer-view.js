// "What the recogniser sees": a panel listing every word on the page as the
// exact image sent to the recogniser, with what it read (or why not).
// For checking recognition on a real device; turned on from the menu.

export class RecognizerView {
  constructor(el, handwriting) {
    this.el = el;
    this.hw = handwriting;
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
    const words = JSON.parse(this.hw.canvas.words_json());
    // The core lists words in reading order: line by line, left to right.
    const keep = new Set(words.map((w) => w.id));
    for (const [id, url] of this.images) if (!keep.has(id)) { URL.revokeObjectURL(url); this.images.delete(id); }
    const rows = [];
    for (const w of words) {
      if (!this.images.has(w.id)) {
        const blob = await this.hw.render(w);
        if (!blob) continue;
        this.images.set(w.id, URL.createObjectURL(blob));
      }
      const li = document.createElement('li');
      li.dataset.word = w.id;
      const img = document.createElement('img');
      img.src = this.images.get(w.id);
      img.alt = '';
      const meta = document.createElement('div');
      meta.className = 'rv-meta';
      const kind = document.createElement('span');
      kind.className = 'rv-kind';
      kind.textContent = w.kind === 'math' ? 'Maths' : w.text == null ? 'Text' : this.hw.isCareful(w) ? 'Text · careful' : 'Text · live';
      const text = document.createElement('span');
      text.className = 'rv-text';
      const status = this.hw.status.get(w.id);
      if (w.text != null) {
        text.textContent = w.text || '(nothing read)';
      } else if (status) {
        text.textContent = status;
        li.classList.add('pending');
      } else {
        text.textContent = this.hw.enabled ? 'Waiting…' : 'Recognition is off';
        li.classList.add('pending');
      }
      meta.append(kind, text);
      li.append(img, meta);
      rows.push(li);
    }
    this.list.replaceChildren(...rows);
    this.el.querySelector('.rv-count').textContent = `${rows.length} word${rows.length === 1 ? '' : 's'}`;
  }

  _clear() {
    for (const url of this.images.values()) URL.revokeObjectURL(url);
    this.images.clear();
    this.list.replaceChildren();
  }
}
