// Builds the plugin into apps/obsidian/dist (main.js, manifest.json,
// styles.css): the files an Obsidian vault needs in
// .obsidian/plugins/bedrock-notes/.
//
// The web app is not copied or forked: its pages, modules and files
// (apps/web, with the WebAssembly built by scripts/build-web.sh) are packed
// into main.js at build time, so every web app change ships in the next
// plugin build.
//
//   node build.mjs            build dist/
//   node build.mjs --vault /path/to/vault   also install into that vault
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLOBALS_MARK, MODULE_MARK } from './src/inline-app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '../web');
const DIST = join(HERE, 'dist');
// manifest.json lives at the repository root, where Obsidian and BRAT look
// for it; the build copies it into dist/.
export const MANIFEST = resolve(HERE, '../../manifest.json');

// Obsidian refuses every file request from a page inside a view (its
// webRequest filter lets only Obsidian's own window load app:// files), so
// the canvas cannot load its files from the plugin folder the way a browser
// loads the web app. Instead each page is packed ready to be written into
// the view's iframe (`srcdoc`), with its stylesheet and classic script
// inline, and its modules, workers and binary files handed over as blob:
// URLs at run time (src/inline-app.js). esbuild bundles each module graph
// into one file, since a blob: module cannot import its neighbours.

/** The pages: their HTML in apps/web, and the module each one starts. */
const PAGES = {
  app: { html: 'index.html', module: 'src/main.js' },
  welcome: { html: 'welcome/index.html', module: 'welcome/welcome.js' },
};
/** Workers, started by their path (src/assets.js). */
const WORKERS = ['src/save-worker.js', 'src/recognizer-worker.js'];
/** Binary and data files the app fetches, by their path. */
const FILES = ['pkg/bedrock_web_bg.wasm', 'pkg/bedrock_pdf_bg.wasm', 'dict/en.aff', 'dict/en.dic.gz'];
/** The plugin's own workers (in apps/obsidian), started in Obsidian's
 *  window, not in a canvas: the PDF reader of the bulk import, and the
 *  note editor of "Add tags…" and "Change paper…" (bulk-edit.js). */
const PLUGIN_WORKERS = ['src/pdf-import-worker.js', 'src/note-edit-worker.js'];


const inlineScript = (js) => js.replace(/<\/(script)/gi, '<\\/$1');
const inlineStyle = (css) => css.replace(/<\/(style)/gi, '<\\/$1');

function replaceOnce(html, pattern, by, what) {
  const found = html.match(pattern);
  if (!found) throw new Error(`apps/web: ${what} not found; update PAGES in apps/obsidian/build.mjs`);
  return html.replace(pattern, () => by);
}

/** One page's HTML, ready for the iframe's srcdoc (without its globals
 *  and module, which inline-app.js adds). */
async function pageHtml(root, page) {
  let html = await readFile(join(root, page.html), 'utf8');
  const dir = dirname(page.html);
  html = replaceOnce(html, /<head>/i, `<head>\n  ${GLOBALS_MARK}`, '<head>');
  // Links to files that cannot be loaded there anyway.
  html = html.replace(/\s*<link rel="(?:manifest|icon|apple-touch-icon)"[^>]*>/g, '');
  html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) => `<!--stylesheet ${href}-->`);
  for (const [, href] of [...html.matchAll(/<!--stylesheet ([^ ]+)-->/g)]) {
    const css = await readFile(join(root, dir, href), 'utf8');
    html = html.replace(`<!--stylesheet ${href}-->`, () => `<style>\n${inlineStyle(css)}\n</style>`);
  }
  for (const [tag, src] of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]) {
    const js = await readFile(join(root, dir, src), 'utf8');
    html = html.replace(tag, () => `<script>\n${inlineScript(js)}\n</script>`);
  }
  const moduleTag = new RegExp(`<script type="module" src="${relative(dir, page.module).split('\\').join('/')}"></script>`);
  html = replaceOnce(html, moduleTag, MODULE_MARK, `the module script of ${page.html}`);
  if (/\b(?:src|href)="(?!https?:|#|data:)[^"]*\.(?:js|css|wasm|png|svg)"/.test(html)) {
    throw new Error(`apps/web/${page.html} still loads a file by its address: the plugin cannot serve it`);
  }
  return html;
}

/** One module graph as a single ES module. Network imports (the
 *  recogniser's library from a CDN) stay imports. */
async function bundleModule(root, entry) {
  const out = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['https://*'],
    logLevel: 'warning',
  });
  return out.outputFiles[0].text;
}

/** The web app as the plugin carries it in main.js: { hash, pages,
 *  modules, workers, pluginWorkers, files (base64) }. */
export async function packWebApp(root = WEB) {
  const hash = createHash('sha256');
  const bundle = { pages: {}, modules: {}, workers: {}, pluginWorkers: {}, files: {} };
  const add = (kind, key, value) => { bundle[kind][key] = value; hash.update(`${kind}:${key}\0`).update(value); };
  for (const [name, page] of Object.entries(PAGES)) {
    add('pages', name, await pageHtml(root, page));
    add('modules', name, await bundleModule(root, page.module));
  }
  for (const w of WORKERS) add('workers', w, await bundleModule(root, w));
  for (const w of PLUGIN_WORKERS) add('pluginWorkers', w, await bundleModule(HERE, w));
  for (const f of FILES) {
    let data;
    try { data = await readFile(join(root, f)); } catch {
      throw new Error(`${join(root, f)} is missing${f.startsWith('pkg/') ? ': run ./scripts/build-web.sh first' : ''}`);
    }
    add('files', f, data.toString('base64'));
  }
  return { hash: hash.digest('hex').slice(0, 16), ...bundle };
}

export async function buildPlugin({ outdir = DIST } = {}) {
  const bundle = await packWebApp();
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: [join(HERE, 'src/main.js')],
    outfile: join(outdir, 'main.js'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    external: ['obsidian', 'electron'],
    logLevel: 'warning',
    banner: { js: '/* Bedrock for Obsidian. Source: https://github.com/ReelPlum/Bedrock/tree/main/apps/obsidian */' },
    plugins: [{
      name: 'web-app',
      setup(b) {
        b.onResolve({ filter: /^virtual:web-app$/ }, () => ({ path: 'web-app', namespace: 'web-app' }));
        b.onLoad({ filter: /.*/, namespace: 'web-app' }, () => ({ contents: JSON.stringify(bundle), loader: 'json' }));
      },
    }],
  });
  await cp(MANIFEST, join(outdir, 'manifest.json'));
  await cp(join(HERE, 'styles.css'), join(outdir, 'styles.css'));
  return { outdir, hash: bundle.hash, files: Object.keys(bundle.pages).length + Object.keys(bundle.workers).length + Object.keys(bundle.files).length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await buildPlugin();
  const size = (await stat(join(r.outdir, 'main.js'))).size;
  console.log(`dist/main.js ${(size / 1e6).toFixed(1)} MB, web app ${r.hash} (${r.files} pages, workers and files, loaded from memory)`);
  const i = process.argv.indexOf('--vault');
  if (i > 0) {
    const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
    const target = join(resolve(process.argv[i + 1]), '.obsidian/plugins', manifest.id);
    await mkdir(target, { recursive: true });
    for (const f of ['main.js', 'manifest.json', 'styles.css']) await cp(join(r.outdir, f), join(target, f));
    console.log(`installed into ${target}`);
  }
}
