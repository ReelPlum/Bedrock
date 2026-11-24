// Runs the web app's pages without serving any file. Obsidian refuses every
// file request from a page inside a view (net::ERR_BLOCKED_BY_CLIENT: only
// Obsidian's own window may load app:// files), and on the iPad the page did
// not load at all. So the view's iframe gets its page as `srcdoc`, which
// makes it a page of Obsidian's own origin, and everything that page would
// have fetched is handed over from memory as a blob: URL made here:
//
//   * the page's module (each module graph bundled into one file by
//     build.mjs, since a blob: module cannot import its neighbours);
//   * its workers, told where the files are by a first line;
//   * the WebAssembly and the word list, found by the app through
//     `globalThis.BEDROCK_ASSETS` (apps/web/src/assets.js).
//
// `BEDROCK_HOST` tells the app it runs in the plugin (a srcdoc page has no
// `?host=` in its address). Free of Obsidian imports so it can be tested
// on its own and in the browser harness.

export const GLOBALS_MARK = '<!--bedrock:globals-->';
export const MODULE_MARK = '<!--bedrock:module-->';
/** The canvas's WebAssembly, by its path in apps/web. */
export const WASM = 'pkg/bedrock_web_bg.wasm';
/** PDF import's WebAssembly (crates/bedrock-pdf). */
export const PDF_WASM = 'pkg/bedrock_pdf_bg.wasm';

const TYPES = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.aff': 'text/plain', '.gz': 'application/gzip' };
const typeOf = (path) => TYPES[path.slice(path.lastIndexOf('.'))] || 'application/octet-stream';

const bytesOf = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** JSON that can sit inside a <script> element. */
const scriptJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

/** The line that sets the page's theme, or nothing to follow the system. */
const themeLine = (theme) => (theme === 'dark' || theme === 'light' ? ` document.documentElement.dataset.theme = ${scriptJson(theme)};` : '');

export class InlineApp {
  /** `bundle` is what build.mjs packs: { hash, pages, modules, workers,
   *  files }. `urls` makes and revokes blob: URLs (the window's URL). */
  constructor(bundle, { host = 'obsidian', urls = globalThis.URL, theme = () => null } = {}) {
    this.bundle = bundle;
    /** 'dark', 'light' or null (follow the system): written into each page
     *  as `data-theme` on <html> before it paints (openspec dark-mode). */
    this.theme = theme;
    this.host = host;
    this.urls = urls;
    this.made = null;
    this.compiled = null;
    this.compiledPdf = null;
    this.pluginWorkers = new Map();
  }

  /** The blob: URLs, made once: files, then workers (which need the files),
   *  then each page's module. */
  urlsOnce() {
    if (this.made) return this.made;
    const { files = {}, workers = {}, modules = {} } = this.bundle;
    const blob = (parts, type) => this.urls.createObjectURL(new Blob(parts, { type }));
    const assets = {};
    for (const [path, b64] of Object.entries(files)) assets[path] = blob([bytesOf(b64)], typeOf(path));
    const fileMap = { ...assets };
    for (const [path, js] of Object.entries(workers)) {
      assets[path] = blob([`globalThis.BEDROCK_ASSETS = ${JSON.stringify(fileMap)};\n`, js], 'text/javascript');
    }
    const pageModules = {};
    for (const [name, js] of Object.entries(modules)) pageModules[name] = blob([js], 'text/javascript');
    this.made = { assets, modules: pageModules };
    return this.made;
  }

  /** The HTML of page `name` ('app' or 'welcome') for an iframe's srcdoc.
   *  `probe` asks the welcome page only whether consent is needed;
   *  `viewOnly` opens the note to look at, never to change. */
  page(name, { probe = false, viewOnly = false } = {}) {
    const html = this.bundle.pages?.[name];
    if (!html) throw new Error(`no ${name} page in the plugin`);
    const { assets, modules } = this.urlsOnce();
    const globals = `<script>globalThis.BEDROCK_HOST = ${scriptJson(this.host)}; globalThis.BEDROCK_PROBE = ${probe ? 'true' : 'false'}; globalThis.BEDROCK_VIEW_ONLY = ${viewOnly ? 'true' : 'false'}; globalThis.BEDROCK_ASSETS = ${scriptJson(assets)};${themeLine(this.theme())}</script>`;
    const module = `<script type="module" src="${modules[name]}"></script>`;
    return html.replace(GLOBALS_MARK, () => globals).replace(MODULE_MARK, () => module);
  }

  /** The canvas's WebAssembly, compiled once for every note opened while
   *  the plugin runs (blob: URLs get no compiled-code cache, so each note
   *  and its save worker compiled it again). Each canvas is sent the module
   *  over the bridge (`wasm`) and passes it on to its save worker. */
  wasmModule() {
    if (!this.compiled) {
      const b64 = this.bundle.files?.[WASM];
      this.compiled = b64 ? WebAssembly.compile(bytesOf(b64)) : Promise.resolve(null);
      this.compiled.catch(() => { this.compiled = null; });
    }
    return this.compiled;
  }

  /** PDF import's WebAssembly, compiled once, for the bulk import's
   *  reader (bulk-import.js), which may be started more than once. */
  pdfWasmModule() {
    if (!this.compiledPdf) {
      const b64 = this.bundle.files?.[PDF_WASM];
      this.compiledPdf = b64 ? WebAssembly.compile(bytesOf(b64)) : Promise.reject(new Error('PDF import is missing from the plugin'));
      this.compiledPdf.catch(() => { this.compiledPdf = null; });
    }
    return this.compiledPdf;
  }

  /** A blob: URL of one of the plugin's own workers (build.mjs
   *  PLUGIN_WORKERS), made once. */
  pluginWorkerUrl(path) {
    if (!this.pluginWorkers.has(path)) {
      const js = this.bundle.pluginWorkers?.[path];
      if (!js) throw new Error(`no ${path} in the plugin`);
      this.pluginWorkers.set(path, this.urls.createObjectURL(new Blob([js], { type: 'text/javascript' })));
    }
    return this.pluginWorkers.get(path);
  }

  /** Lets go of the blob: URLs (the plugin is unloaded). */
  revoke() {
    this.compiled = null;
    this.compiledPdf = null;
    for (const u of this.pluginWorkers.values()) this.urls.revokeObjectURL(u);
    this.pluginWorkers.clear();
    if (!this.made) return;
    for (const u of [...Object.values(this.made.assets), ...Object.values(this.made.modules)]) this.urls.revokeObjectURL(u);
    this.made = null;
  }
}
