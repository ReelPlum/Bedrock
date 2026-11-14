// Saving training samples: consent, the queue on the device, sending, and
// feedback from notes. The backend is played by a route in the browser that
// records what it is sent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { launch, openApp, installPointerHelpers } from './helpers.mjs';

let env;
before(async () => { env = await launch(); });
after(async () => { await env?.close(); });

const API = 'https://collect.test';
const CODE = 'bedrock-abcde-fghjk-mnpqr-stuvw-xyz23';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };

/** A pretend backend. `answer(request)` may return `{ status, body }`,
 *  'abort' (no connection), or nothing (accept everything). The training
 *  prompts it holds are `prompts` (or 'abort'). */
async function fakeBackend(ctx) {
  const server = { requests: [], answer: null, prompts: { words: [], sentences: [], paragraphs: [] } };
  await ctx.route(`${API}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const gzipped = req.headers()['content-encoding'] === 'gzip';
    const raw = req.postDataBuffer();
    const sent = raw ? JSON.parse((gzipped ? gunzipSync(raw) : raw).toString()) : null;
    const entry = { method: req.method(), path: new URL(req.url()).pathname, auth: req.headers().authorization, contributor: req.headers()['x-contributor'], gzipped, body: sent };
    server.requests.push(entry);
    const a = entry.path === '/v1/prompts'
      ? (server.prompts === 'abort' ? 'abort' : { body: server.prompts })
      : server.answer ? server.answer(entry) : null;
    if (a === 'abort') return route.abort();
    const body = a?.body ?? (entry.method === 'DELETE' ? { deleted: { samples: 3, paragraphs: 0 }, more: false } : { accepted: (entry.body?.samples || []).map((s) => s.id), refused: [] });
    return route.fulfill({ status: a?.status ?? 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  });
  return server;
}

/** The address is built into the app and cannot be changed on the page;
 *  a page served from this computer may use a stored one, which is how
 *  these tests point the app at the pretend backend. */
async function context({ address = API } = {}) {
  const ctx = await env.browser.newContext({ viewport: { width: 900, height: 800 } });
  // These tests are of sharing as an option: the launch gate (which makes
  // it part of using the app) is tested in launch-gate.test.mjs.
  await ctx.addInitScript(() => { window.bedrockNoLaunchGate = true; });
  if (address) {
    await ctx.addInitScript((a) => {
      const s = JSON.parse(localStorage.getItem('bedrock.collect.v1') || '{}');
      if (!s.api) localStorage.setItem('bedrock.collect.v1', JSON.stringify({ ...s, api: a }));
    }, address);
  }
  const server = await fakeBackend(ctx);
  return { ctx, server };
}

async function open(ctx, path, ready) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(env.url + path);
  await page.waitForFunction(ready, null, { timeout: 20000 });
  return { page, errors };
}
const openSetup = (ctx) => open(ctx, 'train/', () => window.setup?.ready);
/** Samples normally go up once a minute; most tests send at once. */
const sendAtOnce = (page) => page.evaluate(async () => (await import('/src/collect.js')).setSendInterval(0));
async function openTrainer(ctx, path = 'train/handwriting/', { wait = false } = {}) {
  const r = await open(ctx, path, () => window.trainer?.ready);
  await installPointerHelpers(r.page);
  if (!wait) await sendAtOnce(r.page);
  return r;
}

async function agree(page, { code = CODE, hand = 'left' } = {}) {
  await page.fill('#code', code);
  await page.selectOption('#handedness', hand);
  await page.check('#agree');
  await page.click('#save');
}

/** Writes two strokes in the trainer's box and taps Done. */
async function writeOne(page) {
  await page.evaluate(async () => {
    const box = document.getElementById('stage').getBoundingClientRect();
    await t.line(box.left + 100, box.top + 120, box.left + 300, box.top + 140);
    await t.line(box.left + 320, box.top + 110, box.left + 380, box.top + 160);
    document.getElementById('done').click();
  });
}
const waiting = (page) => page.evaluate(async () => (await (await import('/src/collect.js')).status()).waiting);
/** Waits until `fn` (run in the page, may be async) returns true. */
async function settle(page, fn) {
  for (let i = 0; i < 200; i++) {
    if (await page.evaluate(fn)) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`still not true after 10 s: ${fn}`);
}

test('ids, device class and the server address check', async () => {
  const { ctx } = await context();
  const { page } = await openSetup(ctx);
  const r = await page.evaluate(async () => {
    const c = await import('/src/collect.js');
    const a = c.uuidv7(1794421373000);
    const b = c.uuidv7(1794421373001);
    return {
      a, b, v4: c.uuidv4(), ordered: a < b,
      devices: [
        c.deviceClass('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', 5),
        c.deviceClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), // iPadOS says it is a Mac
        c.deviceClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0),
        c.deviceClass('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0),
        c.deviceClass('', 0),
      ],
      safe: ['https://x.workers.dev', 'http://127.0.0.1:8787', 'http://example.com', '', 'ftp://x'].map(c.isSafeApi),
      tag: c.shortTag('Xenova/trocr-small-handwritten (fake)', 80),
    };
  });
  assert.match(r.a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(r.a.slice(0, 13), '01a1cbd9-3848', 'the time is in the first 48 bits');
  assert.match(r.v4, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(r.ordered, true);
  assert.deepEqual(r.devices, ['ipad', 'ipad', 'mac', 'windows', 'other']);
  assert.deepEqual(r.safe, [true, true, false, false, false]);
  assert.equal(r.tag, 'Xenova/trocr-small-handwritten -fake-');
  await ctx.close();
});

test('a batch stays under the request size limit, but always takes at least one sample', async () => {
  const { ctx } = await context();
  const { page } = await openSetup(ctx);
  const r = await page.evaluate(async () => {
    const { fitBatch, BATCH_BYTES } = await import('/src/collect.js');
    const big = (id) => ({ id, strokes: [{ points: new Array(30_000).fill(123.45) }] }); // about 210 KB
    return { limit: BATCH_BYTES, two: fitBatch([big('a'), big('b'), big('c')]).map((s) => s.id), huge: fitBatch([{ id: 'x', pad: 'z'.repeat(600_000) }, big('y')]).map((s) => s.id), small: fitBatch([{ id: 1 }, { id: 2 }, { id: 3 }]).length };
  });
  assert.equal(r.limit, 400_000);
  assert.deepEqual(r.two, ['a']);
  assert.deepEqual(r.huge, ['x'], 'one sample alone is still tried');
  assert.equal(r.small, 3);
  await ctx.close();
});

test('without consent the pages are practice only: nothing is kept or sent', async () => {
  const { ctx, server } = await context();
  const { page, errors } = await openTrainer(ctx);
  await writeOne(page);
  await settle(page, () => document.getElementById('count').textContent === '1 done');
  assert.match(await page.textContent('#saving'), /Practice only: nothing is saved/);
  assert.equal(await waiting(page), 0);
  assert.equal(server.requests.length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('people cannot change the server address: there is no field, and only a page on this computer may use another', async () => {
  const { ctx } = await context({ address: null });
  const { page } = await openSetup(ctx);
  assert.equal(await page.$('#api'), null, 'no address field');
  assert.equal(await page.isDisabled('#save'), true, 'nothing to save to before the address is built in');
  assert.match(await page.textContent('#state'), /not available yet/);
  const r = await page.evaluate(async () => {
    const c = await import('/src/collect.js');
    return {
      site: c.apiAddress('https://someone-else.example', 'reelplum.github.io'),
      plugin: c.apiAddress('https://someone-else.example', ''),
      local: c.apiAddress('http://127.0.0.1:8787', '127.0.0.1'),
      built: c.DEFAULT_API,
      agreed: c.agree({ code: 'x', api: 'https://someone-else.example' }, { getItem: () => null, setItem() {} }).api,
    };
  });
  assert.equal(r.site, r.built, 'the site always uses the built-in address');
  assert.equal(r.plugin, r.built);
  assert.equal(r.local, 'http://127.0.0.1:8787');
  assert.notEqual(r.agreed, 'https://someone-else.example', 'agreeing cannot set it either');
  await ctx.close();
});

test('the consent card: no tick or no code saves nothing', async () => {
  const { ctx } = await context();
  const { page } = await openSetup(ctx);
  assert.match(await page.textContent('#state'), /^Off\./);
  await page.fill('#code', CODE);
  await page.click('#save');
  assert.match(await page.textContent('#setup-error'), /Tick the box/);
  await page.check('#agree');
  await page.fill('#code', '');
  await page.click('#save');
  assert.match(await page.textContent('#setup-error'), /invite code/);
  const s = await page.evaluate(async () => (await import('/src/collect.js')).loadState());
  assert.equal(s.consent, 0);
  assert.equal(s.contributor, '', 'no id is made before consent');
  await ctx.close();
});

test('after consent a sample is queued, sent with the code, and taken off the queue', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  await settle(setup.page, () => /^On\./.test(document.getElementById('state').textContent));

  const { page, errors } = await openTrainer(ctx);
  assert.match(await page.textContent('#saving'), /saved and sent/);
  await writeOne(page);
  await settle(page, async () => (await (await import('/src/collect.js')).status()).sent === 1);

  const posts = server.requests.filter((r) => r.path === '/v1/samples');
  assert.equal(posts.length, 1);
  const { auth, contributor, body } = posts[0];
  assert.equal(auth, `Bearer ${CODE}`);
  assert.match(contributor, /^[0-9a-f-]{36}$/);
  assert.equal(body.contributor.id, contributor);
  assert.equal(body.contributor.consent_version, 3);
  assert.equal(body.contributor.handedness, 'left');
  const s = body.samples[0];
  assert.deepEqual([s.format, s.version, s.source, s.label_source], ['bedrock-training', 2, 'train', 'prompt']);
  assert.ok(['text', 'math'].includes(s.kind));
  assert.ok(s.label.length > 0);
  assert.equal(s.language, s.kind === 'math' ? 'zxx' : 'en');
  assert.equal(s.pointer, 'pen');
  assert.equal(s.strokes.length, 2);
  assert.deepEqual(Object.keys(s.strokes[0]), ['start', 'points']);
  assert.ok(s.box.width > 0 && s.written > 1.7e12);
  assert.equal(JSON.stringify(body).includes('brush'), false);
  assert.equal(await waiting(page), 0);
  assert.equal(await page.textContent('#count'), '1 done');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('uploads are gzipped, and hold exactly the JSON the app would send plain', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  await settle(setup.page, () => /^On\./.test(document.getElementById('state').textContent));
  const { page, errors } = await openTrainer(ctx);
  await writeOne(page);
  await settle(page, async () => (await (await import('/src/collect.js')).status()).sent === 1);
  const posts = server.requests.filter((r) => r.path === '/v1/samples');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].gzipped, true);
  assert.equal(posts[0].body.samples.length, 1);
  // gzip gives back the text it was given, byte for byte.
  const text = JSON.stringify({ a: 'ü', n: [1.25, -0.5] });
  const back = await page.evaluate(async (t) => {
    const { gzipText } = await import('/src/collect.js');
    const z = await gzipText(t);
    return new Response(new Blob([z]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  }, text);
  assert.equal(back, text);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a backend that cannot read gzip gets the same batch as plain JSON, and plain JSON from then on', async () => {
  const { ctx, server } = await context();
  // As the backend before gzip uploads: the gzip bytes are not JSON.
  server.answer = (e) => (e.gzipped ? { status: 400, body: { error: 'bad_json' } } : null);
  const setup = await openSetup(ctx);
  await agree(setup.page);
  await settle(setup.page, () => /^On\./.test(document.getElementById('state').textContent));
  const { page, errors } = await openTrainer(ctx);
  await writeOne(page);
  await settle(page, async () => (await (await import('/src/collect.js')).status()).sent === 1);
  await writeOne(page);
  await settle(page, async () => (await (await import('/src/collect.js')).status()).sent === 2);
  const posts = server.requests.filter((r) => r.path === '/v1/samples');
  assert.deepEqual(posts.map((p) => p.gzipped), [true, false, false]);
  assert.deepEqual(posts[1].body, posts[0].body, 'the same batch, plain');
  assert.equal(await waiting(page), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the training page uses the words, sentences and paragraphs set on the backend, and keeps them for offline use', async () => {
  const { ctx, server } = await context();
  const lists = {
    words: ['kage', 'Aarhus'],
    sentences: ['Vi ses i morgen.'],
    paragraphs: ['En lang dag med regn og vind, men vi kom hjem til sidst og drak varm te i køkkenet.'],
  };
  server.prompts = lists;
  const setup = await openSetup(ctx);
  // Practice only (no consent): nothing is asked for and the built-in lists are used.
  const before = await openTrainer(ctx);
  await before.page.evaluate(() => trainer.promptsLoaded);
  assert.equal(server.requests.filter((r) => r.path === '/v1/prompts').length, 0);
  assert.equal(await before.page.evaluate(async () => (await import('/train/prompts.js')).lists().fromBackend.sentences), false);
  await before.page.close();

  await agree(setup.page);
  await settle(setup.page, () => /^On\./.test(document.getElementById('state').textContent));
  const draw = async (page) => page.evaluate(async () => {
    await trainer.promptsLoaded;
    const p = await import('/train/prompts.js');
    const seen = (make) => [...new Set(Array.from({ length: 60 }, () => make().text))].sort();
    return { words: seen(p.wordPrompt), sentences: seen(p.sentencePrompt), paragraphs: seen(p.paragraphPrompt), scribble: seen(p.scribblePrompt), from: p.lists().fromBackend };
  });
  const { page, errors } = await openTrainer(ctx);
  const r = await draw(page);
  const get = server.requests.find((q) => q.path === '/v1/prompts');
  assert.equal(get.method, 'GET');
  assert.equal(get.auth, `Bearer ${CODE}`, 'asked for with the invite code');
  assert.deepEqual(r.from, { words: true, sentences: true, paragraphs: true });
  assert.deepEqual(r.sentences, ['Vi ses i morgen.']);
  assert.equal(r.paragraphs.length, 1);
  assert.ok(r.paragraphs[0].split('\n').length >= 3 && r.paragraphs[0].split('\n').every((l) => l.length <= 32), 'wrapped into short lines');
  assert.equal(r.paragraphs[0].replace(/\n/g, ' '), lists.paragraphs[0]);
  // Words keep their variations; "Aarhus" is a name and is not changed.
  const known = new Set(['kage', 'Kage', 'Aarhus', 'kage kage', 'kage?', 'kage!']);
  assert.ok(r.words.filter((w) => !/^[\d/%]+$/.test(w)).every((w) => known.has(w)), r.words.join(', '));
  assert.ok(r.scribble.every((w) => w === 'kage' || w === 'kage kage'));
  assert.deepEqual(errors, []);
  await page.close();

  // No connection: the list fetched last time is still used.
  server.prompts = 'abort';
  const offline = await openTrainer(ctx);
  assert.deepEqual((await draw(offline.page)).sentences, ['Vi ses i morgen.']);
  await offline.page.close();

  // Emptied on the backend: back to the built-in lists.
  server.prompts = { words: [], sentences: [], paragraphs: [] };
  const emptied = await openTrainer(ctx);
  const e = await draw(emptied.page);
  assert.deepEqual(e.from, { words: false, sentences: false, paragraphs: false });
  assert.ok(e.sentences.length > 5);
  await ctx.close();
});

test('samples wait for the next send, once a minute, or go at once when the page is hidden', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  const { page } = await openTrainer(ctx, 'train/handwriting/', { wait: true });
  await writeOne(page);
  await writeOne(page);
  await settle(page, () => /2 waiting to send/.test(document.getElementById('count').textContent));
  await page.waitForTimeout(500);
  assert.equal(server.requests.filter((r) => r.path === '/v1/samples').length, 0, 'not sent for every sample');
  assert.equal(await page.evaluate(async () => (await import('/src/collect.js')).SEND_EVERY_MS), 60_000);

  // The iPad may freeze a hidden page, so hiding it sends what is waiting.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await settle(page, async () => (await (await import('/src/collect.js')).status()).sent === 2);
  const posts = server.requests.filter((r) => r.path === '/v1/samples');
  assert.equal(posts.length, 1, 'both in one request');
  assert.equal(posts[0].body.samples.length, 2);
  await ctx.close();
});

test('with no connection samples wait on the device and are sent later, even after a reload', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  server.answer = () => 'abort';
  const { page } = await openTrainer(ctx);
  await writeOne(page);
  await writeOne(page);
  await settle(page, () => /2 waiting to send/.test(document.getElementById('count').textContent));
  assert.match(await page.textContent('#saving'), /No connection/);
  assert.equal(await waiting(page), 2);

  // A fresh page load (the queue is in IndexedDB), and the server is back.
  server.answer = null;
  await page.reload();
  await page.waitForFunction(() => window.trainer?.ready);
  await sendAtOnce(page);
  await settle(page, async () => { const st = await (await import('/src/collect.js')).status(); return st.waiting === 0 && st.sent === 2; });
  const sent = server.requests.filter((r) => r.path === '/v1/samples').at(-1).body.samples;
  assert.equal(sent.length, 2);
  await ctx.close();
});

test('a sample the server will never take is dropped; one it could not store is kept', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  server.answer = (r) => ({ body: { accepted: [], refused: [{ id: r.body.samples[0].id, code: 'storage', detail: 'try later' }] } });
  const { page } = await openTrainer(ctx);
  await writeOne(page);
  await settle(page, () => /1 waiting/.test(document.getElementById('count').textContent));
  await page.waitForTimeout(300);
  assert.equal(await waiting(page), 1, 'kept: storage failed');

  server.answer = (r) => ({ body: { accepted: [], refused: [{ id: r.body.samples[0].id, code: 'label', detail: 'label is missing' }] } });
  await page.evaluate(async () => (await import('/src/collect.js')).flush());
  assert.equal(await waiting(page), 0, 'dropped: it would be refused every time');
  assert.equal(await page.evaluate(async () => (await import('/src/collect.js')).loadState().sent), 0);
  await ctx.close();
});

test('a wrong invite code keeps the samples and says so', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  server.answer = () => ({ status: 401, body: { error: 'invite' } });
  const { page } = await openTrainer(ctx);
  await writeOne(page);
  await settle(page, () => /invite code was not accepted/.test(document.getElementById('saving').textContent));
  assert.equal(await waiting(page), 1);
  await ctx.close();
});

test('"Delete my contributions" asks the server to delete, empties the queue and turns saving off', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  server.answer = (r) => (r.method === 'POST' ? 'abort' : null);
  const { page } = await openTrainer(ctx);
  await writeOne(page);
  await settle(page, () => /1 waiting/.test(document.getElementById('count').textContent));

  setup.page.on('dialog', (d) => d.accept());
  await setup.page.click('#delete');
  await settle(setup.page, () => /Deleted 3 samples/.test(document.getElementById('state').textContent));
  const del = server.requests.find((r) => r.method === 'DELETE');
  assert.equal(del.path, '/v1/contributors/me');
  assert.equal(del.auth, `Bearer ${CODE}`);
  assert.match(del.contributor, /^[0-9a-f-]{36}$/);
  assert.equal(await waiting(setup.page), 0);
  const s = await setup.page.evaluate(async () => (await import('/src/collect.js')).loadState());
  assert.equal(s.consent, 0);
  await ctx.close();
});

// ---- Notes -----------------------------------------------------------------

/** Opens the app, writes a word at an out-of-the-way place and gives it a
 *  reading as the recogniser would. */
async function noteWithWord(ctx, reading = 'helo') {
  const { page, errors } = await openApp(env, { context: ctx });
  await sendAtOnce(page);
  await page.evaluate(async (text) => {
    bedrock.handwriting.enabled = false; // no model downloads in tests
    const box = document.getElementById('stage').getBoundingClientRect();
    await t.line(box.left + 400, box.top + 300, box.left + 430, box.top + 340);
    await t.line(box.left + 440, box.top + 300, box.left + 470, box.top + 340);
    const w = JSON.parse(bedrock.canvas.words_json())[0];
    bedrock.canvas.set_word_text(w.id, text, 'text', 'Xenova/trocr-small-handwritten (fake)', 0.8);
  }, reading);
  return { page, errors };
}

async function openMenu(page) {
  await page.evaluate(() => bedrock.wordMenu.open(JSON.parse(bedrock.canvas.words_json())[0]));
}

test('notes: "This is right" marks a reading as checked, and sends nothing while the setting is off', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  const { page, errors } = await noteWithWord(ctx);
  assert.equal(await page.isChecked('#share-words'), false, 'off unless turned on');
  await openMenu(page);
  assert.equal(await page.isVisible('#wm-right'), true);
  await page.click('#wm-right');
  const w = await page.evaluate(() => JSON.parse(bedrock.canvas.words_json())[0]);
  assert.deepEqual([w.text, w.engine], ['helo', 'user']);
  await openMenu(page);
  assert.equal(await page.isVisible('#wm-right'), false, 'already checked');
  await page.waitForTimeout(200);
  assert.equal(await waiting(page), 0);
  assert.equal(server.requests.length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('notes: the setting cannot be turned on before consent', async () => {
  const { ctx } = await context();
  const { page } = await noteWithWord(ctx);
  await page.evaluate(() => document.getElementById('share-words').click());
  assert.equal(await page.isChecked('#share-words'), false);
  assert.match(await page.textContent('#toast'), /Train page first/);
  assert.equal(await page.evaluate(() => bedrock.settings.shareWords), false);
  await ctx.close();
});

test('notes: with the setting on, a confirmed word is sent as its line, moved to 0,0', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  const { page, errors } = await noteWithWord(ctx);
  await page.evaluate(() => document.getElementById('share-words').click());
  assert.equal(await page.evaluate(() => bedrock.settings.shareWords), true);
  // A second word elsewhere must not be sent with it.
  await page.evaluate(async () => {
    const box = document.getElementById('stage').getBoundingClientRect();
    await t.line(box.left + 100, box.top + 600, box.left + 160, box.top + 640);
  });
  await openMenu(page);
  await page.click('#wm-right');
  await settle(page, async () => (await (await import('/src/collect.js')).status()).sent === 1);
  const s = server.requests.find((r) => r.path === '/v1/samples').body.samples[0];
  assert.deepEqual([s.version, s.source, s.kind, s.label, s.label_source], [3, 'note', 'text', 'helo', 'confirmed']);
  assert.deepEqual(s.words, [{ strokes: [0, 1], kind: 'text', label: 'helo', label_source: 'confirmed', model_reading: 'helo' }]);
  assert.equal(s.model_engine, 'Xenova/trocr-small-handwritten -fake-');
  assert.equal(s.strokes.length, 2, 'only the word that was confirmed');
  const n = s.channels.length;
  const xs = s.strokes.flatMap((k) => k.points.filter((_, i) => i % n === s.channels.indexOf('x')));
  const ys = s.strokes.flatMap((k) => k.points.filter((_, i) => i % n === s.channels.indexOf('y')));
  assert.equal(Math.min(...xs), 0);
  assert.equal(Math.min(...ys), 0);
  assert.ok(Math.max(...xs) < 120 && Math.max(...ys) < 80, 'the size of one word, not its place on the page');
  assert.deepEqual(Object.keys(s.strokes[0]), ['start', 'points']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("notes: a correction is sent with the writer's text as the label and the reading alongside", async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  const { page } = await noteWithWord(ctx);
  await page.evaluate(() => document.getElementById('share-words').click());
  await openMenu(page);
  await page.click('#wm-correct');
  await page.fill('#wm-correct-text', 'hello');
  await page.press('#wm-correct-text', 'Enter');
  await settle(page, async () => (await (await import('/src/collect.js')).status()).sent === 1);
  const s = server.requests.find((r) => r.path === '/v1/samples').body.samples[0];
  assert.deepEqual([s.label, s.label_source, s.words[0].model_reading], ['hello', 'corrected', 'helo']);

  // Correcting it again has no model reading to report: the old text was
  // the writer's own.
  await openMenu(page);
  await page.click('#wm-correct');
  await page.fill('#wm-correct-text', 'Hello');
  await page.press('#wm-correct-text', 'Enter');
  await settle(page, async () => (await (await import('/src/collect.js')).status()).sent === 2);
  const again = server.requests.filter((r) => r.path === '/v1/samples').at(-1).body.samples[0];
  assert.deepEqual([again.label, again.label_source, again.words[0].model_reading], ['Hello', 'corrected', undefined]);
  assert.deepEqual(again.supersedes, [s.id], 'replaces the first correction of the same ink');
  await ctx.close();
});

const sentSamples = (server) => server.requests.filter((r) => r.path === '/v1/samples').flatMap((r) => r.body.samples);

/** Turns "Send every word" on, then writes one word and gives it a reading. */
async function newWordWithSettingOn(ctx, reading = 'helo') {
  const { page, errors } = await openApp(env, { context: ctx });
  await sendAtOnce(page);
  await page.evaluate(() => { bedrock.handwriting.enabled = false; bedrock.wordSharer.settleMs = 0; document.getElementById('share-words').click(); });
  assert.equal(await page.evaluate(() => bedrock.settings.shareWords), true);
  await page.evaluate(async (text) => {
    const box = document.getElementById('stage').getBoundingClientRect();
    await t.line(box.left + 400, box.top + 300, box.left + 430, box.top + 340);
    await t.line(box.left + 440, box.top + 300, box.left + 470, box.top + 340);
    if (text != null) {
      const w = JSON.parse(bedrock.canvas.words_json())[0];
      bedrock.canvas.set_word_text(w.id, text, 'text', 'Xenova/trocr-small-handwritten (fake)', 0.8);
    }
  }, reading);
  return { page, errors };
}

test('notes: with "Send every word" on, a new word is sent unchecked, then replaced when the writer checks it', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  const { page, errors } = await newWordWithSettingOn(ctx);

  assert.equal(await page.evaluate(() => bedrock.wordSharer.scan()), 1);
  assert.equal(await page.evaluate(() => bedrock.wordSharer.scan()), 0, 'sent once');
  await settle(page, async () => (await (await import('/src/collect.js')).status()).sent === 1);
  const [first] = sentSamples(server);
  assert.deepEqual([first.version, first.source, first.kind, first.label, first.label_source, first.words[0].model_reading], [3, 'note', 'text', 'helo', 'unchecked', 'helo']);
  assert.equal(first.supersedes, undefined);

  // A new reading from the recogniser replaces the unchecked one.
  await page.evaluate(() => { const w = JSON.parse(bedrock.canvas.words_json())[0]; bedrock.canvas.set_word_text(w.id, 'hello', 'text', 'Xenova/trocr-base-handwritten (fake)', 0.9); });
  assert.equal(await page.evaluate(() => bedrock.wordSharer.scan()), 1);

  // "This is right" sends a checked copy that replaces it.
  await openMenu(page);
  await page.click('#wm-right');
  await settle(page, async () => (await (await import('/src/collect.js')).status()).sent === 3);
  const [, second, third] = sentSamples(server);
  assert.deepEqual([second.label, second.label_source, second.supersedes], ['hello', 'unchecked', [first.id]]);
  assert.deepEqual([third.label, third.label_source, third.supersedes], ['hello', 'confirmed', [second.id]]);

  // An unchecked reading never replaces a checked one.
  assert.equal(await page.evaluate(() => bedrock.wordSharer.scan({ force: true })), 0);

  // "Not a word" replaces it again, as a drawing with no text.
  await openMenu(page);
  await page.click('#wm-drawing');
  await settle(page, async () => (await (await import('/src/collect.js')).status()).sent === 4);
  const fourth = sentSamples(server)[3];
  assert.deepEqual([fourth.kind, fourth.label, fourth.label_source, fourth.supersedes], ['text', '', 'corrected', [third.id]]);
  assert.deepEqual([fourth.words[0].kind, fourth.words[0].label], ['drawing', '']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('notes: two words written on one line are sent as one line, cut into its words', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  const { page, errors } = await newWordWithSettingOn(ctx, null);
  const words = await page.evaluate(async () => {
    const box = document.getElementById('stage').getBoundingClientRect();
    await t.line(box.left + 530, box.top + 300, box.left + 560, box.top + 340);
    await t.line(box.left + 570, box.top + 300, box.left + 600, box.top + 340);
    const ws = JSON.parse(bedrock.canvas.words_json());
    ws.forEach((w, k) => bedrock.canvas.set_word_text(w.id, ['to', 'gether'][k], 'text', 'Xenova/trocr-small-handwritten (fake)', 0.8));
    return ws.map((w) => w.line);
  });
  assert.deepEqual(words, [0, 0], 'two words on the same line');
  assert.equal(await page.evaluate(() => bedrock.wordSharer.scan()), 1);
  await settle(page, async () => (await (await import('/src/collect.js')).status()).sent === 1);
  const [s] = sentSamples(server);
  assert.deepEqual([s.version, s.label, s.strokes.length], [3, 'to gether', 4]);
  assert.deepEqual(s.words.map((w) => [w.label, w.strokes]), [['to', [0, 1]], ['gether', [2, 3]]]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

/** A two page PDF like a GoodNotes export: every stroke a filled outline
 *  of short pieces, and the handwriting's reading as invisible text placed
 *  with a large offset. Page 1: a word of three strokes read as "hi", and
 *  one read as "ok". Page 2: one stroke the PDF has no reading for. */
function goodnotesLikePdf() {
  const stroke = (x, y) => {
    let c = '';
    for (const [a, b] of [[[x, y], [x + 5, y + 10]], [[x + 5, y + 10], [x + 10, y + 20]]]) {
      c += `${a[0]} ${a[1]} m ${b[0]} ${b[1]} l ${b[0] + 2} ${b[1]} l ${a[0] + 2} ${a[1]} l h `;
    }
    return `${c}f\n`;
  };
  const page1 = '0.1 0.1 0.1 sc\n' + stroke(100, 300) + stroke(115, 300) + stroke(130, 300) + stroke(300, 300)
    + '3 Tr q 1 0 0 1 5100 5302 cm BT 20 0 0 20 0 0 Tm /F1 1 Tf (hi) Tj ET Q\n'
    + 'q 1 0 0 1 5300 5302 cm BT 20 0 0 20 0 0 Tm /F1 1 Tf (ok) Tj ET Q\n';
  const page2 = '0 0 1 sc\n' + stroke(200, 200);
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /MediaBox [0 0 600 400] >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    `<< /Length ${page1.length} >>\nstream\n${page1}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>',
    `<< /Length ${page2.length} >>\nstream\n${page2}\nendstream`,
  ];
  const text = `%PDF-1.4\n${objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join('')}trailer << /Root 1 0 R >>\n%%EOF\n`;
  return [...text].map((c) => c.charCodeAt(0));
}

test("importing a PDF: each page becomes a note, and every line is sent with the PDF's reading", async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  const { page, errors } = await openApp(env, { context: ctx });
  await sendAtOnce(page);
  await page.evaluate(() => { bedrock.handwriting.enabled = false; });
  assert.equal(await page.evaluate(() => bedrock.settings.shareWords), false, '"Send every word" is off: importing sends anyway');
  const pages = await page.evaluate(async (bytes) => bedrock.importPdf({ name: 'Lecture 7.pdf', bytes: new Uint8Array(bytes) }), goodnotesLikePdf());
  assert.equal(pages, 2);
  await settle(page, async () => (await (await import('/src/collect.js')).status()).sent === 3);
  const notes = await page.evaluate(async () => (await bedrock.store.list()).map((n) => n.title).sort());
  assert.deepEqual(notes.filter((t) => t.startsWith('Lecture')), ['Lecture 7 (page 1)', 'Lecture 7 (page 2)']);
  assert.equal(await page.evaluate(() => bedrock.canvas.stroke_count()), 1, 'the last page is open');
  const samples = sentSamples(server).sort((a, b) => a.label.localeCompare(b.label));
  // "hi" and "ok" are far apart, so the layout puts them on lines of their own.
  assert.deepEqual(samples.map((s) => [s.version, s.source, s.label, s.label_source, s.model_engine ?? null, s.strokes.length]), [
    [3, 'note', '', 'unchecked', null, 1],
    [3, 'note', 'hi', 'unchecked', 'pdf-text', 3],
    [3, 'note', 'ok', 'unchecked', 'pdf-text', 1],
  ]);
  assert.deepEqual(samples[1].words, [{ strokes: [0, 1, 2], kind: 'text', label: 'hi', label_source: 'unchecked', model_reading: 'hi' }]);
  // Imported again later (or opened with the setting on), nothing is sent twice.
  assert.equal(await page.evaluate(() => bedrock.wordSharer.scan({ imported: true })), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('importing a PDF without saving set up keeps it on the device', async () => {
  const { ctx, server } = await context();
  const { page, errors } = await openApp(env, { context: ctx });
  await page.evaluate(() => { bedrock.handwriting.enabled = false; });
  const pages = await page.evaluate(async (bytes) => bedrock.importPdf({ name: 'x.pdf', bytes: new Uint8Array(bytes) }), goodnotesLikePdf());
  assert.equal(pages, 2);
  await page.evaluate(async () => (await import('/src/collect.js')).flush());
  assert.equal(server.requests.filter((r) => r.path === '/v1/samples').length, 0);
  const words = await page.evaluate(() => JSON.parse(bedrock.canvas.words_json()).map((w) => [w.text, w.engine]));
  assert.deepEqual(words, [[null, null]], 'page 2 has no reading');
  assert.equal(await page.evaluate(() => bedrock.handwriting.isCareful({ text: 'hi', engine: 'pdf-text', kind: 'text' })), true, 'a reading from the PDF is not redone');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('consent given to an older consent text is asked for again', async () => {
  const { ctx } = await context();
  const { page } = await openSetup(ctx);
  const r = await page.evaluate(async () => {
    const c = await import('/src/collect.js');
    const s = c.agree({ code: 'x' });
    return { now: c.isReady(s), old: c.isReady({ ...s, consent: 2 }), older: c.isReady({ ...s, consent: 1 }), version: c.CONSENT_VERSION };
  });
  assert.deepEqual(r, { now: true, old: false, older: false, version: 3 });
  await ctx.close();
});

test('notes: an unchecked reading waits until it settles, and is sent at once when the app is hidden', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  const { page } = await newWordWithSettingOn(ctx);
  await page.evaluate(() => { bedrock.wordSharer.settleMs = 60_000; });
  assert.equal(await page.evaluate(() => bedrock.wordSharer.scan()), 0, 'still settling');
  assert.equal(await page.evaluate(() => bedrock.wordSharer.scan({ force: true })), 1);
  await settle(page, async () => (await (await import('/src/collect.js')).status()).sent === 1);
  assert.equal(sentSamples(server)[0].label_source, 'unchecked');
  await ctx.close();
});

test('notes: words written before the setting was on are not sent by themselves', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  const { page } = await noteWithWord(ctx);
  await page.evaluate(() => { bedrock.wordSharer.settleMs = 0; document.getElementById('share-words').click(); });
  assert.equal(await page.evaluate(() => bedrock.wordSharer.scan({ force: true })), 0);
  await page.waitForTimeout(200);
  assert.equal(server.requests.length, 0);
  await ctx.close();
});

test('notes: with the recogniser off, words are sent without text', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  const { page } = await newWordWithSettingOn(ctx, null);
  assert.equal(await page.evaluate(() => bedrock.wordSharer.scan()), 0, 'waits for a reading while the recogniser is on');
  await page.evaluate(() => { bedrock.settings.recognize = false; });
  assert.equal(await page.evaluate(() => bedrock.wordSharer.scan()), 1);
  await settle(page, async () => (await (await import('/src/collect.js')).status()).sent === 1);
  const [s] = sentSamples(server);
  assert.deepEqual([s.label, s.label_source], ['', 'unchecked']);
  await ctx.close();
});

test('a page that tried to send before consent sends once consent is given, without a reload', async () => {
  // Bug: flush() before consent finished at once, before it was stored as
  // the flush in progress, so every later flush() on that page waited on
  // it and sent nothing.
  const { ctx, server } = await context();
  const { page } = await openSetup(ctx);
  await page.evaluate(async () => {
    const c = await import('/src/collect.js');
    await c.flush(); // not ready yet: nothing to do
    c.agree({ code: 'bedrock-abcde-fghjk-mnpqr-stuvw-xyz23' });
    await c.enqueue(c.fromNote({ strokes: [{ start: 1, points: [0, 0, 0.5, 0, 1, 1, 0.5, 8] }], channels: ['x', 'y', 'pressure', 't'], label: 'hi', labelSource: 'unchecked' }));
    await c.flush();
  });
  assert.equal(server.requests.filter((r) => r.path === '/v1/samples').length, 1);
  await ctx.close();
});
