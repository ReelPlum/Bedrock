// A PDF's pages as pictures, for the canvas's link picker (link to a page:
// `[[Paper.pdf#page=3]]`). Drawn with PDF.js, which Obsidian ships for its
// own PDF viewer (`loadPdfJs()`), so nothing is added to the plugin. The
// last opened PDF is kept while its pages are asked for one after another.
// Free of Obsidian imports so it can be tested on its own.

export class PdfPages {
  /** `pdfjs()` resolves to the PDF.js library; `read(path)` to
   *  `{ bytes, version }` (version changes when the file does). */
  constructor({ pdfjs, read, doc = globalThis.document }) {
    this.pdfjs = pdfjs;
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

  close() {
    const old = this.open;
    this.open = null;
    old?.pdf.then((p) => p.destroy?.()).catch(() => {});
  }
}

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
