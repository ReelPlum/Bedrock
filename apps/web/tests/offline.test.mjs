// The service worker: after an update, every file comes from the new
// version, even though the host lets browsers keep files for a while.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
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
  browser = await chromium.launch();
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
