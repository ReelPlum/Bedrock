// The service worker: after an update, every file comes from the new
// version, even though the host lets browsers keep files for a while.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { withoutBuiltInApi } from './helpers.mjs';
const ROOT = new URL('../', import.meta.url);

let server, browser, url;
let version = 1;
before(async () => {
  // Like GitHub Pages: files may be kept for 10 minutes.
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/page/') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'max-age=600' });
      return res.end(`<!doctype html><title>v${version}</title><p id="v">${version}</p>`);
    }
    if (path === '/changing.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'max-age=600' });
      return res.end(`export const version = ${version};\n`);
    }
    try {
      const body = await readFile(new URL(`.${path.endsWith('/') ? `${path}index.html` : path}`, ROOT));
      res.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/html', 'cache-control': 'max-age=600' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/`;
  browser = withoutBuiltInApi(await chromium.launch());
});
after(async () => { await browser?.close(); server?.close(); });

test('the service worker checks files with the server instead of using a copy the browser kept', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url + 'icons/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const get = () => page.evaluate(async () => (await (await fetch('/changing.js')).text()).trim());
  assert.equal(await get(), 'export const version = 1;');
  version = 2; // an update goes live
  assert.equal(await get(), 'export const version = 2;');
  await ctx.close();
});

// The bug: the page (index.html) came from the browser's copy while its
// scripts came fresh from the server, so a new main.js looked for a button
// the old page did not have ("$('wm-duplicate') is null") and Bedrock
// failed to start after the Duplicate update.
test('after an update the page itself comes from the server too, so it never mixes with newer scripts', async () => {
  version = 1;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url + 'icons/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.goto(url + 'page/');
  assert.equal(await page.textContent('#v'), '1');
  version = 2; // an update goes live
  await page.goto(url + 'icons/');
  await page.goto(url + 'page/');
  assert.equal(await page.textContent('#v'), '2', 'the new page, not the one the browser kept');
  await ctx.close();
});

/** A page of the test site with the service worker in control. */
async function controlled(ctx) {
  const page = await ctx.newPage();
  await page.goto(url + 'icons/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  return page;
}

// The bug: on every update the service worker deleted every cache of the
// site, Transformers.js's `transformers-cache` too, so the handwriting
// models (hundreds of MB) were downloaded again and reading stopped working
// offline after each update.
test('an update keeps the handwriting models Transformers.js downloaded, and clears only old copies of the app (regression)', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url + 'icons/');
  await page.evaluate(async () => {
    await (await caches.open('transformers-cache')).put('https://huggingface.co/x/resolve/main/model.onnx', new Response('model'));
    await (await caches.open('bedrock-v1')).put('/old.js', new Response('old'));
  });
  await page.close();
  const app = await controlled(ctx);
  const keys = await app.evaluate(() => caches.keys());
  assert.ok(keys.includes('transformers-cache'), `the models are kept: ${keys}`);
  assert.ok(!keys.includes('bedrock-v1'), `an old copy of the app is cleared: ${keys}`);
  assert.equal(await app.evaluate(async () => (await (await caches.open('transformers-cache')).match('https://huggingface.co/x/resolve/main/model.onnx'))?.text()), 'model');
  await ctx.close();
});

test('offline, a page opens the app but a missing file is not answered with the page', async () => {
  const ctx = await browser.newContext();
  const page = await controlled(ctx);
  await ctx.setOffline(true);
  const missing = await page.evaluate(async () => {
    try {
      const res = await fetch('/models/Xenova/trocr-small-handwritten/config.json');
      return `answered ${res.status} ${res.headers.get('content-type')}`;
    } catch (_) { return 'failed'; }
  });
  assert.equal(missing, 'failed', 'Transformers.js must not read the app page as a model file');
  await page.goto(url + 'a/page/never/seen/');
  assert.match(await page.title(), /Bedrock/, 'a page still opens the app offline');
  await ctx.close();
});

test('the recogniser library from the CDN is kept by the service worker and works offline', async () => {
  const ctx = await browser.newContext();
  const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';
  let served = 0;
  await ctx.route(LIB, (route) => {
    served++;
    route.fulfill({ body: 'export const lib = 1;\n', contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
  });
  const page = await controlled(ctx);
  const get = () => page.evaluate(async (u) => {
    try { return (await (await fetch(u)).text()).trim(); } catch (_) { return 'failed'; }
  }, LIB);
  assert.equal(await get(), 'export const lib = 1;');
  await ctx.unroute(LIB);
  await ctx.route(LIB, (route) => route.abort('internetdisconnected'));
  await ctx.setOffline(true);
  assert.equal(await get(), 'export const lib = 1;', 'served from the service worker offline');
  assert.equal(served, 1, 'fetched once');
  await ctx.close();
});
