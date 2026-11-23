// A PDF's pages as pictures, for the canvas's link picker (link to a page:
// `[[Paper.pdf#page=3]]`). Drawn with PDF.js, which Obsidian ships for its
// own PDF viewer (`loadPdfJs()`), so nothing is added to the plugin. The
// last opened PDF is kept while its pages are asked for one after another.
// Free of Obsidian imports so it can be tested on its own.

export class PdfPages {
  /** `pdfjs()` resolves to the PDF.js library; `read(path)` to
   *  `{ bytes, version }` (version changes when the file does); `viewer()`
   *  to Obsidian's PDF.js viewer components (`window.pdfjsViewer`), or
   *  nothing while Obsidian has not loaded them. */
  constructor({ pdfjs, read, viewer = () => globalThis.pdfjsViewer, doc = globalThis.document }) {
    this.pdfjs = pdfjs;
    this.viewer = viewer;
    this.read = read;
    this.doc = doc;
    this.open = null; // { path, version, pdf: Promise }
  }

  async _pdf(path) {
    const { bytes, version } = await this.read(path);
    if (this.open?.path === path && this.open.version === version) return this.open.pdf;
    this.close();
    const lib = await this.pdfjs();
    const pdf = lib.getDocument({ data: new Uint8Array(bytes) }).promise;
    this.open = { path, version, pdf };
    pdf.catch(() => { if (this.open?.pdf === pdf) this.open = null; });
    return pdf;
  }

  /** `{ count, png }`: how many pages, and page `n` drawn `width` px wide. */
  async page(path, n, width) {
    const pdf = await this._pdf(path);
    const count = pdf.numPages;
    const page = await pdf.getPage(Math.min(Math.max(1, n), count));
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = this.doc.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: g, viewport }).promise;
    page.cleanup?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return { count, png: await blob.arrayBuffer() };
  }

  /** Where `query` is in the PDF, for the link picker's search: `{ count,
   *  total, hits }`, at most `limit` hits in page order, each `{ page,
   *  before, match, after, selection }`. `selection` is
   *  `[beginIndex, beginOffset, endIndex, endOffset]` in the page's text
   *  items, the numbers of Obsidian's `#page=N&selection=…` links.
   *
   *  The matching is PDF.js's find controller, the one behind the search
   *  bar of Obsidian's own PDF viewer (`window.pdfjsViewer`), so the same
   *  passages are found: any case, accents optional, spaces and hyphens at
   *  line ends forgiven. Before Obsidian has loaded its viewer, the same
   *  rules are applied here (`findInText`). */
  async find(path, query, limit = 100) {
    const pdf = await this._pdf(path);
    const count = pdf.numPages;
    const q = String(query ?? '').trim();
    if (!q) return { count, total: 0, hits: [] };
    // Each page's text as PDF.js's find controller joins it: its items,
    // with a line break after each one that ends a line.
    const pages = [];
    for (let n = 1; n <= count; n++) {
      let items = [];
      try {
        const page = await pdf.getPage(n);
        items = (await page.getTextContent({ disableNormalization: true })).items || [];
      } catch { /* a page without text */ }
      pages.push(pageText(items));
    }
    const viewer = this.viewer?.();
    let found = null;
    if (viewer?.PDFFindController && viewer.EventBus) {
      try {
        found = (await findWithViewer(viewer, pdf, q))?.map((m, i) => m.map((hit) => fromItemsOnly(pages[i], hit)));
      } catch { found = null; }
    }
    found ||= pages.map((p) => findInText(p.text, q));
    const hits = [];
    let total = 0;
    found.forEach((matches, i) => {
      for (const [at, length] of matches || []) {
        total++;
        if (hits.length >= limit) continue;
        const { text, starts } = pages[i];
        hits.push({
          page: i + 1,
          // Up to about 40 letters before and 60 after, in whole words.
          before: at > 40 ? `…${oneLine(text.slice(at - 40, at)).replace(/^\S*\s/, '')}` : oneLine(text.slice(0, at)),
          match: oneLine(text.slice(at, at + length)),
          after: text.length > at + length + 60 ? `${oneLine(text.slice(at + length, at + length + 60)).replace(/\s\S*$/, '')}…` : oneLine(text.slice(at + length)),
          selection: selectionOf(starts, pages[i].items, at, at + length),
        });
      }
    });
    return { count, total, hits };
  }

  close() {
    const old = this.open;
    this.open = null;
    old?.pdf.then((p) => p.destroy?.()).catch(() => {});
  }
}

/** A page's text as PDF.js's find controller joins it (`text`), and where
 *  each of its text items starts in it (`starts`). */
export function pageText(items) {
  let text = '';
  const starts = [];
  const strs = [];
  for (const item of items) {
    const str = typeof item?.str === 'string' ? item.str : '';
    starts.push(text.length);
    strs.push(str);
    text += str;
    if (item?.hasEOL) text += '\n';
  }
  return { text, starts, items: strs };
}

/** `[beginIndex, beginOffset, endIndex, endOffset]` of the text from `from`
 *  to `to` (not included) of a page, in its items (`pageText`): Obsidian's
 *  `selection=` numbers. */
export function selectionOf(starts, strs, from, to) {
  // The item a position is in; a line break between items counts as the
  // start of the next item (begin) or the end of the one before (end).
  const itemAt = (pos, end) => {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1] <= pos) i++;
    const off = pos - starts[i];
    if (off < strs[i].length || end) return [i, Math.min(off, strs[i].length)];
    let j = i + 1;
    while (j < starts.length && !strs[j].length) j++;
    return j < starts.length ? [j, 0] : [i, strs[i].length];
  };
  if (!starts.length) return [0, 0, 0, 0];
  const [bi, bo] = itemAt(from, false);
  let [ei, eo] = itemAt(Math.max(from, to - 1), true);
  if (eo < strs[ei].length) eo++;
  if (ei < bi || (ei === bi && eo < bo)) [ei, eo] = [bi, bo];
  return [bi, bo, ei, eo];
}

/** Text as PDF.js's find compares it: lower case, accents left out, every
 *  run of spaces one space, a hyphen at a line's end joining the word.
 *  `at[k]` is where character k came from. */
function folded(text) {
  let out = '';
  const at = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '\n') { i++; continue; }
    if (/\s/.test(c)) {
      if (out && !out.endsWith(' ')) { out += ' '; at.push(i); }
      continue;
    }
    for (const f of c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()) { out += f; at.push(i); }
  }
  return { out, at };
}

/** `[[at, length], …]`: where `query` is in `text`, matched the way the
 *  search bar of Obsidian's PDF viewer matches (see `folded`). Used before
 *  Obsidian has loaded its PDF viewer, whose find controller does this. */
export function findInText(text, query) {
  const q = folded(query).out.trim();
  if (!q) return [];
  const { out, at } = folded(text);
  const hits = [];
  for (let k = out.indexOf(q); k !== -1; k = out.indexOf(q, k + q.length)) {
    const start = at[k];
    hits.push([start, at[k + q.length - 1] + 1 - start]);
  }
  return hits;
}

/** The matches per page that PDF.js's find controller (the one behind
 *  Obsidian's PDF search bar) finds for `query` in `pdf`, as
 *  `[[[at, length], …], …]`, or null if it could not be used. */
export async function findWithViewer(viewer, pdf, query, timeoutMs = 30000) {
  const count = pdf.numPages;
  const eventBus = new viewer.EventBus();
  // The controller asks the viewer's link service which page is open, and
  // turns it to the first match; there is no viewer here.
  const linkService = { page: 1, pagesCount: count, rotation: 0, goToPage() {}, goToDestination() {} };
  const fc = new viewer.PDFFindController({ linkService, eventBus, updateMatchesCountOnProgress: false });
  fc.setDocument(pdf);
  const ready = () => {
    const m = fc.pageMatches;
    if (!m) return false;
    for (let i = 0; i < count; i++) if (!m[i]) return false;
    return true;
  };
  const done = new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (ready()) resolve(true);
      else if (Date.now() - started > timeoutMs) resolve(false);
      else setTimeout(check, 15);
    };
    check();
  });
  eventBus.dispatch('find', {
    source: null,
    type: '',
    query,
    phraseSearch: true,
    caseSensitive: false,
    entireWord: false,
    highlightAll: false,
    findPrevious: false,
    matchDiacritics: false,
  });
  if (!(await done)) return null;
  const lengths = fc.pageMatchesLength || [];
  return Array.from({ length: count }, (_, i) => fc.pageMatches[i].map((at, k) => [at, lengths[i]?.[k] ?? query.length]));
}

/** A match found by PDF.js's find controller, `[at, length]` in the page's
 *  items joined with nothing between them (as its text layer counts), in
 *  `text` of `pageText` instead (with the line breaks). */
export function fromItemsOnly({ starts, items }, [at, length]) {
  const toText = (pos) => {
    let bare = 0;
    for (let i = 0; i < items.length; i++) {
      if (pos < bare + items[i].length || i === items.length - 1) return starts[i] + (pos - bare);
      bare += items[i].length;
    }
    return pos;
  };
  const from = toText(at);
  return [from, Math.max(1, toText(at + length - 1) + 1 - from)];
}

const oneLine = (s) => s.replace(/\s+/g, ' ');

/** The page of a PDF open in Obsidian's viewer that the person is looking
 *  at: under `at` (a right-click) if given, else the page with the most of
 *  it in sight. PDF.js marks each page `.page[data-page-number]`. 1 if no
 *  page is drawn yet. */
export function pdfPageInView(container, at = null) {
  const hit = at?.closest?.('.page[data-page-number]');
  if (hit && container.contains(hit)) return Math.max(1, parseInt(hit.dataset.pageNumber, 10) || 1);
  const view = container.getBoundingClientRect();
  let best = 1;
  let most = 0;
  for (const p of container.querySelectorAll('.page[data-page-number]')) {
    const r = p.getBoundingClientRect();
    const seen = Math.max(0, Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top))
      * Math.max(0, Math.min(r.right, view.right) - Math.max(r.left, view.left));
    if (seen > most) { most = seen; best = parseInt(p.dataset.pageNumber, 10) || best; }
  }
  return best;
}
