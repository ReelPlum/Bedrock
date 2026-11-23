// The picker for a link to something in the host's vault (Obsidian), drawn
// by the canvas itself over the canvas: the vault's folders and files as a
// tree, with a filter. A file is linked by tapping it. A PDF opens as its
// pages (drawn by the host) and a page can be linked (`File.pdf#page=3`); a
// Bedrock note opens as its picture with its words marked, and a word can be
// linked (`Note.bedrock#^<stroke id>`, the link to a word). Either can be
// linked whole instead.
//
// It used to be Obsidian's own search popup, in Obsidian's window outside
// the canvas's frame: on the iPad a note picked there did not reach the link
// box, and it had no folders, pages or places.
//
// The host answers `list-files` ([{ path, link }]), `read-note { path }`
// ({ data }) and `pdf-page { path, page, width }` ({ count, png }).

import { readZip, text } from './zip-read.js';

const kindOf = (path) => {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'pdf' ? 'pdf' : ext === 'bedrock' ? 'bedrock' : ext === 'md' ? 'md' : 'other';
};
const nameOf = (path) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
};

/** Folders and files from a flat list of paths. */
export function fileTree(files) {
  const root = { name: '', path: '', folders: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      const path = dir.path ? `${dir.path}/${part}` : part;
      if (!dir.folders.has(part)) dir.folders.set(part, { name: part, path, folders: new Map(), files: [] });
      dir = dir.folders.get(part);
    }
    dir.files.push(f);
  }
  return root;
}

/** Where the words of a Bedrock note are, from its file: the picture
 *  (preview.svg), its viewBox, and each recognised word's bounds and first
 *  stroke, in the picture's coordinates. */
export async function notePicture(bytes) {
  const z = await readZip(bytes, ['preview.svg', 'note.json', 'recognized.json']);
  const svg = text(z.get('preview.svg'));
  const vb = /viewBox="([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+)"/.exec(svg);
  if (!svg || !vb) return null;
  const [x, y, w, h] = vb.slice(1).map(Number);
  let note = {};
  let rec = {};
  try { note = JSON.parse(text(z.get('note.json')) || '{}'); } catch { /* no words */ }
  try { rec = JSON.parse(text(z.get('recognized.json')) || '{}'); } catch { /* no words */ }
  const channels = Array.isArray(note.channels) ? note.channels : ['x', 'y'];
  const stride = channels.length || 2;
  const cx = Math.max(0, channels.indexOf('x'));
  const cy = Math.max(0, channels.indexOf('y'));
  const box = new Map();
  for (const s of note.strokes || []) {
    const p = s.points || [];
    let b = null;
    for (let i = 0; i + stride <= p.length; i += stride) {
      const px = p[i + cx];
      const py = p[i + cy];
      b = b ? [Math.min(b[0], px), Math.min(b[1], py), Math.max(b[2], px), Math.max(b[3], py)] : [px, py, px, py];
    }
    if (b) box.set(s.id, b);
  }
  const words = [];
  for (const item of Array.isArray(rec.items) ? rec.items : []) {
    const ids = (item.strokes || []).filter((id) => box.has(id));
    if (!ids.length) continue;
    const bs = ids.map((id) => box.get(id));
    words.push({
      text: item.text || '',
      stroke: ids[0],
      bounds: [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))],
    });
  }
  return { svg, viewBox: [x, y, w, h], words };
}

export class LinkPicker {
  /** `rpc.call(method, args)` reaches the host. */
  constructor(rpc) {
    this.rpc = rpc;
    this.el = el('div', { id: 'link-picker', className: 'link-picker', hidden: true });
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Choose what to link to');
    this.back = el('button', { type: 'button', className: 'lp-back', textContent: '‹ Back', hidden: true });
    this.title = el('div', { className: 'lp-title', textContent: 'Link to' });
    const close = el('button', { type: 'button', className: 'lp-close', textContent: 'Cancel' });
    this.filter = el('input', { className: 'lp-filter', type: 'search', placeholder: 'Filter by name', autocomplete: 'off', spellcheck: false });
    this.filter.setAttribute('aria-label', 'Filter files by name');
    this.filter.autocapitalize = 'off';
    this.body = el('div', { className: 'lp-body' });
    this.el.append(el('div', { className: 'lp-head' }, this.back, this.title, close), this.filter, this.body);
    // Taps here are not ink, and do not close the word menu.
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    close.addEventListener('click', () => this._finish(null));
    this.back.addEventListener('click', () => this._showTree());
    this.filter.addEventListener('input', () => this._renderTree());
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this._finish(null); }
    });
    this.open = new Set();
    this.urls = [];
  }

  get isOpen() { return !this.el.hidden; }

  /** Show the picker; resolves to link text, or null if it was closed. */
  async pick() {
    if (!this.el.isConnected) document.body.append(this.el);
    this._finish(null);
    const done = new Promise((resolve) => { this.resolve = resolve; });
    this.el.hidden = false;
    this.filter.value = '';
    this.body.replaceChildren(el('p', { className: 'lp-note', textContent: 'Loading the vault…' }));
    this._showTree(true);
    try {
      this.files = (await this.rpc.call('list-files')) || [];
    } catch (e) {
      this.files = [];
      this.body.replaceChildren(el('p', { className: 'lp-note', textContent: `The vault could not be listed (${e.message}).` }));
      return done;
    }
    this.tree = fileTree(this.files);
    this._renderTree();
    return done;
  }

  _finish(value) {
    const r = this.resolve;
    this.resolve = null;
    this.el.hidden = true;
    this._dropUrls();
    this.observer?.disconnect();
    r?.(value);
  }

  _dropUrls() {
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
  }

  _showTree(empty = false) {
    this._dropUrls();
    this.observer?.disconnect();
    this.back.hidden = true;
    this.filter.hidden = false;
    this.title.textContent = 'Link to';
    if (!empty && this.tree) this._renderTree();
  }

  _renderTree() {
    if (!this.tree) return;
    const q = this.filter.value.trim().toLowerCase();
    const list = el('ul', { className: 'lp-tree' });
    if (q) {
      // A filter lists every matching file with its folder.
      const hits = this.files.filter((f) => f.path.toLowerCase().includes(q)).sort((a, b) => a.path.localeCompare(b.path));
      for (const f of hits) list.append(this._fileRow(f, f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''));
      if (!hits.length) list.append(el('li', { className: 'lp-note', textContent: 'No file has that in its name.' }));
    } else {
      this._addFolder(list, this.tree, 0);
      if (!this.files.length) list.append(el('li', { className: 'lp-note', textContent: 'There are no other files in the vault yet.' }));
    }
    this.body.replaceChildren(list);
  }

  _addFolder(list, dir, depth) {
    const folders = [...dir.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const f of folders) {
      const open = this.open.has(f.path);
      const row = el('button', { type: 'button', className: 'lp-folder', textContent: f.name });
      row.dataset.path = f.path;
      row.style.paddingLeft = `${12 + depth * 18}px`;
      row.setAttribute('aria-expanded', String(open));
      row.addEventListener('click', () => {
        if (this.open.has(f.path)) this.open.delete(f.path); else this.open.add(f.path);
        this._renderTree();
      });
      list.append(el('li', {}, row));
      if (open) this._addFolder(list, f, depth + 1);
    }
    const files = [...dir.files].sort((a, b) => nameOf(a.path).localeCompare(nameOf(b.path)));
    for (const f of files) list.append(this._fileRow(f, '', depth));
  }

  _fileRow(f, folder, depth = 0) {
    const kind = kindOf(f.path);
    const row = el('button', { type: 'button', className: `lp-file lp-${kind}` },
      el('span', { className: 'lp-name', textContent: nameOf(f.path) }));
    if (folder) row.append(el('span', { className: 'lp-folder-of', textContent: folder }));
    if (kind === 'pdf' || kind === 'bedrock') row.append(el('span', { className: 'lp-more', textContent: '›' }));
    row.dataset.path = f.path;
    row.style.paddingLeft = `${12 + depth * 18}px`;
    row.addEventListener('click', () => {
      if (kind === 'pdf') this._showPdf(f);
      else if (kind === 'bedrock') this._showNote(f);
      else this._finish(f.link);
    });
    return el('li', {}, row);
  }

  /** A view of one file: "Link the whole file" and what is inside. */
  _openFile(f, wholeLabel) {
    this._dropUrls();
    this.observer?.disconnect();
    this.back.hidden = false;
    this.filter.hidden = true;
    this.title.textContent = nameOf(f.path);
    const whole = el('button', { type: 'button', className: 'lp-whole', textContent: wholeLabel });
    whole.addEventListener('click', () => this._finish(f.link));
    const inside = el('div', { className: 'lp-inside' }, el('p', { className: 'lp-note', textContent: 'Opening…' }));
    this.body.replaceChildren(whole, inside);
    this.body.scrollTop = 0;
    return inside;
  }

  async _showPdf(f) {
    const inside = this._openFile(f, 'Link the whole file');
    const width = Math.round(Math.min(480, this.body.clientWidth || 320) * Math.min(window.devicePixelRatio || 1, 2));
    const page = async (n) => {
      const r = await this.rpc.call('pdf-page', { path: f.path, page: n, width });
      const url = URL.createObjectURL(new Blob([r.png], { type: 'image/png' }));
      this.urls.push(url);
      return { count: r.count, url };
    };
    let first;
    try { first = await page(1); } catch (e) {
      inside.replaceChildren(el('p', { className: 'lp-note', textContent: `This PDF could not be opened (${e.message}).` }));
      return;
    }
    if (this.title.textContent !== nameOf(f.path)) return; // moved on
    const grid = el('div', { className: 'lp-pages' });
    inside.replaceChildren(el('p', { className: 'lp-note', textContent: 'Tap a page to link to it.' }), grid);
    // Pages are drawn as they scroll into sight.
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting || e.target.dataset.loaded) continue;
        e.target.dataset.loaded = 'true';
        this.observer.unobserve(e.target);
        page(Number(e.target.dataset.page)).then((p) => { e.target.querySelector('img').src = p.url; }).catch(() => {});
      }
    }, { root: this.body, rootMargin: '400px' });
    for (let n = 1; n <= first.count; n++) {
      const img = el('img', { alt: '' });
      const b = el('button', { type: 'button', className: 'lp-page' }, img, el('span', { textContent: `Page ${n}` }));
      b.setAttribute('aria-label', `Link to page ${n}`);
      b.dataset.page = String(n);
      b.addEventListener('click', () => this._finish(`${f.link}#page=${n}`));
      grid.append(b);
      if (n === 1) { img.src = first.url; b.dataset.loaded = 'true'; } else this.observer.observe(b);
    }
  }

  async _showNote(f) {
    const inside = this._openFile(f, 'Link the whole note');
    let pic = null;
    try {
      const r = await this.rpc.call('read-note', { path: f.path });
      pic = r?.data ? await notePicture(r.data) : null;
    } catch (e) {
      inside.replaceChildren(el('p', { className: 'lp-note', textContent: `This note could not be opened (${e.message}).` }));
      return;
    }
    if (this.title.textContent !== nameOf(f.path)) return; // moved on
    if (!pic) {
      inside.replaceChildren(el('p', { className: 'lp-note', textContent: 'This note is empty.' }));
      return;
    }
    const url = URL.createObjectURL(new Blob([pic.svg], { type: 'image/svg+xml' }));
    this.urls.push(url);
    const [vx, vy, vw, vh] = pic.viewBox;
    // The picture at the picker's width (never larger than the ink was
    // written), with a tappable mark over each word.
    const scale = Math.min(1, (this.body.clientWidth || 320) / vw);
    const paper = el('div', { className: 'lp-paper' }, el('img', { src: url, alt: '' }));
    paper.style.width = `${vw * scale}px`;
    paper.style.height = `${vh * scale}px`;
    for (const w of pic.words) {
      const [x0, y0, x1, y1] = w.bounds;
      const pad = 4;
      const mark = el('button', { type: 'button', className: 'lp-word', title: w.text });
      mark.setAttribute('aria-label', `Link to “${w.text}”`);
      mark.dataset.stroke = w.stroke;
      Object.assign(mark.style, {
        left: `${(x0 - vx) * scale - pad}px`,
        top: `${(y0 - vy) * scale - pad}px`,
        width: `${(x1 - x0) * scale + 2 * pad}px`,
        height: `${(y1 - y0) * scale + 2 * pad}px`,
      });
      mark.addEventListener('click', () => this._finish(`${f.link}#^${w.stroke}`));
      paper.append(mark);
    }
    inside.replaceChildren(
      el('p', { className: 'lp-note', textContent: pic.words.length ? 'Tap a word to link to it.' : 'No words have been read in this note yet: link the whole note.' }),
      paper,
    );
  }
}
