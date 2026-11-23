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
import { installPointerHelpers, withoutBuiltInApi } from '../../web/tests/helpers.mjs';
import { packWebApp } from '../build.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB = resolve(HERE, '../web');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json',
};

/** The web app at / (and at /web/, where the plugin's sources import
 *  shared modules from), the plugin's sources under /obsidian/. */
function serve(bundle) {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path === '/bundle.json') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(bundle);
      }
      const [root, rel] = path.startsWith('/obsidian/') ? [HERE, path.slice('/obsidian'.length)]
        : path.startsWith('/web/') ? [WEB, path.slice('/web'.length)] : [WEB, path];
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
  server = await serve(JSON.stringify(await packWebApp()));
  browser = withoutBuiltInApi(await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }));
});
after(async () => { await browser?.close(); server?.close(); });

/** Obsidian cancels every file request made from a page inside a view
 *  (net::ERR_BLOCKED_BY_CLIENT): only its own window may load files. The
 *  harness does the same, so every test runs the canvas as Obsidian lets
 *  it. Returns what was refused. */
async function blockLikeObsidian(page) {
  const refused = [];
  await page.route(`http://127.0.0.1:${server.address().port}/**`, (route) => {
    let frame = null;
    try { frame = route.request().frame(); } catch { /* a worker's request */ }
    if (frame === page.mainFrame()) return route.continue();
    refused.push(new URL(route.request().url()).pathname);
    return route.abort('blockedbyclient');
  });
  return refused;
}

/** The iframe of `selector` in the harness, once it has a page. */
async function frameOf(page, selector) {
  const el = await page.waitForSelector(selector);
  return el.contentFrame();
}

async function openHost() {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.refused = await blockLikeObsidian(page);
  await page.goto(`http://127.0.0.1:${server.address().port}/obsidian/tests/harness.html`);
  await page.waitForFunction(() => window.host);
  return { page, ctx, errors };
}

/** Open a vault file; returns the app's frame, with pointer helpers. */
async function openFile(page, path, opts = {}) {
  await page.evaluate(([p, o]) => host.open(p, o), [path, opts]);
  const frame = await frameOf(page, '#frame');
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

// Bug: installed with BRAT, a note opened to an empty view (black on the
// iPad; bare unstyled buttons on a Mac): Obsidian refused the canvas's
// style.css, errors.js and main.js with net::ERR_BLOCKED_BY_CLIENT.
test('the canvas starts inside Obsidian without loading a single file (Obsidian refuses them)', async () => {
  const { page, ctx, errors } = await openHost();
  const frame = await openFile(page, 'Blocked.bedrock');
  const state = await frame.evaluate(async () => {
    await bedrock.handwriting.loadDictionary();
    return {
      styled: getComputedStyle(document.getElementById('toolbar')).position,
      dictionary: bedrock.handwriting.dictionaryReady,
    };
  });
  assert.notEqual(state.styled, 'static', 'the stylesheet is applied');
  assert.equal(state.dictionary, true, 'the word list is read');
  await writeWord(frame);
  await frame.evaluate(() => bedrock.saveNow());
  await until(page, async () => (await host.files('Blocked.bedrock')).strokes === 4);
  assert.equal(await frame.evaluate(() => bedrock.backgroundSaving), true, 'the save worker runs');
  assert.deepEqual(page.refused, [], 'nothing was asked of the plugin folder');
  assert.deepEqual(errors, []);
  await ctx.close();
});

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

test('a new note starts on the paper chosen in the settings, grid unless changed; a saved note keeps its own', async () => {
  const { page, ctx, errors } = await openHost();
  let frame = await openFile(page, 'Grid.bedrock');
  assert.equal(await frame.evaluate(() => bedrock.canvas.paper()), 'grid', 'grid by default');
  await writeWord(frame);
  await until(page, () => host.vault.files.get('Grid.bedrock').data.byteLength > 0);
  await page.evaluate(() => { host.paper = 'lines'; });
  frame = await openFile(page, 'Lines.bedrock');
  assert.equal(await frame.evaluate(() => bedrock.canvas.paper()), 'lines', 'the setting chose lines');
  // The grid note keeps its grid.
  frame = await openFile(page, 'Grid.bedrock');
  assert.equal(await frame.evaluate(() => bedrock.canvas.paper()), 'grid');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// Writing was slower in Obsidian than on the website. The canvas shares
// Obsidian's main thread, so each save there must cost Obsidian little: the
// file is handed over without a copy, and the index note waits for a pause.
test('saves hand the file to Obsidian without a copy, and the index note waits for writing to pause', async () => {
  const { page, ctx, errors } = await openHost();
  const frame = await openFile(page, 'Quick.bedrock');
  // Watched from inside the canvas: a message posted by the harness's own
  // code would no longer come from the frame.
  await frame.evaluate(() => {
    window.writes = [];
    const parent = window.parent;
    const post = parent.postMessage.bind(parent);
    parent.postMessage = (m, origin, transfer = []) => {
      if (m?.method === 'write') window.writes.push({ size: m.args.data.byteLength, handedOver: transfer.includes(m.args.data.buffer) });
      return post(m, origin, transfer);
    };
  });
  await writeWord(frame);
  await until(frame, () => window.writes.length > 0);
  await until(page, () => host.vault.files.get('Quick.bedrock').data.byteLength > 0);
  const w = await frame.evaluate(() => window.writes[0]);
  assert.equal(w.handedOver, true, 'the saved file is transferred, not copied');
  assert.equal((await page.evaluate(() => host.files('Quick.bedrock'))).index, null, 'no index note right after the save');
  await until(page, async () => (await host.files('Quick.bedrock')).index?.includes('Newtn'));
  assert.equal((await page.evaluate(() => host.files('Quick.bedrock'))).strokes, 4);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// Each note opened in Obsidian compiled the WebAssembly twice (the canvas
// and its save worker), with no compiled-code cache for blob: URLs.
test('the WebAssembly is compiled once for all notes; each canvas and its save worker reuse it', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  // Counts compiles from bytes or files in every window (Obsidian's and
  // each canvas's).
  await ctx.addInitScript(() => {
    window.compiles = 0;
    for (const name of ['compile', 'compileStreaming', 'instantiateStreaming']) {
      const f = WebAssembly[name];
      WebAssembly[name] = function (...a) { window.compiles++; return f.apply(this, a); };
    }
    const instantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = function (m, ...a) { if (!(m instanceof WebAssembly.Module)) window.compiles++; return instantiate.call(this, m, ...a); };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await blockLikeObsidian(page);
  await page.goto(`http://127.0.0.1:${server.address().port}/obsidian/tests/harness.html`);
  await page.waitForFunction(() => window.host);
  const inCanvas = [];
  for (const name of ['One.bedrock', 'Two.bedrock']) {
    const frame = await openFile(page, name);
    await writeWord(frame);
    await frame.evaluate(() => bedrock.saveNow());
    inCanvas.push(await frame.evaluate(() => ({ compiles: window.compiles, background: bedrock.backgroundSaving, stats: { ...bedrock.saveStats } })));
  }
  assert.equal(await page.evaluate(() => window.compiles), 1, 'compiled once, by the plugin');
  for (const c of inCanvas) {
    assert.equal(c.compiles, 0, 'the canvas compiles nothing');
    assert.equal(c.background, true);
    assert.ok(c.stats.background >= 1 && c.stats.direct === 0, `the save worker saved with the shared module: ${JSON.stringify(c.stats)}`);
  }
  assert.equal((await page.evaluate(() => host.files('One.bedrock'))).strokes, 4);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('making a link opens the vault note picker, and the link reaches the file, the index and Obsidian', async () => {
  const { page, ctx, errors } = await openHost();
  await page.evaluate(() => host.vault.create('Ideas.md', '# Ideas'));
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
    // The picker lists the vault; the chosen note goes into the box, and
    // Save makes the link and closes the menu.
    for (let i = 0; i < 100 && !document.querySelector('#link-picker .lp-file'); i++) await new Promise((res) => setTimeout(res, 20));
    document.querySelector('#link-picker .lp-file[data-path="Ideas.md"]').click();
    for (let i = 0; i < 100 && !$('wm-link-target').value; i++) await new Promise((res) => setTimeout(res, 20));
    out.box = $('wm-link-target').value;
    document.querySelector('#wm-link-form .wm-save').click();
    out.link = word().link;
    out.closed = $('word-menu').hidden;
    bedrock.wordMenu.open(word());
    out.linkNow = $('wm-link-now').textContent;
    $('wm-open').click();
    return out;
  });
  assert.deepEqual(r.types, ['url', 'note'], 'Obsidian notes can be linked inside Obsidian');
  assert.equal(r.type, 'note', 'a new link starts as a link to a note');
  assert.equal(r.box, 'Ideas');
  assert.deepEqual(r.link, { type: 'note', target: 'Ideas' });
  assert.ok(r.closed);
  assert.equal(r.linkNow, 'Links to [[Ideas]]');
  await until(page, () => host.calls.some((c) => c[0] === 'open'));
  const calls = await page.evaluate(() => host.calls);
  assert.deepEqual(calls, [['list', 'Physics.bedrock'], ['open', 'Ideas', 'Physics.bedrock']]);
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
  await writeWord(frame);
  const r = await frame.evaluate(async () => {
    const $ = (id) => document.getElementById(id);
    const word = () => JSON.parse(bedrock.canvas.words_json())[0];
    bedrock.wordMenu.open(word());
    $('wm-link').click();
    await new Promise((res) => setTimeout(res, 200));
    document.querySelector('#link-picker .lp-close').click();
    await new Promise((res) => setTimeout(res, 50));
    const out = { picker: !$('link-picker').hidden, form: !$('wm-link-form').hidden, browse: !$('wm-link-browse').hidden, link: word().link ?? null };
    // Switching to a website hides Browse; typing an address still works.
    $('wm-link-type').value = 'url';
    $('wm-link-type').dispatchEvent(new Event('change'));
    out.browseForUrl = !$('wm-link-browse').hidden;
    $('wm-link-target').value = 'example.com';
    document.querySelector('#wm-link-form .wm-save').click();
    out.urlLink = word().link;
    return out;
  });
  assert.deepEqual(r, { picker: false, form: true, browse: true, link: null, browseForUrl: false, urlLink: { type: 'url', target: 'https://example.com/' } });
  assert.deepEqual(await page.evaluate(() => host.calls.map((c) => c[0])), ['list']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

/** Hold the first word with the mouse, as a finger or pen would, until its
 *  menu opens. The frame fills the harness from its top left corner. */
async function holdWord(page, frame) {
  const at = await frame.evaluate(() => {
    const [x0, y0, x1, y1] = JSON.parse(bedrock.canvas.words_json())[0].bounds;
    const [ox, oy, zoom] = bedrock.canvas.camera();
    const r = document.getElementById('stage').getBoundingClientRect();
    return { x: r.left + ((x0 + x1) / 2 - ox) * zoom, y: r.top + ((y0 + y1) / 2 - oy) * zoom };
  });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await frame.waitForFunction(() => !document.getElementById('word-menu').hidden);
  await page.mouse.up();
}

/** Click an element of the app's frame with the mouse. */
test('a note made about a page starts with its link, saved at once; tags and links of the whole note reach the file and the index', async () => {
  const { page, ctx, errors } = await openHost();
  await page.evaluate(async () => {
    await host.vault.create('Lectures/Lecture 3.md', '# Lecture 3');
    await host.vault.createBinary('Papers/Paper.pdf', new ArrayBuffer(4));
    // What "New handwritten note linking here" leaves for the canvas.
    host.starts.set('Lectures/Lecture 3 notes.bedrock', { noteLinks: [{ target: 'Lectures/Lecture 3', type: 'note', text: 'Lecture 3' }] });
  });
  const frame = await openFile(page, 'Lectures/Lecture 3 notes.bedrock');
  // Saved straight away, with no ink at all.
  await until(page, () => host.vault.files.get('Lectures/Lecture 3 notes.bedrock').data.byteLength > 0);
  await until(page, async () => (await host.files('Lectures/Lecture 3 notes.bedrock')).index?.includes('[[Lectures/Lecture 3|'));
  let f = await page.evaluate(() => host.files('Lectures/Lecture 3 notes.bedrock'));
  assert.equal(f.strokes, 0);
  assert.deepEqual(f.noteLinks, [{ target: 'Lectures/Lecture 3', type: 'note', text: 'Lecture 3' }]);
  assert.match(f.links, /- \[\[Lectures\/Lecture 3\|Lecture 3\]\]/, 'in links.md');
  assert.match(f.index, /## Links\n\n- \[\[Lectures\/Lecture 3\|Lecture 3\]\]/, 'and in the index note, so it shows in backlinks and the graph');

  // "Tags and links…" in the menu: add tags, a PDF page from the vault and a website.
  await clickIn(page, frame, '#btn-menu');
  await clickIn(page, frame, '#menu [data-action="note-info"]');
  const panel = await frame.evaluate(() => ({
    open: !document.getElementById('note-info').hidden,
    links: [...document.querySelectorAll('#note-info .ni-open')].map((b) => b.textContent),
    tags: document.querySelector('#note-info .ni-tags').textContent,
  }));
  assert.deepEqual(panel, { open: true, links: ['Lecture 3'], tags: 'No tags yet.' });
  for (const t of ['#Exam prep', 'physics/forces', 'exam-PREP']) {
    await frame.fill('#note-info .ni-tags + form input', t);
    await frame.press('#note-info .ni-tags + form input', 'Enter');
  }
  assert.match(await frame.textContent('#note-info .wm-error'), /already a tag/, 'the same tag in another case is not added twice');
  await clickIn(page, frame, '#note-info .ni-browse');
  await frame.waitForSelector('#link-picker:not([hidden]) .lp-tree');
  await frame.click('#link-picker .lp-folder[data-path="Papers"]');
  await frame.click('#link-picker .lp-file[data-path="Papers/Paper.pdf"]');
  await frame.waitForSelector('#link-picker .lp-page[data-page="2"]');
  await frame.click('#link-picker .lp-page[data-page="2"]');
  await until(frame, () => document.querySelectorAll('#note-info .ni-open').length === 2);
  await frame.fill('#note-info .ni-links ~ form input', 'example.com/course');
  await frame.press('#note-info .ni-links ~ form input', 'Enter');
  const shown = await frame.evaluate(() => ({
    links: [...document.querySelectorAll('#note-info .ni-open')].map((b) => b.title),
    tags: [...document.querySelectorAll('#note-info .ni-tag span')].map((s) => s.textContent),
    open: !document.getElementById('note-info').hidden,
  }));
  assert.deepEqual(shown, {
    links: ['Lectures/Lecture 3', 'Papers/Paper.pdf#page=2', 'https://example.com/course'],
    tags: ['#Exam-prep', '#physics/forces'],
    open: true,
  }, 'the panel stays open over the picker and shows what was added');
  // Remove one tag and one link; open another.
  await clickIn(page, frame, '#note-info .ni-tag:first-child .ni-remove');
  await clickIn(page, frame, '#note-info .ni-link:nth-child(3) .ni-remove');
  await clickIn(page, frame, '#note-info .ni-link:nth-child(2) .ni-open');
  await until(page, () => host.calls.some((c) => c[0] === 'open'));
  assert.deepEqual((await page.evaluate(() => host.calls)).filter((c) => c[0] === 'open'), [['open', 'Papers/Paper.pdf#page=2', 'Lectures/Lecture 3 notes.bedrock']]);

  await frame.evaluate(() => bedrock.saveNow());
  await until(page, async () => (await host.files('Lectures/Lecture 3 notes.bedrock')).index?.includes('physics/forces'));
  f = await page.evaluate(() => host.files('Lectures/Lecture 3 notes.bedrock'));
  assert.deepEqual(f.tags, ['physics/forces']);
  assert.deepEqual(f.noteLinks.map((l) => l.target), ['Lectures/Lecture 3', 'Papers/Paper.pdf#page=2']);
  assert.match(f.index, /^---\nbedrock: "Lectures\/Lecture 3 notes.bedrock"\ntags: \[bedrock, physics\/forces\]\n---/, 'Obsidian sees the tag');
  assert.match(f.index, /## Links\n\n- \[\[Lectures\/Lecture 3\|Lecture 3\]\]\n- \[\[Papers\/Paper\.pdf#page=2\]\]\n/);

  // Reopened, it is all still there, and the starting link is not added again.
  const again = await openFile(page, 'Lectures/Lecture 3 notes.bedrock');
  const info = await again.evaluate(() => JSON.parse(bedrock.canvas.note_info_json()));
  assert.deepEqual([info.tags, info.noteLinks.length], [['physics/forces'], 2]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

async function clickIn(page, frame, selector) {
  const b = await frame.evaluate((s) => document.querySelector(s).getBoundingClientRect().toJSON(), selector);
  await page.mouse.click(b.left + b.width / 2, b.top + b.height / 2);
}

/** Open the link picker for the first word with real taps. */
async function openPicker(page, frame) {
  await holdWord(page, frame);
  await clickIn(page, frame, '#wm-link');
  await frame.waitForSelector('#link-picker .lp-tree');
}

// Bug: "the searching / browsing when linking is still not working". The
// picker was Obsidian's search popup, in Obsidian's window outside the
// canvas: on the iPad a note picked there never reached the link box, and it
// showed no folders.
test("the link picker shows the vault's folders and files; tapping a note puts its link in the box", async () => {
  const { page, ctx, errors } = await openHost();
  await page.evaluate(async () => {
    await host.vault.create('Ideas.md', '# Ideas');
    await host.vault.create('Projects/Plan.md', '# Plan');
    await host.vault.create('Projects/Old/Notes.md', '# Notes');
    await host.vault.createBinary('Papers/Paper.pdf', new ArrayBuffer(4));
  });
  const frame = await openFile(page, 'Physics.bedrock');
  await writeWord(frame);
  await until(page, () => host.vault.files.has('Bedrock index/Physics.md'));
  // On the iPad a focused text box brings up the keyboard: not while the
  // picker is what the writer is looking at.
  await frame.evaluate(() => {
    window.boxFocused = false;
    document.getElementById('wm-link-target').addEventListener('focus', () => { window.boxFocused = true; });
  });
  await openPicker(page, frame);
  const rows = () => frame.evaluate(() => [...document.querySelectorAll('#link-picker .lp-tree button')].map((b) => b.dataset.path));
  assert.deepEqual(await rows(), ['Papers', 'Projects', 'Ideas.md'], 'folders first, closed; not the note itself or its index note');
  await frame.click('#link-picker .lp-folder[data-path="Projects"]');
  assert.deepEqual(await rows(), ['Papers', 'Projects', 'Projects/Old', 'Projects/Plan.md', 'Ideas.md']);
  await frame.click('#link-picker .lp-file[data-path="Projects/Plan.md"]');
  const r = await frame.evaluate(() => ({
    picker: !document.getElementById('link-picker').hidden,
    form: !document.getElementById('wm-link-form').hidden,
    box: document.getElementById('wm-link-target').value,
    boxFocused: window.boxFocused,
    link: JSON.parse(bedrock.canvas.words_json())[0].link ?? null,
  }));
  assert.deepEqual(r, { picker: false, form: true, box: 'Projects/Plan', boxFocused: false, link: null }, 'the chosen note waits in the box for Save');
  // Browse again: the filter finds a file in any folder.
  await clickIn(page, frame, '#wm-link-browse');
  await frame.waitForSelector('#link-picker:not([hidden]) .lp-tree');
  await frame.fill('#link-picker .lp-filter', 'note');
  assert.deepEqual(await rows(), ['Projects/Old/Notes.md']);
  await frame.click('#link-picker .lp-file[data-path="Projects/Old/Notes.md"]');
  await clickIn(page, frame, '#wm-link-form .wm-save');
  const after = await frame.evaluate(() => ({
    closed: document.getElementById('word-menu').hidden,
    link: JSON.parse(bedrock.canvas.words_json())[0].link ?? null,
  }));
  assert.deepEqual(after, { closed: true, link: { type: 'note', target: 'Projects/Old/Notes' } });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the link picker opens a PDF to link one of its pages, or the whole file', async () => {
  const { page, ctx, errors } = await openHost();
  await page.evaluate(() => host.vault.createBinary('Papers/Paper.pdf', new ArrayBuffer(4)));
  const frame = await openFile(page, 'Physics.bedrock');
  await writeWord(frame);
  await openPicker(page, frame);
  await frame.click('#link-picker .lp-folder[data-path="Papers"]');
  await frame.click('#link-picker .lp-file[data-path="Papers/Paper.pdf"]');
  await frame.waitForSelector('#link-picker .lp-page[data-page="3"]');
  // The pages are the plugin's pictures of them.
  await frame.waitForFunction(() => [...document.querySelectorAll('#link-picker .lp-page img')].every((i) => i.complete && i.naturalWidth > 0));
  assert.deepEqual(await frame.evaluate(() => [...document.querySelectorAll('#link-picker .lp-page')].map((b) => b.textContent)), ['Page 1', 'Page 2', 'Page 3']);
  await frame.click('#link-picker .lp-page[data-page="2"]');
  assert.equal(await frame.evaluate(() => document.getElementById('wm-link-target').value), 'Papers/Paper.pdf#page=2');
  // Or the whole file.
  await clickIn(page, frame, '#wm-link-browse');
  await frame.waitForSelector('#link-picker:not([hidden]) .lp-tree');
  await frame.click('#link-picker .lp-file[data-path="Papers/Paper.pdf"]');
  await frame.click('#link-picker .lp-whole');
  assert.equal(await frame.evaluate(() => document.getElementById('wm-link-target').value), 'Papers/Paper.pdf');
  await clickIn(page, frame, '#wm-link-form .wm-save');
  assert.deepEqual(await frame.evaluate(() => JSON.parse(bedrock.canvas.words_json())[0].link), { type: 'note', target: 'Papers/Paper.pdf' });
  const pages = await page.evaluate(() => host.calls.filter((c) => c[0] === 'pdf-page').map((c) => c[2]));
  assert.deepEqual([...new Set(pages)].sort(), [1, 2, 3]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the link picker opens another Bedrock note to link one of its words, or the whole note', async () => {
  const { page, ctx, errors } = await openHost();
  // Another handwritten note, with a word in it.
  let frame = await openFile(page, 'Maths.bedrock');
  await writeWord(frame, 200, 200);
  await frame.evaluate(() => bedrock.saveNow());
  await until(page, async () => (await host.files('Maths.bedrock')).strokes === 4);
  // The word as read is in the file too (its index note is made from the
  // file), before the note is closed: the harness closes without a save.
  await until(page, async () => (await host.files('Maths.bedrock')).index?.includes('Newtn'));
  const mathsStrokes = await frame.evaluate(() => JSON.parse(bedrock.canvas.words_json())[0].strokes);
  frame = await openFile(page, 'Physics.bedrock');
  await writeWord(frame);
  await openPicker(page, frame);
  await frame.click('#link-picker .lp-file[data-path="Maths.bedrock"]');
  await frame.waitForSelector('#link-picker .lp-word');
  const marks = await frame.evaluate(() => [...document.querySelectorAll('#link-picker .lp-word')].map((m) => ({ stroke: m.dataset.stroke, label: m.getAttribute('aria-label') })));
  assert.equal(marks.length, 1);
  assert.ok(mathsStrokes.includes(marks[0].stroke), 'the mark names a stroke of that word');
  assert.equal(marks[0].label, 'Link to “Newtn”');
  await frame.click('#link-picker .lp-word');
  assert.equal(await frame.evaluate(() => document.getElementById('wm-link-target').value), `Maths.bedrock#^${marks[0].stroke}`);
  // Or the whole note.
  await clickIn(page, frame, '#wm-link-browse');
  await frame.waitForSelector('#link-picker:not([hidden]) .lp-tree');
  await frame.click('#link-picker .lp-file[data-path="Maths.bedrock"]');
  await frame.click('#link-picker .lp-whole');
  assert.equal(await frame.evaluate(() => document.getElementById('wm-link-target').value), 'Maths.bedrock');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// Bug: on the iPad the keyboard came up over the link box. It covers the
// bottom of Obsidian without resizing the view, so the canvas never knew.
test('bug: the word menu moves above the iPad keyboard, and back when it goes', async () => {
  const { page, ctx, errors } = await openHost();
  const frame = await openFile(page, 'Physics.bedrock');
  await writeWord(frame, 300, 380);
  await holdWord(page, frame);
  await clickIn(page, frame, '#wm-link');
  // Back from the picker to the link form, to type the link.
  await frame.click('#link-picker .lp-close');
  const menu = () => frame.evaluate(() => {
    const m = document.getElementById('word-menu').getBoundingClientRect();
    const box = document.getElementById('wm-link-target').getBoundingClientRect();
    const word = JSON.parse(bedrock.canvas.words_json())[0].bounds;
    const [, oy, zoom] = bedrock.canvas.camera();
    return { top: m.top, bottom: m.bottom, box: box.bottom, wordTop: (word[1] - oy) * zoom };
  });
  const before = await menu();
  assert.ok(before.bottom > 768 - 320, `the menu starts below the word, where the keyboard will be (${before.bottom})`);
  await page.evaluate(() => host.keyboard(320));
  await until(frame, () => document.getElementById('word-menu').getBoundingClientRect().bottom <= 768 - 320);
  const up = await menu();
  assert.ok(up.box <= 768 - 320, 'the link box is above the keyboard');
  assert.ok(up.bottom <= up.wordTop, 'above the word, which stays in sight');
  await page.evaluate(() => host.keyboard(0));
  await until(frame, () => document.getElementById('word-menu').getBoundingClientRect().top > 380);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// Bug: on the iPad, typing in a text box low on the page (here a reading in
// "Show and correct what the recogniser reads") happened under the keyboard,
// out of sight: only the word menu kept clear of it.
test('bug: any text box being typed in slides into sight above the iPad keyboard, and back after', async () => {
  const { page, ctx, errors } = await openHost();
  const frame = await openFile(page, 'Physics.bedrock');
  for (let k = 0; k < 9; k++) await writeWord(frame, 300 + (k % 3) * 160, 140 + Math.floor(k / 3) * 140);
  await frame.evaluate(async () => {
    bedrock.recognizerView.visible = true;
    await bedrock.recognizerView.refresh();
  });
  const box = () => frame.evaluate(() => {
    const inputs = [...document.querySelectorAll('#recognizer-view .rv-text')];
    return { n: inputs.length, bottom: inputs.at(-1).getBoundingClientRect().bottom };
  });
  const before = await box();
  assert.ok(before.n >= 6 && before.bottom > 768 - 320, `the last reading starts where the keyboard will be (${before.bottom})`);
  await frame.evaluate(() => [...document.querySelectorAll('#recognizer-view .rv-text')].at(-1).focus());
  await page.evaluate(() => host.keyboard(320));
  await until(frame, () => [...document.querySelectorAll('#recognizer-view .rv-text')].at(-1).getBoundingClientRect().bottom <= 768 - 320);
  // Done typing: the page slides back.
  await frame.evaluate(() => document.activeElement.blur());
  await page.evaluate(() => host.keyboard(0));
  await until(frame, () => document.body.getBoundingClientRect().top === 0);
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

test('the pen writes while a note opens in Obsidian, and while an outside change reloads it', async () => {
  const { page, ctx, errors } = await openHost();
  await page.evaluate(() => host.open('Other.bedrock'));
  const early = await frameOf(page, '#frame');
  await early.waitForSelector('#note-loading', { state: 'attached' });
  // Its stylesheet is inline in the page, so it is drawn before the app has loaded.
  assert.equal(await early.evaluate(() => getComputedStyle(document.getElementById('note-loading')).position), 'absolute');
  const first = await openFile(page, 'Other.bedrock');
  await until(first, () => document.getElementById('note-loading').hidden);
  await writeWord(first);
  await until(page, async () => (await host.files('Other.bedrock')).strokes === 4);
  const frame = await openFile(page, 'Loading.bedrock');
  await until(frame, () => document.getElementById('note-loading').hidden);

  await frame.evaluate(() => {
    const el = document.getElementById('note-loading');
    window.penShown = false;
    new MutationObserver(() => { if (!el.hidden) window.penShown = true; }).observe(el, { attributes: true });
  });
  await page.evaluate(() => host.outsideChange('Loading.bedrock', 'Other.bedrock'));
  await until(frame, () => window.penShown);
  await until(frame, () => bedrock.canvas.stroke_count() === 4);
  await until(frame, () => document.getElementById('note-loading').hidden);
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

test('a search hit takes the open note to the words that were found and points them out', async () => {
  const { page, ctx, errors } = await openHost();
  const frame = await openFile(page, 'Physics.bedrock');
  // Two words far apart, read as different text.
  await frame.evaluate(() => {
    let n = 0;
    bedrock.handwriting.engine = async () => ({ text: ['gravity', 'momentum'][n++] ?? 'more', engine: 'fake' });
  });
  await writeWord(frame, 200, 200);
  await frame.evaluate(() => { bedrock.canvas.set_camera(6000, 4000, 1); });
  await writeWord(frame, 500, 400);
  await frame.evaluate(async () => { bedrock.canvas.set_camera(0, 0, 1); await bedrock.saveNow(); });
  await until(page, async () => (await host.files('Physics.bedrock')).index?.includes('gravity momentum'));

  const words = await frame.evaluate(() => JSON.parse(bedrock.canvas.words_json()).map((w) => ({ text: w.text, strokes: w.strokes, bounds: w.bounds })));
  const momentum = words.find((w) => w.text === 'momentum');
  const hit = await page.evaluate(() => host.searchHit('Physics.bedrock', 'moment'));
  assert.deepEqual(hit.strokes, momentum.strokes, 'the hit names the ink of the word it is in');
  assert.equal(hit.shown, true);
  const after = await frame.evaluate(() => {
    const [ox, oy, zoom] = bedrock.canvas.camera();
    const stage = document.getElementById('stage');
    const el = stage.querySelector('.jump-flash');
    const r = el?.getBoundingClientRect();
    return { ox, oy, zoom, w: stage.clientWidth, h: stage.clientHeight, flash: r && [r.left, r.top, r.right, r.bottom] };
  });
  // The word is in the middle of the view, at the zoom the note had.
  const [x0, y0, x1, y1] = momentum.bounds;
  assert.equal(after.zoom, 1);
  assert.ok(Math.abs(after.ox + after.w / 2 - (x0 + x1) / 2) < 6, `centred across: ${JSON.stringify(after)}`);
  assert.ok(Math.abs(after.oy + after.h / 2 - (y0 + y1) / 2) < 6, `centred down: ${JSON.stringify(after)}`);
  // A frame around it, on screen where the word is drawn.
  assert.ok(after.flash, 'the place is pointed out');
  assert.ok(after.flash[0] <= x0 - after.ox && after.flash[2] >= x1 - after.ox && after.flash[1] <= y0 - after.oy && after.flash[3] >= y1 - after.oy, JSON.stringify(after));
  // The frame goes when the page is touched, and does not block the pen.
  await frame.evaluate(async () => {
    t.ev('pointerdown', 1, 'pen', 40, 40, { pressure: 0.5 });
    t.ev('pointermove', 1, 'pen', 60, 44, { pressure: 0.5 });
    t.ev('pointerup', 1, 'pen', 60, 44, { pressure: 0 });
    await t.frame();
  });
  assert.equal(await frame.evaluate(() => document.querySelectorAll('.jump-flash').length), 0);
  assert.equal(await frame.evaluate(() => bedrock.canvas.stroke_count()), 9, 'the pen still writes');

  // The other word: one stroke of it is enough (a link to a word).
  const gravity = words.find((w) => w.text === 'gravity');
  assert.equal(await page.evaluate((s) => host.bridge.send('show', { strokes: [s] }), gravity.strokes[2]), true);
  const cam = await frame.evaluate(() => Array.from(bedrock.canvas.camera()));
  assert.ok(Math.abs(cam[0] + after.w / 2 - (gravity.bounds[0] + gravity.bounds[2]) / 2) < 6, `${cam}`);
  // Ink that was erased since (an old link): the view stays where it is.
  assert.equal(await page.evaluate(() => host.bridge.send('show', { strokes: ['00000000deadbeef'] })), false);
  assert.equal(await page.evaluate(() => host.bridge.send('show', { strokes: [] })), false);
  assert.equal(await page.evaluate(() => host.bridge.send('show', {})), false);
  assert.deepEqual(await frame.evaluate(() => Array.from(bedrock.canvas.camera())), cam);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the word menu copies a link to the word, for pasting into a vault note', async () => {
  const { page, ctx, errors } = await openHost();
  const frame = await openFile(page, 'Physics.bedrock');
  await writeWord(frame);
  const word = await frame.evaluate(() => {
    const w = JSON.parse(bedrock.canvas.words_json())[0];
    bedrock.wordMenu.open(w);
    const b = document.getElementById('wm-copy-here');
    const shown = !b.hidden;
    b.click();
    return { strokes: w.strokes, shown, closed: document.getElementById('word-menu').hidden };
  });
  assert.equal(word.shown, true);
  assert.equal(word.closed, true);
  await until(page, () => host.calls.some((c) => c[0] === 'copy'));
  assert.deepEqual(await page.evaluate(() => host.calls.filter((c) => c[0] === 'copy')), [['copy', word.strokes[0], 'Physics.bedrock']]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ---- View only on a desktop computer ------------------------------------------

test('on a computer the ink is locked: pen and mouse move the page, scrolling zooms, nothing is drawn; tags and readings are edited and saved', async () => {
  const { page, ctx, errors } = await openHost();
  // Written on the iPad, with a tag and a link of the whole note.
  let frame = await openFile(page, 'Physics.bedrock');
  await writeWord(frame);
  await frame.evaluate(async () => {
    bedrock.canvas.add_tag('physics');
    bedrock.canvas.add_note_link('Lecture 3', 'note', 'Lecture 3');
    await bedrock.saveNow();
  });
  await until(page, async () => (await host.files('Physics.bedrock')).tags?.length === 1);
  const before = await page.evaluate(() => Array.from(host.vault.files.get('Physics.bedrock').data.slice(0)));

  frame = await openFile(page, 'Physics.bedrock', { viewOnly: true });
  const ui = await frame.evaluate(() => {
    document.getElementById('btn-menu').click();
    const shown = (sel) => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).display !== 'none' && !el.closest('[hidden]'); };
    return {
      viewOnly: document.documentElement.dataset.viewOnly,
      strokes: bedrock.canvas.stroke_count(),
      toolbar: shown('#toolbar'), undo: shown('#btn-undo'), redo: shown('#btn-redo'),
      insert: shown('[data-action="insert-image"]'), paste: shown('[data-action="paste"]'), importPdf: shown('[data-action="import-pdf"]'),
      fingerDraw: shown('.row:has(#finger-draw)'), fit: shown('[data-action="fit"]'), tagsAndLinks: shown('[data-action="note-info"]'),
      state: document.getElementById('save-state').textContent,
      titleReadOnly: document.getElementById('title').readOnly,
    };
  });
  assert.deepEqual(ui, {
    viewOnly: 'true', strokes: 4, toolbar: false, undo: false, redo: false, insert: false, paste: false, importPdf: false,
    fingerDraw: false, fit: true, tagsAndLinks: true, state: 'View only', titleReadOnly: true,
  });

  // The pen, the mouse and a finger move the page; none of them draws.
  const moved = await frame.evaluate(async () => {
    const cam0 = Array.from(bedrock.canvas.camera());
    window.rev0 = bedrock.canvas.revision();
    bedrock.canvas.set_finger_drawing(true);
    for (const [id, type] of [[1, 'pen'], [2, 'mouse'], [3, 'touch']]) await t.line(600, 500, 650, 540, { id, type, pressure: 0.6, steps: 10 });
    // Undo, redo, the tool keys and delete do nothing.
    for (const key of ['z', 'y']) window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }));
    for (const key of ['1', 'e', 'l', 'Delete']) window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await t.frame();
    return { strokes: bedrock.canvas.stroke_count(), drawing: bedrock.canvas.is_drawing(), dx: bedrock.canvas.camera()[0] - cam0[0], undo: bedrock.canvas.undo(), changed: bedrock.canvas.revision() !== window.rev0 };
  });
  assert.equal(moved.strokes, 4, 'nothing drawn or undone');
  assert.equal(moved.changed, false, 'the note did not change');
  assert.equal(moved.drawing, false);
  assert.equal(moved.undo, false);
  assert.ok(moved.dx < -100, `the page moved with each pointer (${moved.dx})`);

  // Pasting text inserts nothing; saving and closing write nothing.
  await frame.evaluate(async () => {
    const data = new DataTransfer();
    data.setData('text/plain', 'pasted');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    await bedrock.saveNow();
  });
  await page.evaluate(() => host.bridge.send('flush', {}, 3000));
  assert.equal(await frame.evaluate(() => bedrock.canvas.revision() === window.rev0), true, 'nothing was pasted');
  assert.deepEqual(await page.evaluate(() => Array.from(host.vault.files.get('Physics.bedrock').data.slice(0))), before, 'the file is not written');
  // Even if the canvas asked, the plugin would not write changed ink.
  await assert.rejects(page.evaluate(() => host.session.handlers.write({ data: new Uint8Array([1, 2, 3]) })), /view only/);

  // Scrolling (a wheel, two fingers on a trackpad) zooms around the pointer.
  const zoom = await frame.evaluate(async () => {
    const [x0, y0, z0] = bedrock.canvas.camera();
    const at = (x, y) => [x / bedrock.canvas.camera()[2] + bedrock.canvas.camera()[0], y / bedrock.canvas.camera()[2] + bedrock.canvas.camera()[1]];
    const under = at(500, 400);
    document.getElementById('stage').dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 500, clientY: 400, bubbles: true, cancelable: true }));
    await t.frame();
    const z1 = bedrock.canvas.camera()[2];
    const stays = at(500, 400);
    document.getElementById('stage').dispatchEvent(new WheelEvent('wheel', { deltaY: 300, clientX: 500, clientY: 400, bubbles: true, cancelable: true }));
    await t.frame();
    return { inBy: z1 / z0, outBy: bedrock.canvas.camera()[2] / z1, drift: Math.hypot(stays[0] - under[0], stays[1] - under[1]), moved: x0 !== bedrock.canvas.camera()[0] || y0 !== bedrock.canvas.camera()[1] };
  });
  assert.ok(zoom.inBy > 1.1 && zoom.inBy < 1.5, `scrolling up zooms in (${zoom.inBy})`);
  assert.ok(zoom.outBy < 0.8, `scrolling down zooms out (${zoom.outBy})`);
  assert.ok(zoom.drift < 1, 'around the pointer');

  // A word's menu corrects the reading and copies a link; it does not link or change the ink.
  const menu = await frame.evaluate(() => {
    const w = JSON.parse(bedrock.canvas.words_json())[0];
    bedrock.wordMenu.open(w);
    const shown = [...document.querySelectorAll('#wm-main button')].filter((b) => !b.hidden).map((b) => b.id);
    const reading = document.getElementById('wm-reading').textContent;
    document.getElementById('wm-correct').click();
    return { shown, reading };
  });
  assert.deepEqual(menu.shown, ['wm-copy-here', 'wm-right', 'wm-correct', 'wm-kind', 'wm-drawing']);
  assert.match(menu.reading, /Newtn/);
  await frame.fill('#wm-correct-text', 'Newton');
  await frame.press('#wm-correct-text', 'Enter');
  // The correction is saved, the ink as it was, and reaches search.
  await until(page, async () => (await host.files('Physics.bedrock')).index?.includes('Newton'));

  // Tags are added and removed; links are shown and open, but not added or removed.
  const info = await frame.evaluate(() => {
    bedrock.noteInfo.show();
    const root = document.getElementById('note-info');
    const visible = (el) => !el.hidden && !el.closest('[hidden]');
    const r = {
      tags: [...root.querySelectorAll('.ni-tag span')].map((s) => s.textContent),
      inputs: [...root.querySelectorAll('input')].filter(visible).map((i) => i.getAttribute('aria-label')),
      linkRemoves: root.querySelectorAll('.ni-link .ni-remove').length,
      browse: visible(root.querySelector('.ni-browse')),
    };
    root.querySelector('.ni-open').click();
    return r;
  });
  assert.deepEqual(info, { tags: ['#physics'], inputs: ['New tag'], linkRemoves: 0, browse: false });
  await until(page, () => host.calls.some((c) => c[0] === 'open' && c[1] === 'Lecture 3'));
  await frame.fill('#note-info .ni-tags + form input', 'exam');
  await frame.press('#note-info .ni-tags + form input', 'Enter');
  await frame.click('#note-info .ni-tag .ni-remove');
  await until(page, async () => JSON.stringify((await host.files('Physics.bedrock')).tags) === '["exam"]');
  await until(page, async () => (await host.files('Physics.bedrock')).index?.includes('tags: [bedrock, exam]'));
  assert.equal((await page.evaluate(() => host.files('Physics.bedrock'))).strokes, 4, 'the ink is as it was');
  assert.equal(await frame.evaluate(() => bedrock.canvas.stroke_count()), 4);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a note made on a computer about a page keeps its link, and is view only after that', async () => {
  const { page, ctx, errors } = await openHost();
  await page.evaluate(async () => {
    await host.vault.create('Lectures/Lecture 3.md', '# Lecture 3');
    // What "New handwritten note linking here" leaves for the canvas.
    host.starts.set('Lectures/Lecture 3 notes.bedrock', { noteLinks: [{ target: 'Lectures/Lecture 3', type: 'note', text: 'Lecture 3' }] });
  });
  const frame = await openFile(page, 'Lectures/Lecture 3 notes.bedrock', { viewOnly: true });
  // The link is saved at once, with no ink, as on the iPad.
  await until(page, () => host.vault.files.get('Lectures/Lecture 3 notes.bedrock').data.byteLength > 0);
  await until(page, async () => (await host.files('Lectures/Lecture 3 notes.bedrock')).index?.includes('[[Lectures/Lecture 3|'));
  const f = await page.evaluate(() => host.files('Lectures/Lecture 3 notes.bedrock'));
  assert.equal(f.strokes, 0);
  assert.deepEqual(f.noteLinks, [{ target: 'Lectures/Lecture 3', type: 'note', text: 'Lecture 3' }]);
  const before = await page.evaluate(() => Array.from(host.vault.files.get('Lectures/Lecture 3 notes.bedrock').data.slice(0)));
  // After that it is view only: the pen moves the page and nothing is saved.
  const after = await frame.evaluate(async () => {
    await t.line(300, 300, 400, 340, { id: 1, type: 'pen', pressure: 0.6, steps: 10 });
    await bedrock.saveNow();
    return { strokes: bedrock.canvas.stroke_count(), state: document.getElementById('save-state').textContent, toolbar: getComputedStyle(document.getElementById('toolbar')).display };
  });
  assert.deepEqual(after, { strokes: 0, state: 'View only', toolbar: 'none' });
  await page.evaluate(() => host.bridge.send('flush', {}, 3000));
  assert.deepEqual(await page.evaluate(() => Array.from(host.vault.files.get('Lectures/Lecture 3 notes.bedrock').data.slice(0))), before);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ---- Invite code and consent at start ----------------------------------------

const API = 'https://collect.test';
const CODE = 'bedrock-abcde-fghjk-mnpqr-stuvw-xyz23';

/** The harness with a server address built in and a pretend backend that
 *  takes `CODE`. */
async function openHostWithServer(state = null) {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 900 } });
  await ctx.addInitScript(([a, st]) => {
    const s = st || JSON.parse(localStorage.getItem('bedrock.collect.v1') || '{}');
    if (!s.api) localStorage.setItem('bedrock.collect.v1', JSON.stringify({ ...s, api: a }));
  }, [API, state]);
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
  await ctx.route(`${API}/**`, (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const ok = req.headers().authorization === `Bearer ${CODE}`;
    return route.fulfill({ status: ok ? 200 : 401, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(ok ? { samples: 0, accepted: [], refused: [] } : { error: 'code' }) });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.refused = await blockLikeObsidian(page);
  await page.goto(`http://127.0.0.1:${server.address().port}/obsidian/tests/harness.html`);
  await page.waitForFunction(() => window.host);
  return { page, ctx, errors };
}

test('at start, the plugin asks for the invite code and consent in a window, and closes it once agreed', async () => {
  const { page, ctx, errors } = await openHostWithServer();
  await page.evaluate(() => { window.launched = host.launch(); });
  await page.waitForSelector('#consent-window iframe');
  const welcome = await frameOf(page, '#consent-window iframe');
  await welcome.waitForFunction(() => document.getElementById('launch-gate')?.open);
  assert.equal(await welcome.getAttribute('#launch-gate a', 'href'), 'https://reelplum.github.io/Bedrock/terms/', 'inside Obsidian the terms open on the website');
  await welcome.fill('#gate-code', CODE);
  await welcome.check('#gate-agree');
  await welcome.click('#gate-go');
  assert.equal(await page.evaluate(() => window.launched), 'agreed');
  await page.waitForFunction(() => !document.getElementById('consent-window'));
  assert.equal(await page.evaluate(() => document.querySelectorAll('iframe.bedrock-welcome-frame').length), 0, 'the hidden page is gone too');
  const s = await page.evaluate(() => ({ c: JSON.parse(localStorage.getItem('bedrock.collect.v1')), set: JSON.parse(localStorage.getItem('bedrock.settings.v1')) }));
  assert.equal(s.c.consent, 3);
  assert.equal(s.c.code, CODE);
  assert.equal(s.set.shareWords, true);
  // A note opened now has no gate over it.
  await openFile(page, 'Gate.bedrock');
  const frame = await frameOf(page, '#frame');
  assert.equal(await frame.evaluate(() => !!document.getElementById('launch-gate')), false);
  assert.deepEqual(page.refused, [], 'the welcome page loaded nothing from the plugin folder either');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('at start, nothing is shown when consent is already given', async () => {
  const state = { code: CODE, consent: 3, contributor: '5b0f2e4c-8a1d-4c3e-9f6a-2d7b1c0e4a99' };
  const { page, ctx, errors } = await openHostWithServer(state);
  assert.equal(await page.evaluate(() => host.launch()), 'not-needed');
  assert.equal(await page.evaluate(() => host.windows), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("the header shows the note's file name, and naming the note there renames the file", async () => {
  const { page, ctx, errors } = await openHost();
  await page.evaluate(() => host.vault.createFolder('Physics'));
  let frame = await openFile(page, 'Physics/Handwritten note.bedrock');
  assert.equal(await frame.inputValue('#title'), 'Handwritten note', 'a new note is named after its file');
  await writeWord(frame);
  // A title stored in the note that is not the file name (written elsewhere).
  await frame.evaluate(async () => { bedrock.canvas.set_title('Old title'); await bedrock.saveNow(); });
  assert.equal((await page.evaluate(() => host.files('Physics/Handwritten note.bedrock'))).title, 'Old title');
  frame = await openFile(page, 'Physics/Handwritten note.bedrock');
  assert.equal(await frame.inputValue('#title'), 'Handwritten note', 'the header shows the file name');
  await frame.evaluate(() => bedrock.saveNow());
  assert.equal((await page.evaluate(() => host.files('Physics/Handwritten note.bedrock'))).title, 'Handwritten note', 'the next save stores the file name');

  // Typing renames nothing; finishing the name renames the file once.
  await frame.fill('#title', 'Week 3: forces');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(await page.evaluate(() => host.vault.files.has('Physics/Handwritten note.bedrock')), 'not renamed while typing');
  await frame.press('#title', 'Enter');
  await until(page, () => host.vault.files.has('Physics/Week 3 forces.bedrock'));
  assert.equal(await frame.inputValue('#title'), 'Week 3 forces', 'the header shows the name the file got');
  assert.deepEqual(await page.evaluate(() => host.calls.filter((c) => c[0] === 'rename')), [['rename', 'Physics/Handwritten note.bedrock', 'Physics/Week 3 forces.bedrock']]);
  await frame.evaluate(() => bedrock.saveNow());
  const f = await page.evaluate(() => host.files('Physics/Week 3 forces.bedrock'));
  assert.equal(f.title, 'Week 3 forces', 'the stored title follows');
  assert.match(f.index, /^---\nbedrock: "Physics\/Week 3 forces.bedrock"/, 'the index note followed');

  // A name another file has: the file keeps its name, and so does the header.
  await page.evaluate(() => host.vault.createBinary('Physics/Motion.bedrock', new ArrayBuffer(0)));
  await frame.fill('#title', 'Motion');
  await frame.press('#title', 'Enter');
  await until(frame, () => document.getElementById('title').value === 'Week 3 forces');
  assert.ok(await page.evaluate(() => host.vault.files.has('Physics/Week 3 forces.bedrock')));
  assert.equal(await frame.evaluate(() => bedrock.canvas.title()), 'Week 3 forces');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('renaming the file in Obsidian puts the new name in the header', async () => {
  const { page, ctx, errors } = await openHost();
  const frame = await openFile(page, 'Forces.bedrock');
  await writeWord(frame);
  await frame.evaluate(() => bedrock.saveNow());
  await page.evaluate(() => host.renameInObsidian('School/Motion.bedrock'));
  assert.equal(await frame.inputValue('#title'), 'Motion');
  await frame.evaluate(() => bedrock.saveNow());
  assert.equal((await page.evaluate(() => host.files('School/Motion.bedrock'))).title, 'Motion', 'the stored title follows');
  assert.deepEqual(errors, []);
  await ctx.close();
});
