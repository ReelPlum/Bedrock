// Browser tests of the web app running inside a host, the way the Obsidian
// plugin runs it: the real app (WebAssembly, WebGL2) in an iframe, talking to
// the plugin's bridge, session and indexer over postMessage. tests/harness.html
// plays Obsidian with an in-memory vault.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPointerHelpers } from '../../web/tests/helpers.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB = resolve(HERE, '../web');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json',
};

/** The web app at /, the plugin's sources under /obsidian/. */
function serve() {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const [root, rel] = path.startsWith('/obsidian/') ? [HERE, path.slice('/obsidian'.length)] : [WEB, path];
      let file = normalize(join(root, rel));
      if (!file.startsWith(root)) throw new Error('outside root');
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

let server;
let browser;
before(async () => {
  server = await serve();
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(async () => { await browser?.close(); server?.close(); });

async function openHost() {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/obsidian/tests/harness.html`);
  await page.waitForFunction(() => window.host);
  return { page, ctx, errors };
}

/** Open a vault file; returns the app's frame, with pointer helpers. */
async function openFile(page, path) {
  await page.evaluate((p) => host.open(p), path);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  await frame.waitForFunction(() => window.bedrock?.ready, null, { timeout: 20000 });
  await installPointerHelpers(frame);
  // The recogniser reads every word as "Newtn" (no models in tests).
  await frame.evaluate(() => {
    bedrock.handwriting.engine = async () => ({ text: 'Newtn', engine: 'fake' });
    bedrock.minimap.visible = false;
  });
  return frame;
}

/** Write a four-stroke word and let the recogniser read it. */
const writeWord = (frame, x = 300, y = 300) => frame.evaluate(async ([x0, y0]) => {
  for (let k = 0; k < 4; k++) {
    const x = x0 + k * 22;
    t.ev('pointerdown', 1, 'pen', x, y0, { pressure: 0.6 });
    for (let j = 1; j <= 8; j++) t.ev('pointermove', 1, 'pen', x + j * 2, y0 - (j % 2) * 26, { pressure: 0.6 });
    t.ev('pointerup', 1, 'pen', x + 16, y0, { pressure: 0 });
  }
  await t.frame();
  await bedrock.handwriting.run();
}, [x, y]);

/** Wait until `fn` (which may be async) is true in the page or frame. */
async function until(target, fn, arg, timeout = 10000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await target.evaluate(fn, arg)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('a new note in the vault: drawn, saved into the file, and indexed for search', async () => {
  const { page, ctx, errors } = await openHost();
  const frame = await openFile(page, 'Physics.bedrock');
  const ui = await frame.evaluate(() => ({
    host: document.documentElement.dataset.host,
    library: getComputedStyle(document.getElementById('btn-library')).display,
    newNote: getComputedStyle(document.querySelector('#menu [data-action="new"]')).display,
    strokes: bedrock.canvas.stroke_count(),
  }));
  assert.deepEqual(ui, { host: 'obsidian', library: 'none', newNote: 'none', strokes: 0 }, 'Obsidian keeps the note list');
  await writeWord(frame);
  // Saved by autosave, without asking.
  await until(page, () => host.vault.files.get('Physics.bedrock').data.byteLength > 0);
  await until(page, async () => (await host.files('Physics.bedrock')).index?.includes('Newtn'));
  const f = await page.evaluate(() => host.files('Physics.bedrock'));
  assert.equal(f.strokes, 4);
  assert.match(f.index, /^---\nbedrock: "Physics.bedrock"/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('making a link opens the vault note picker, and the link reaches the file, the index and Obsidian', async () => {
  const { page, ctx, errors } = await openHost();
  const frame = await openFile(page, 'Physics.bedrock');
  await writeWord(frame);
  const r = await frame.evaluate(async () => {
    const $ = (id) => document.getElementById(id);
    const word = () => JSON.parse(bedrock.canvas.words_json())[0];
    const out = {};
    bedrock.wordMenu.open(word());
    $('wm-link').click();
    out.types = [...document.querySelectorAll('#wm-link-type option')].map((o) => o.value);
    out.type = $('wm-link-type').value;
    // The picker answers asynchronously; the link is saved and the menu closes.
    for (let i = 0; i < 100 && !word().link; i++) await new Promise((res) => setTimeout(res, 20));
    out.link = word().link;
    out.closed = $('word-menu').hidden;
    bedrock.wordMenu.open(word());
    out.linkNow = $('wm-link-now').textContent;
    $('wm-open').click();
    return out;
  });
  assert.deepEqual(r.types, ['url', 'note'], 'Obsidian notes can be linked inside Obsidian');
  assert.equal(r.type, 'note', 'a new link starts as a link to a note');
  assert.deepEqual(r.link, { type: 'note', target: 'Ideas' });
  assert.ok(r.closed);
  assert.equal(r.linkNow, 'Links to [[Ideas]]');
  await until(page, () => host.calls.some((c) => c[0] === 'open'));
  const calls = await page.evaluate(() => host.calls);
  assert.deepEqual(calls, [['pick', '', 'Physics.bedrock'], ['open', 'Ideas', 'Physics.bedrock']]);
  await until(page, async () => (await host.files('Physics.bedrock')).index?.includes('[[Ideas'));
  const f = await page.evaluate(() => host.files('Physics.bedrock'));
  assert.match(f.links, /- \[\[Ideas\|Newtn\]\]/, 'links.md in the file, for any reader');
  assert.match(f.index, /## Links\n\n- \[\[Ideas\|Newtn\]\]/, 'and in the index note, for the graph and backlinks');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('closing the picker leaves the link form open, with Browse to try again and the other kinds of link', async () => {
  const { page, ctx, errors } = await openHost();
  const frame = await openFile(page, 'Physics.bedrock');
  await page.evaluate(() => host.setPick(null));
  await writeWord(frame);
  const r = await frame.evaluate(async () => {
    const $ = (id) => document.getElementById(id);
    const word = () => JSON.parse(bedrock.canvas.words_json())[0];
    bedrock.wordMenu.open(word());
    $('wm-link').click();
    await new Promise((res) => setTimeout(res, 200));
    const out = { form: !$('wm-link-form').hidden, browse: !$('wm-link-browse').hidden, link: word().link ?? null };
    // Switching to a website hides Browse; typing an address still works.
    $('wm-link-type').value = 'url';
    $('wm-link-type').dispatchEvent(new Event('change'));
    out.browseForUrl = !$('wm-link-browse').hidden;
    $('wm-link-target').value = 'example.com';
    document.querySelector('#wm-link-form .wm-save').click();
    out.urlLink = word().link;
    return out;
  });
  assert.deepEqual(r, { form: true, browse: true, link: null, browseForUrl: false, urlLink: { type: 'url', target: 'https://example.com/' } });
  assert.deepEqual(await page.evaluate(() => host.calls.map((c) => c[0])), ['pick']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('correcting what the recogniser read updates the search index', async () => {
  const { page, ctx, errors } = await openHost();
  const frame = await openFile(page, 'Physics.bedrock');
  await writeWord(frame);
  await until(page, async () => (await host.files('Physics.bedrock')).index?.includes('Newtn'));
  await frame.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    bedrock.wordMenu.open(JSON.parse(bedrock.canvas.words_json())[0]);
    $('wm-correct').click();
    $('wm-correct-text').value = 'Newton';
    document.querySelector('#wm-correct-form .wm-save').click();
  });
  // Autosave writes the file; the index follows without any other step.
  await until(page, async () => (await host.files('Physics.bedrock')).index?.includes('Newton'));
  const f = await page.evaluate(() => host.files('Physics.bedrock'));
  assert.match(f.index, /## Text\n\nNewton\n/);
  assert.doesNotMatch(f.index, /Newtn/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the note reopens from the vault file; outside changes reload; closing the view saves first', async () => {
  const { page, ctx, errors } = await openHost();
  let frame = await openFile(page, 'Other.bedrock');
  await writeWord(frame, 200, 200);
  await writeWord(frame, 200, 400);
  await until(page, async () => (await host.files('Other.bedrock')).strokes === 8);

  frame = await openFile(page, 'Physics.bedrock');
  await writeWord(frame);
  // Closing right after writing: the view asks the app to save, and waits.
  await frame.evaluate(() => t.line(100, 600, 300, 620));
  await page.evaluate(() => host.bridge.send('flush'));
  assert.equal((await page.evaluate(() => host.files('Physics.bedrock'))).strokes, 5, 'the last stroke was saved');

  frame = await openFile(page, 'Physics.bedrock');
  assert.equal(await frame.evaluate(() => bedrock.canvas.stroke_count()), 5, 'reopened from the file');

  // Another device replaced the file (e.g. sync): the open view reloads it.
  await page.evaluate(() => host.outsideChange('Physics.bedrock', 'Other.bedrock'));
  await until(frame, () => bedrock.canvas.stroke_count() === 8);
  // Our own saves never trigger that.
  await frame.evaluate(() => t.line(100, 650, 300, 660));
  await until(page, async () => (await host.files('Physics.bedrock')).strokes === 9);
  assert.equal(await page.evaluate(() => host.session.isOutsideChange(host.vault.files.get('Physics.bedrock'))), false);
  assert.equal(await frame.evaluate(() => bedrock.canvas.stroke_count()), 9);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the camera is remembered per vault file', async () => {
  const { page, ctx } = await openHost();
  let frame = await openFile(page, 'Physics.bedrock');
  await writeWord(frame);
  await frame.evaluate(async () => {
    bedrock.canvas.set_camera(120, 80, 1.5);
    await bedrock.saveNow();
  });
  frame = await openFile(page, 'Physics.bedrock');
  const cam = await frame.evaluate(() => Array.from(bedrock.canvas.camera()));
  assert.deepEqual(cam, [120, 80, 1.5]);
  await ctx.close();
});

// Bug: opening a note saved the app's empty placeholder note into the file
// before the file had loaded, wiping the note.
test('opening a note never overwrites the file with an empty note', async () => {
  const { page, ctx, errors } = await openHost();
  let frame = await openFile(page, 'Physics.bedrock');
  await writeWord(frame);
  await frame.evaluate(() => bedrock.saveNow());
  const before = await page.evaluate(() => { host.vault.log.length = 0; return host.files('Physics.bedrock'); });
  frame = await openFile(page, 'Physics.bedrock');
  assert.equal(await frame.evaluate(() => bedrock.canvas.stroke_count()), 4);
  // What the app saves for its placeholder note (a random id, before the
  // file is loaded) is not written to the file, nor its camera.
  await frame.evaluate(async () => {
    const empty = await bedrock.store.get('host');
    await bedrock.store.put({ id: 'placeholder', title: '', created: 0, modified: 0, data: new Uint8Array([80, 75, 5, 6]) });
    await bedrock.store.setKv('camera:placeholder', [9, 9, 9]);
    return empty;
  });
  const afterOpen = await page.evaluate(() => host.files('Physics.bedrock'));
  assert.equal(afterOpen.strokes, before.strokes);
  assert.equal(afterOpen.size, before.size);
  assert.deepEqual(await page.evaluate(() => host.vault.log.filter((l) => l[1] === 'Physics.bedrock')), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});
