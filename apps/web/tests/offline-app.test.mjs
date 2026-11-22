// Working with no connection: after one visit, the whole app (writing,
// saving, opening notes, the library) works offline, and handwriting is read
// offline once its model has been downloaded. "Offline" here is real: the
// app's server is shut down and the browser is set offline, so nothing can
// come from the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { startServer } from '../serve.mjs';
import { installPointerHelpers } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

let browser;
before(async () => {
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
});
after(async () => { await browser?.close(); });

/** The app's own server, which can be shut down. */
async function site() {
  const server = await startServer(0);
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    async down() {
      await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    },
    close() { if (server.listening) server.close(); server.closeAllConnections(); },
  };
}

async function open(page, url) {
  const errors = [];
  // Where each error came from goes to the log, so a failure on CI names it.
  page.on('pageerror', (e) => { errors.push(e.message); console.log(`page error: ${e.stack}`); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    errors.push(m.text());
    console.log(`console error: ${m.text()} at ${JSON.stringify(m.location())}`);
  });
  await page.goto(url);
  await page.waitForFunction(() => window.bedrock && window.bedrock.ready, null, { timeout: 20000 });
  await installPointerHelpers(page);
  return errors;
}

async function reload(page) {
  await page.reload();
  await page.waitForFunction(() => window.bedrock && window.bedrock.ready, null, { timeout: 20000 });
  await installPointerHelpers(page);
}

/** Waits until the service worker controls the page and has kept every
 *  file of the app. */
async function waitForOfflineCopy(page) {
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 20000 });
  await page.waitForFunction(async () => (await caches.keys()).some((k) => /^bedrock-v\d+$/.test(k)), null, { timeout: 20000 });
}

/** Writes one stroke at `y`. */
async function stroke(page, y) {
  await page.evaluate(async (y) => {
    t.ev('pointerdown', 1, 'pen', 200, y, { pressure: 0.6 });
    for (let j = 1; j <= 10; j++) t.ev('pointermove', 1, 'pen', 200 + j * 8, y + (j % 2) * 6, { pressure: 0.6 });
    t.ev('pointerup', 1, 'pen', 290, y, { pressure: 0 });
    await t.frame();
  }, y);
}

test('with no connection the app opens, and notes are written, saved, listed and opened again', { timeout: 120_000 }, async (t) => {
  const s = await site();
  // Closed even when the test fails, or the open server keeps the test run alive.
  t.after(() => s.close());
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  t.after(() => ctx.close().catch(() => {}));
  const page = await ctx.newPage();
  const errors = await open(page, s.url);
  await waitForOfflineCopy(page);
  await stroke(page, 300);
  await page.evaluate(() => bedrock.saveNow());
  const id = await page.evaluate(() => bedrock.noteId);

  await s.down();
  await ctx.setOffline(true);
  await reload(page);
  const r1 = await page.evaluate(() => ({ id: bedrock.noteId, strokes: bedrock.canvas.stroke_count(), online: navigator.onLine }));
  assert.deepEqual(r1, { id, strokes: 1, online: false }, 'the last note opens offline');
  // Writing and saving offline, in the background saver too.
  await stroke(page, 400);
  await page.evaluate(() => bedrock.saveNow());
  assert.equal(await page.textContent('#save-state').catch(() => 'Saved'), 'Saved');
  // A new note, then the first one again from the library.
  const before = await page.evaluate(async () => (await bedrock.store.list()).length);
  await page.evaluate(() => bedrock.newNote());
  await stroke(page, 200);
  await page.evaluate(() => bedrock.saveNow());
  const listed = await page.evaluate(async () => (await bedrock.store.list()).length);
  assert.equal(listed, before + 1, 'the new note is in the library');
  await page.evaluate((id) => bedrock.openNote(id), id);
  assert.equal(await page.evaluate(() => bedrock.canvas.stroke_count()), 2, 'the stroke written offline was saved');
  await reload(page);
  assert.equal(await page.evaluate(() => typeof bedrock.backgroundSaving), 'boolean');
  assert.equal(await page.evaluate(() => bedrock.handwriting.dictionaryReady), true, 'the spell checker loads offline');
  assert.deepEqual(errors.filter((e) => !/net::ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e)), []);
  await ctx.close();
});

test('handwriting is read offline once its model was downloaded', { timeout: 120_000 }, async (t) => {
  // The real Transformers.js and its ONNX Runtime, from the "CDN", and a
  // tiny formula model with the real file names (see app.test.mjs).
  const { TRANSFORMERS_JS } = await import('./fetch-libs.mjs');
  const s = await site();
  // Closed even when the test fails, or the open server keeps the test run alive.
  t.after(() => s.close());
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  t.after(() => ctx.close().catch(() => {}));
  const asked = [];
  await ctx.route('https://cdn.jsdelivr.net/npm/onnxruntime-web@*/dist/**', async (route) => {
    const file = new URL(route.request().url()).pathname.split('/').pop();
    asked.push(file);
    route.fulfill({ body: await readFile(new URL(`../node_modules/onnxruntime-web/dist/${file}`, import.meta.url)), contentType: file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
  });
  await ctx.route('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1', async (route) => {
    asked.push('transformers');
    route.fulfill({ body: await readFile(TRANSFORMERS_JS), contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
  });
  await ctx.route('https://huggingface.co/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    asked.push(path);
    const m = path.match(/^\/breezedeus\/pix2text-mfr-1\.5\/resolve\/main\/+(.+)$/);
    try {
      if (!m) throw new Error('not here');
      route.fulfill({ body: await readFile(new URL(`./fixtures/mfr/${m[1]}`, import.meta.url)), contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } });
    } catch (_) { route.fulfill({ status: 404, body: 'not found', headers: { 'access-control-allow-origin': '*' } }); }
  });
  const page = await ctx.newPage();
  await open(page, s.url);
  await waitForOfflineCopy(page);
  const read = () => page.evaluate(async () => {
    const c = new OffscreenCanvas(120, 80);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 120, 80);
    g.fillStyle = '#000'; g.fillRect(20, 38, 80, 4);
    const image = await c.convertToBlob({ type: 'image/png' });
    const hw = bedrock.handwriting;
    hw.engine = null;
    const r = await hw._engine()({ kind: 'math', image }).catch((e) => ({ error: e.message }));
    hw.dropWorker?.('all', 'test done');
    return r;
  });
  const online = await read();
  assert.ok(!online.error, online.error);
  assert.equal(online.text.replace(/\s/g, ''), '\\frac{a}{b}');

  // No connection at all from here on.
  await ctx.unrouteAll({ behavior: 'ignoreErrors' });
  const offlineAsked = [];
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|huggingface\.co)\//, (route) => { offlineAsked.push(route.request().url()); route.abort('internetdisconnected'); });
  await s.down();
  await ctx.setOffline(true);
  await reload(page);
  const offline = await read();
  assert.ok(!offline.error, `read offline: ${offline.error} (asked the network for ${offlineAsked})`);
  assert.equal(offline.text.replace(/\s/g, ''), '\\frac{a}{b}');
  await ctx.close();
});

test('offline without the model, words wait (not given up) and are read when the connection is back', { timeout: 120_000 }, async (t) => {
  const s = await site();
  // Closed even when the test fails, or the open server keeps the test run alive.
  t.after(() => s.close());
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  t.after(() => ctx.close().catch(() => {}));
  const page = await ctx.newPage();
  const errors = await open(page, s.url);
  await page.evaluate(() => {
    bedrock.minimap.visible = false;
    // A recogniser whose model is not on the device: it needs the network.
    bedrock.handwriting.engine = async () => {
      if (!navigator.onLine) throw new Error('Failed to fetch');
      return { text: 'hello', engine: 'fake' };
    };
  });
  // Offline after one visit: going offline while the service worker is
  // still downloading the app fails its install ("Failed to fetch"), which
  // a slow CI runner showed.
  await waitForOfflineCopy(page);
  await ctx.setOffline(true);
  const word = async () => {
    for (let k = 0; k < 4; k++) {
      const x = 150 + k * 22;
      await page.evaluate((x) => {
        t.ev('pointerdown', 1, 'pen', x, 300, { pressure: 0.6 });
        for (let j = 1; j <= 8; j++) t.ev('pointermove', 1, 'pen', x + j * 2, 300 - (j % 2) * 26, { pressure: 0.6 });
        t.ev('pointerup', 1, 'pen', x + 16, 300, { pressure: 0 });
      }, x);
    }
  };
  await word();
  const r = await page.evaluate(async () => {
    const hw = bedrock.handwriting;
    // Three passes: a failure offline is not counted, so it is never given up.
    for (let i = 0; i < 3; i++) await hw.run();
    const words = JSON.parse(bedrock.canvas.words_json());
    return {
      texts: words.map((w) => w.text ?? null),
      status: words.map((w) => hw.status.get(w.id)),
      toast: document.getElementById('toast').textContent,
      problem: !!hw.errorShown,
    };
  });
  assert.deepEqual(r.texts, [null]);
  assert.deepEqual(r.status, ['Waiting for a connection to download the handwriting model']);
  assert.match(r.toast, /No connection, so handwriting is read once you are back online/);
  assert.equal(r.problem, false, 'no "not available" error');

  await ctx.setOffline(false); // the browser says "online"
  await page.waitForFunction(() => JSON.parse(bedrock.canvas.words_json())[0]?.text === 'hello', null, { timeout: 5000 });
  assert.deepEqual(errors, []);
  await ctx.close();
});
