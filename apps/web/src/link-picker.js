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
// An open PDF can be searched (the plugin finds the text the way the search
// bar of Obsidian's PDF viewer does, with its find controller) and zoomed
// (4, 3, 2 or 1 pages across).
//
// The host answers `list-files` ([{ path, link }]), `read-note { path }`
// ({ data }), `pdf-page { path, page, width }` ({ count, png }) and
// `pdf-find { path, query }` ({ count, total, hits: [{ page, before, match,
// after, selection }] }).

import { readZip, text } from './zip-read.js';

/** The most pages side by side when a PDF is zoomed out. */
const MAX_ACROSS = 4;
/** How many page pictures are asked of the host at once. */
const DRAWING_AT_ONCE = 2;
/** How wide (CSS px) a page's picture is beside its matches. */
const THUMB_CSS = 96;
/** How long scrolling must slow down before the pages in sight are drawn. */
const SETTLE_MS = 200;
/** How far (CSS px) beyond the view a page counts as in sight. */
const SIGHT_MARGIN = 150;

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

/** The strokes' samples in a `points.bin` entry (docs/note-format.md):
 *  one flat array of values per stroke, channel by channel, as `points` in
 *  note.json holds them. Throws on a damaged entry. */
export function readPointsBin(bytes) {
  if (!bytes) return [];
  let at = 0;
  const byte = () => {
    if (at >= bytes.length) throw new Error('points.bin ends early');
    return bytes[at++];
  };
  const unsigned = () => {
    let v = 0;
    for (let shift = 0; ; shift += 7) {
      const b = byte();
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return v;
    }
  };
  const signed = () => {
    let v = 0;
    let shift = 0;
    let b;
    do { b = byte(); v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    return b & 0x40 ? v - 2 ** shift : v;
  };
  if (String.fromCharCode(byte(), byte(), byte(), byte()) !== 'BDPT') throw new Error('not points.bin');
  if (unsigned() !== 1) throw new Error('unknown points.bin version');
  const scales = [];
  for (let c = unsigned(); c > 0; c--) {
    const name = unsigned();
    at += name; // the channel's name: the same channels as note.json
    scales.push(10 ** unsigned());
  }
  const strokes = [];
  for (let n = unsigned(); n > 0; n--) {
    const count = unsigned();
    const last = scales.map(() => 0);
    const out = [];
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < scales.length; c++) {
        last[c] += signed();
        out.push(last[c] / scales[c]);
      }
    }
    strokes.push(out);
  }
  return strokes;
}

/** Where the words of a Bedrock note are, from its file: the picture
 *  (preview.svg), its viewBox, and each recognised word's bounds and first
 *  stroke, in the picture's coordinates. */
export async function notePicture(bytes) {
  const z = await readZip(bytes, ['preview.svg', 'note.json', 'recognized.json', 'points.bin']);
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
  // Since version 2 the samples of most strokes are in points.bin, one
  // record per stroke without `points`, in order (docs/note-format.md).
  let records = [];
  if (note.pointsFile) {
    try { records = readPointsBin(z.get(note.pointsFile)); } catch { records = []; }
  }
  let next = 0;
  const box = new Map();
  for (const s of note.strokes || []) {
    const p = Array.isArray(s.points) ? s.points : records[next++] || [];
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
    // Pages across when a PDF is open (zoom), kept while the canvas is.
    this.across = 3;
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
    this.body.onscroll = null;
    this._dropUrls();
    this.observer?.disconnect();
    r?.(value);
  }

  _dropUrls() {
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
  }

  _showTree(empty = false) {
    this.el.classList.remove('lp-wide');
    this.body.onscroll = null;
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
    this.el.classList.remove('lp-wide');
    this.body.onscroll = null;
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
    this.el.classList.add('lp-wide');
    const name = nameOf(f.path);
    const moved = () => this.title.textContent !== name;
    // Pictures of pages already drawn, by page and width.
    const drawn = new Map();
    const page = async (n, width) => {
      const key = `${n}@${width}`;
      if (!drawn.has(key)) {
        drawn.set(key, this.rpc.call('pdf-page', { path: f.path, page: n, width }).then((r) => {
          const url = URL.createObjectURL(new Blob([r.png], { type: 'image/png' }));
          this.urls.push(url);
          return { count: r.count, url };
        }));
        drawn.get(key).catch(() => drawn.delete(key));
      }
      return drawn.get(key);
    };
    let first;
    try { first = await page(1, this._pageWidth()); } catch (e) {
      inside.replaceChildren(el('p', { className: 'lp-note', textContent: `This PDF could not be opened (${e.message}).` }));
      return;
    }
    if (moved()) return;

    // Search and zoom, above the pages.
    const find = el('input', { className: 'lp-find', type: 'search', placeholder: 'Search in this PDF', autocomplete: 'off', spellcheck: false });
    find.setAttribute('aria-label', 'Search the text of this PDF');
    find.autocapitalize = 'off';
    const zoomOut = el('button', { type: 'button', className: 'lp-zoom-out', textContent: '−' });
    zoomOut.setAttribute('aria-label', 'More pages across');
    const zoomIn = el('button', { type: 'button', className: 'lp-zoom-in', textContent: '+' });
    zoomIn.setAttribute('aria-label', 'Fewer, bigger pages');
    const across = el('span', { className: 'lp-across' });
    const bar = el('div', { className: 'lp-pdf-bar' }, find, el('div', { className: 'lp-zoom' }, zoomOut, across, zoomIn));
    const note = el('p', { className: 'lp-note', textContent: 'Tap a page to link to it.' });
    const grid = el('div', { className: 'lp-pages' });
    const results = el('ul', { className: 'lp-hits', hidden: true });
    inside.replaceChildren(bar, note, results, grid);

    // Only the pages in sight are drawn, two at a time, the top one first.
    // A page that scrolls out of sight before its turn is skipped, so fast
    // scrolling does not queue every page passed on the way.
    const thumbWidth = () => Math.round(THUMB_CSS * Math.min(window.devicePixelRatio || 1, 2) / 50) * 50;
    const wantOf = (b) => (b.classList.contains('lp-hit-thumb') ? thumbWidth() : this._pageWidth());
    const inSight = new Set();
    let drawing = 0;
    // While the pages fly by (faster than a screen and a half a second),
    // nothing new is asked for; once the scrolling slows, the pages then in
    // sight are drawn. The speed is taken over the last 150 ms, not between
    // two frames, so a slow device (long frames, big jumps) measures it right;
    // and "slowed" waits at least one and a half frames.
    let recent = [];
    let flying = false;
    let settle = null;
    // Where the scrolling was last seen. The page can move before its scroll
    // event comes (on a busy device the observer may report first): until
    // the event is seen, nothing is drawn.
    let seenTop = this.body.scrollTop;
    // The scrolling has stopped (or slowed): draw what is in sight.
    const rest = () => {
      flying = false;
      seenTop = this.body.scrollTop;
      recent = [];
      // What is in sight now, from where the pages are: not left to the
      // observer's last report, which may still be on its way.
      const view = this.body.getBoundingClientRect();
      for (const b of this.body.querySelectorAll('.lp-lazy')) {
        const r = b.getBoundingClientRect();
        if (r.bottom > view.top - SIGHT_MARGIN && r.top < view.bottom + SIGHT_MARGIN && r.height > 0) inSight.add(b);
        else inSight.delete(b);
      }
      pump();
    };
    this.body.onscroll = () => {
      const now = performance.now();
      seenTop = this.body.scrollTop;
      const gap = recent.length ? now - recent[recent.length - 1].at : 0;
      recent.push({ at: now, top: this.body.scrollTop });
      while (recent.length > 2 && now - recent[1].at > 150) recent.shift();
      const first = recent[0];
      const speed = recent.length > 1 ? Math.abs(this.body.scrollTop - first.top) / Math.max(1, now - first.at) : 0;
      // The first move after a rest has no speed yet: it waits like a fling
      // until the next one, or until the scrolling stops.
      flying = recent.length < 2 || speed > (this.body.clientHeight * 1.5) / 1000;
      clearTimeout(settle);
      settle = setTimeout(rest, Math.min(600, Math.max(SETTLE_MS, gap * 1.5)));
    };
    const pump = () => {
      if (this.body.scrollTop !== seenTop && !flying) {
        // Moved, and its scroll event not seen yet: wait for it, or rest.
        clearTimeout(settle);
        settle = setTimeout(rest, SETTLE_MS);
        return;
      }
      while (drawing < DRAWING_AT_ONCE && !flying) {
        let next = null;
        let nextTop = Infinity;
        const view = this.body.getBoundingClientRect();
        for (const b of inSight) {
          if (!b.isConnected || b.offsetParent === null) { inSight.delete(b); continue; }
          if (b.dataset.drawing || Number(b.dataset.failed || 0) >= 2 || Number(b.dataset.width || 0) >= wantOf(b)) continue;
          // The observer's report can arrive late on a busy device: a page
          // it says is in sight may have flown by since.
          const r = b.getBoundingClientRect();
          if (!(r.bottom > view.top - SIGHT_MARGIN && r.top < view.bottom + SIGHT_MARGIN)) { inSight.delete(b); continue; }
          if (r.top < nextTop) { next = b; nextTop = r.top; }
        }
        if (!next) return;
        const b = next;
        const width = wantOf(b);
        b.dataset.drawing = 'true';
        drawing++;
        page(Number(b.dataset.page), width)
          .then((p) => {
            if (Number(b.dataset.width || 0) < width) { b.querySelector('img').src = p.url; b.dataset.width = String(width); }
          })
          // A page that cannot be drawn is tried once more, not forever.
          .catch(() => { b.dataset.failed = String(Number(b.dataset.failed || 0) + 1); })
          .finally(() => { delete b.dataset.drawing; drawing--; pump(); });
      }
    };
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) inSight.add(e.target); else inSight.delete(e.target);
      }
      pump();
    }, { root: this.body, rootMargin: `${SIGHT_MARGIN}px 0px` });
    const lazy = (b) => { b.classList.add('lp-lazy'); this.observer.observe(b); };
    // Every page keeps the first page's shape while it is not drawn, so the
    // scroll bar and the pages' places are right from the start.
    const shape = await new Promise((resolve) => {
      const probe = new Image();
      probe.onload = () => resolve(probe.naturalWidth && probe.naturalHeight ? `${probe.naturalWidth} / ${probe.naturalHeight}` : '1 / 1.3');
      probe.onerror = () => resolve('1 / 1.3');
      probe.src = first.url;
    });
    if (moved()) return;
    inside.style.setProperty('--lp-page-shape', shape);
    for (let n = 1; n <= first.count; n++) {
      const img = el('img', { alt: '' });
      const b = el('button', { type: 'button', className: 'lp-page' }, img, el('span', { textContent: `Page ${n}` }));
      b.setAttribute('aria-label', `Link to page ${n}`);
      b.dataset.page = String(n);
      b.addEventListener('click', () => this._finish(`${f.link}#page=${n}`));
      grid.append(b);
      if (n === 1) { img.src = first.url; b.dataset.width = String(this._pageWidth()); }
      lazy(b);
    }
    // Zoom: 4, 3, 2 or 1 pages across, with − and +, a pinch, or a
    // pinch on a trackpad (ctrl + wheel). The page at the top stays there.
    const setAcross = (cols) => {
      cols = Math.min(MAX_ACROSS, Math.max(1, cols));
      // The page at the top of the view (under the search bar), and how far
      // down it the view is, as a share of its height.
      const line = this.body.scrollTop + bar.offsetHeight;
      const top = line > grid.offsetTop ? [...grid.children].find((b) => b.offsetTop + b.offsetHeight > line) : null;
      const into = top ? (line - top.offsetTop) / top.offsetHeight : 0;
      this.across = cols;
      grid.style.setProperty('--lp-across', String(cols));
      grid.dataset.across = String(cols);
      across.textContent = cols === 1 ? '1 page' : `${cols} across`;
      zoomIn.disabled = cols === 1;
      zoomOut.disabled = cols === MAX_ACROSS;
      if (top) this.body.scrollTop = top.offsetTop + into * top.offsetHeight - bar.offsetHeight;
      // Sharper pictures for pages now shown bigger.
      pump();
    };
    zoomIn.addEventListener('click', () => setAcross(this.across - 1));
    zoomOut.addEventListener('click', () => setAcross(this.across + 1));
    setAcross(this.across);
    let pinch = null;
    const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    grid.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = spread(e.touches); }, { passive: true });
    grid.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2 || !pinch) return;
      e.preventDefault();
      const d = spread(e.touches);
      if (d / pinch > 1.3) { setAcross(this.across - 1); pinch = d; } else if (d / pinch < 0.77) { setAcross(this.across + 1); pinch = d; }
    }, { passive: false });
    grid.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });
    let wheel = 0;
    grid.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      wheel += e.deltaY;
      if (Math.abs(wheel) < 40) return;
      setAcross(this.across + (wheel > 0 ? 1 : -1));
      wheel = 0;
    }, { passive: false });

    // Search: the PDF's text, found the way Obsidian's PDF viewer finds it
    // (the plugin uses its find controller). Tap a hit to link its page.
    let asked = 0;
    let timer = null;
    const search = async () => {
      const q = find.value.trim();
      const mine = ++asked;
      if (!q) {
        results.hidden = true;
        grid.hidden = false;
        note.textContent = 'Tap a page to link to it.';
        return;
      }
      grid.hidden = true;
      results.hidden = false;
      note.textContent = 'Searching…';
      results.replaceChildren();
      let r;
      try { r = await this.rpc.call('pdf-find', { path: f.path, query: q }); } catch (e) {
        if (mine === asked && !moved()) note.textContent = `This PDF could not be searched (${e.message}).`;
        return;
      }
      if (mine !== asked || moved()) return;
      const hits = r?.hits || [];
      const total = r?.total ?? hits.length;
      note.textContent = !total ? 'Not found in this PDF. Text in pictures (scans) cannot be searched.'
        : total > hits.length ? `${total} matches; the first ${hits.length} are listed. Tap one to link its page.`
          : `${total === 1 ? '1 match' : `${total} matches`}. Tap one to link its page.`;
      // The matches page by page, each page with its picture.
      const byPage = new Map();
      for (const h of hits) {
        if (!byPage.has(h.page)) byPage.set(h.page, []);
        byPage.get(h.page).push(h);
      }
      for (const [n, list] of byPage) {
        const thumb = el('button', { type: 'button', className: 'lp-hit-thumb' }, el('img', { alt: '' }));
        thumb.dataset.page = String(n);
        thumb.setAttribute('aria-label', `Link to page ${n}`);
        thumb.addEventListener('click', () => this._finish(`${f.link}#page=${n}`));
        const texts = el('div', { className: 'lp-hit-texts' },
          el('span', { className: 'lp-hit-page', textContent: `Page ${n}${list.length > 1 ? ` · ${list.length} matches` : ''}` }));
        for (const h of list) {
          const b = el('button', { type: 'button', className: 'lp-hit' },
            el('span', { className: 'lp-hit-text' },
              h.before.trimStart(), el('mark', { textContent: h.match }), h.after.trimEnd()));
          b.dataset.page = String(n);
          b.setAttribute('aria-label', `Link to page ${n}: ${h.before}${h.match}${h.after}`);
          b.addEventListener('click', () => this._finish(`${f.link}#page=${n}`));
          texts.append(b);
        }
        const row = el('li', { className: 'lp-hit-row' }, thumb, texts);
        row.dataset.page = String(n);
        results.append(row);
        lazy(thumb);
      }
    };
    find.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 200); });
    // The plugin starts reading the text now, so the first search is quick.
    this.rpc.call('pdf-find', { path: f.path, query: '' }).catch(() => {});
    find.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); search(); }
    });
  }

  /** How wide a page's picture is drawn: as wide as it is shown, in device
   *  pixels (at most twice the CSS size). */
  _pageWidth() {
    const inner = Math.max(200, (this.body.clientWidth || 320) - 24);
    const gaps = 12 * (this.across - 1);
    const css = (inner - gaps) / this.across - 12;
    return Math.min(2000, Math.max(50, Math.round(css * Math.min(window.devicePixelRatio || 1, 2) / 50) * 50));
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
