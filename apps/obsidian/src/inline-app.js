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

export class InlineApp {
  /** `bundle` is what build.mjs packs: { hash, pages, modules, workers,
   *  files }. `urls` makes and revokes blob: URLs (the window's URL). */
  constructor(bundle, { host = 'obsidian', urls = globalThis.URL } = {}) {
    this.bundle = bundle;
    this.host = host;
    this.urls = urls;
    this.made = null;
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
   *  `probe` asks the welcome page only whether consent is needed. */
  page(name, { probe = false } = {}) {
    const html = this.bundle.pages?.[name];
    if (!html) throw new Error(`no ${name} page in the plugin`);
    const { assets, modules } = this.urlsOnce();
    const globals = `<script>globalThis.BEDROCK_HOST = ${scriptJson(this.host)}; globalThis.BEDROCK_PROBE = ${probe ? 'true' : 'false'}; globalThis.BEDROCK_ASSETS = ${scriptJson(assets)};</script>`;
    const module = `<script type="module" src="${modules[name]}"></script>`;
    return html.replace(GLOBALS_MARK, () => globals).replace(MODULE_MARK, () => module);
  }

  /** Lets go of the blob: URLs (the plugin is unloaded). */
  revoke() {
    if (!this.made) return;
    for (const u of [...Object.values(this.made.assets), ...Object.values(this.made.modules)]) this.urls.revokeObjectURL(u);
    this.made = null;
  }
}
