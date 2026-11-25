// Saving training samples: consent, the queue on the device, sending, and
// feedback from notes. The backend is played by a route in the browser that
// records what it is sent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { launch, openApp, installPointerHelpers, goodnotesLikePdf } from './helpers.mjs';

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
      local: c.apiAddress('http://127.0.0.1:8787', '127.0.0.1:8080'),
      // Bug: Obsidian on iPad and Android runs at capacitor://localhost and
      // http://localhost (no port). It was taken for a development page, so
      // an address stored by an older version was used instead of the
      // backend, and the code check and every upload went nowhere.
      ipad: c.pageHost({ origin: 'capacitor://localhost' }),
      mobile: c.apiAddress('https://old.example', c.pageHost({ origin: 'capacitor://localhost' })),
      android: c.apiAddress('https://old.example', c.pageHost({ location: { host: 'localhost', hostname: 'localhost' } })),
      dev: c.pageHost({ location: { host: '127.0.0.1:8080', hostname: '127.0.0.1' } }),
      built: c.DEFAULT_API,
      agreed: c.agree({ code: 'x', api: 'https://someone-else.example' }, { getItem: () => null, setItem() {} }).api,
    };
  });
  assert.equal(r.site, r.built, 'the site always uses the built-in address');
  assert.equal(r.plugin, r.built);
  assert.equal(r.local, 'http://127.0.0.1:8787');
  assert.equal(r.ipad, 'localhost');
  assert.equal(r.mobile, r.built, 'Obsidian on iPad uses the built-in address');
  assert.equal(r.android, r.built, 'Obsidian on Android uses the built-in address');
  assert.equal(r.dev, '127.0.0.1:8080');
  assert.notEqual(r.agreed, 'https://someone-else.example', 'agreeing cannot set it either');
  assert.equal(r.built, 'https://bedrock-collect.reelplum.workers.dev', 'the deployed backend is built in');
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
  assert.equal(body.contributor.consent_version, 4);
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
  const logged = [];
  page.on('console', (m) => logged.push(`${m.type()}: ${m.text()}`));
  await page.evaluate(async () => (await import('/src/collect.js')).flush());
  assert.equal(await waiting(page), 0, 'dropped: it would be refused every time');
  // Bug: a refused sample was dropped without a word anywhere.
  assert.ok(logged.some((l) => /^warning: Bedrock: 1 sample was refused: label \(label is missing\)/.test(l)), logged.join(' | '));
  assert.equal(await page.evaluate(async () => (await import('/src/collect.js')).loadState().sent), 0);
  await ctx.close();
});

test('a wrong invite code keeps the samples and says so', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  server.answer = () => ({ status: 401, body: { error: 'invite' } });
  const { page } = await openTrainer(ctx);
  const logged = [];
  page.on('console', (m) => logged.push(`${m.type()}: ${m.text()}`));
  await writeOne(page);
  await settle(page, () => /invite code was not accepted/.test(document.getElementById('saving').textContent));
  assert.equal(await waiting(page), 1);
  // Bug: nothing was written to the console, so a refused upload could not
  // be told apart from one that was never tried. It says why, without the code.
  const line = logged.find((l) => /samples were not sent/.test(l));
  assert.ok(line, `the console says why: ${logged.join(' | ')}`);
  assert.match(line, /^warning: .*401.*invite/);
  assert.ok(!line.includes(CODE), 'the code itself is never logged');
  await ctx.close();
});

test('bug: an upload with no connection says so in the console', async () => {
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  server.answer = (r) => (r.method === 'POST' ? 'abort' : null);
  const { page } = await openTrainer(ctx);
  const logged = [];
  page.on('console', (m) => logged.push(`${m.type()}: ${m.text()}`));
  await writeOne(page);
  await settle(page, () => /1 waiting/.test(document.getElementById('count').textContent));
  // "1 waiting" shows as soon as the sample is queued; the warning comes
  // after both tries (gzip, then plain) have failed, so wait for it.
  const warned = () => logged.some((l) => /^warning: .*samples were not sent.*no answer/.test(l));
  for (let i = 0; i < 200 && !warned(); i++) await page.waitForTimeout(50);
  assert.ok(warned(), logged.join(' | '));
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

test('notes: nothing from a note is sent as a sample, even a word the writer checks', async () => {
  // Notes are mirrored whole instead ("Mirror my notes", mirror-notes-app.test.mjs).
  const { ctx, server } = await context();
  const setup = await openSetup(ctx);
  await agree(setup.page);
  const { page, errors } = await noteWithWord(ctx);
  assert.equal(await page.$('#share-words'), null, 'there is no "Send every word" setting');
  await openMenu(page);
  await page.click('#wm-right');
  const w = await page.evaluate(() => JSON.parse(bedrock.canvas.words_json())[0]);
  assert.deepEqual([w.text, w.engine], ['helo', 'user'], 'checking a word still marks it checked');
  await page.evaluate(async (bytes) => bedrock.importPdf({ name: 'Lecture 7.pdf', bytes: new Uint8Array(bytes) }), goodnotesLikePdf());
  await page.evaluate(async () => (await import('/src/collect.js')).flush());
  assert.equal(await waiting(page), 0);
  assert.equal(server.requests.filter((r) => r.path === '/v1/samples').length, 0);
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

// Bug: an imported PDF was not saved: opening another note and then the
// imported one showed a blank note.
test('bug: an imported PDF is saved, and is still there after opening another note and coming back', async () => {
  const { ctx } = await context();
  const { page, errors } = await openApp(env, { context: ctx });
  await page.evaluate(() => { bedrock.handwriting.enabled = false; });
  await page.evaluate(async (bytes) => bedrock.importPdf({ name: 'Lecture 8.pdf', bytes: new Uint8Array(bytes) }), goodnotesLikePdf());
  const ids = await page.evaluate(async () => Object.fromEntries((await bedrock.store.list()).map((n) => [n.title, n.id])));
  await page.evaluate(() => bedrock.newNote());
  assert.equal(await page.evaluate(() => bedrock.canvas.stroke_count()), 0);
  for (const [title, strokes] of [['Lecture 8 (page 1)', 4], ['Lecture 8 (page 2)', 1]]) {
    await page.evaluate((id) => bedrock.openNote(id), ids[title]);
    assert.equal(await page.evaluate(() => bedrock.canvas.stroke_count()), strokes, title);
  }
  // And after the app is opened again.
  await page.reload();
  await page.waitForFunction(() => window.bedrock?.ready, null, { timeout: 20000 });
  await page.evaluate((id) => bedrock.openNote(id), ids['Lecture 8 (page 1)']);
  assert.equal(await page.evaluate(() => bedrock.canvas.stroke_count()), 4, 'after a reload');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('consent given to an older consent text is asked for again', async () => {
  const { ctx } = await context();
  const { page } = await openSetup(ctx);
  const r = await page.evaluate(async () => {
    const c = await import('/src/collect.js');
    const s = c.agree({ code: 'x' });
    return { now: c.isReady(s), v3: c.isReady({ ...s, consent: 3 }), old: c.isReady({ ...s, consent: 2 }), older: c.isReady({ ...s, consent: 1 }), version: c.CONSENT_VERSION };
  });
  assert.deepEqual(r, { now: true, v3: false, old: false, older: false, version: 4 });
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
    await c.enqueue(c.fromTraining({ prompt: { kind: 'text', text: 'hi' }, note: { strokes: [{ start: 1, points: [0, 0, 0.5, 0, 1, 1, 0.5, 8] }], channels: ['x', 'y', 'pressure', 't'] }, written: 9 }));
    await c.flush();
  });
  assert.equal(server.requests.filter((r) => r.path === '/v1/samples').length, 1);
  await ctx.close();
});
