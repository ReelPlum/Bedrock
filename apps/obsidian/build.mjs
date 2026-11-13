// Builds the plugin into apps/obsidian/dist (main.js, manifest.json,
// styles.css): the files an Obsidian vault needs in
// .obsidian/plugins/bedrock-notes/.
//
// The web app is not copied or forked: its files (apps/web, with the
// WebAssembly built by scripts/build-web.sh) are packed into main.js as they
// are, so every web app change ships in the next plugin build.
//
//   node build.mjs            build dist/
//   node build.mjs --vault /path/to/vault   also install into that vault
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '../web');
const DIST = join(HERE, 'dist');

// What the web app needs at runtime (no tests, service worker or manifest).
const WEB_FILES = ['index.html', 'style.css', 'src', 'pkg', 'dict/en.aff', 'dict/en.dic.gz', 'icons/icon.svg'];

async function walk(path) {
  const s = await stat(path);
  if (!s.isDirectory()) return [path];
  const out = [];
  for (const e of (await readdir(path)).sort()) out.push(...(await walk(join(path, e))));
  return out;
}

export async function packWebApp(root = WEB) {
  const files = {};
  const hash = createHash('sha256');
  for (const entry of WEB_FILES) {
    let paths;
    try { paths = await walk(join(root, entry)); } catch {
      throw new Error(`${join(root, entry)} is missing${entry === 'pkg' ? ': run ./scripts/build-web.sh first' : ''}`);
    }
    for (const p of paths) {
      const rel = relative(root, p).split('\\').join('/');
      const data = await readFile(p);
      hash.update(rel).update(data);
      files[rel] = data.toString('base64');
    }
  }
  return { hash: hash.digest('hex').slice(0, 16), files };
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
  for (const f of ['manifest.json', 'styles.css']) await cp(join(HERE, f), join(outdir, f));
  return { outdir, hash: bundle.hash, files: Object.keys(bundle.files).length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await buildPlugin();
  const size = (await stat(join(r.outdir, 'main.js'))).size;
  console.log(`dist/main.js ${(size / 1e6).toFixed(1)} MB, web app ${r.hash} (${r.files} files)`);
  const i = process.argv.indexOf('--vault');
  if (i > 0) {
    const manifest = JSON.parse(await readFile(join(HERE, 'manifest.json'), 'utf8'));
    const target = join(resolve(process.argv[i + 1]), '.obsidian/plugins', manifest.id);
    await mkdir(target, { recursive: true });
    for (const f of ['main.js', 'manifest.json', 'styles.css']) await cp(join(r.outdir, f), join(target, f));
    console.log(`installed into ${target}`);
  }
}
