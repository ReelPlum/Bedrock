// Note mirrors in the real app: turning "Mirror my notes" on, writing,
// erasing and undoing in a note, the notes already in the library (saved
// in every earlier version of the note format) and deleting a note, each
// checked against what a pretend backend receives. It keeps the cloud copy
// the way the real one does (collect-core/src/api.rs in Bedrock-Backend):
// an erased stroke id is never stored again. mirror-notes.test.mjs tests
// the same rules without a browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { launch, openApp, goodnotesLikePdf } from './helpers.mjs';

let env;
before(async () => { env = await launch(); });
after(async () => { await env?.close(); });

const API = 'https://collect.test';
const CODE = 'bedrock-abcde-fghjk-mnpqr-stuvw-xyz23';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
const OLD = new URL('../../../crates/bedrock-core/tests/fixtures/old-formats/', import.meta.url);
const OLD_NOTES = ['v1-first-release', 'v1-before-pictures', 'v1-pictures-and-text-boxes', 'v1-before-note-links', 'v1-handwriting-before-points-bin'];

/** A pretend backend that keeps every mirror's strokes, as the real one. */
async function fakeBackend(ctx) {
  const server = { requests: [], mirrors: new Map() };
  await ctx.route(`${API}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const raw = req.postDataBuffer();
    const body = raw ? JSON.parse((req.headers()['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString()) : null;
    const path = new URL(req.url()).pathname;
    server.requests.push({ method: req.method(), path, secret: req.headers()['x-contributor-secret'], auth: req.headers().authorization, body });
    let answer = { accepted: [], refused: [] };
    if (path === '/v1/notes') {
      for (const u of body.notes) {
        if (u.deleted) { server.mirrors.delete(u.note); continue; }
        const m = server.mirrors.get(u.note) || { strokes: new Map(), erased: new Set(), channels: u.channels };
        server.mirrors.set(u.note, m);
        for (const s of u.add) if (!m.erased.has(s.id) && !u.erase.includes(s.id)) m.strokes.set(s.id, s);
        for (const id of u.erase) { m.strokes.delete(id); m.erased.add(id); }
      }
      answer = { accepted: body.notes.map((u) => u.id), refused: [] };
    }
    if (req.method() === 'DELETE') {
      answer = { deleted: { samples: 0, paragraphs: 0, notes: server.mirrors.size }, more: false };
      server.mirrors.clear();
    }
    return route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(answer) });
  });
  return server;
}

/** The app, with saving set up (consent, code, contributor id) and the
 *  pretend backend's address, but mirroring not yet on. */
async function app() {
  const ctx = await env.browser.newContext({ viewport: { width: 1000, height: 760 } });
  await ctx.addInitScript(({ api, code }) => {
    window.bedrockNoLaunchGate = true;
    if (!localStorage.getItem('bedrock.collect.v1')) {
      localStorage.setItem('bedrock.collect.v1', JSON.stringify({ consent: 4, code, api, contributor: crypto.randomUUID(), handedness: 'right' }));
    }
  }, { api: API, code: CODE });
  const server = await fakeBackend(ctx);
  const { page, errors } = await openApp(env, { context: ctx });
  await page.evaluate(() => { bedrock.handwriting.enabled = false; });
  page.on('dialog', (d) => d.accept());
  return { ctx, page, errors, server };
}

/** Turns "Mirror my notes" on, as the writer does in settings. */
async function turnOn(page) {
  await page.evaluate(async () => {
    const box = document.getElementById('mirror-notes');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(async () => (await import('/src/collect.js')).isMirroring());
}

/** Mirrors the open note and sends what is waiting, now. */
const syncNow = (page) => page.evaluate(async () => {
  await bedrock.mirrorOpen(true);
  await bedrock.mirrorLibrary();
  await bedrock.mirrors.flush();
});

/** The cloud copy of a note: its strokes' points, keyed by stroke id. */
function cloud(server) {
  assert.equal(server.mirrors.size, 1, 'one note mirrored');
  return [...server.mirrors.values()][0];
}

/** The open note's handwriting, as the canvas holds it. */
const canvasInk = (page) => page.evaluate(() => Array.from(bedrock.canvas.mirror_stroke_ids()).map((id) => JSON.parse(bedrock.canvas.stroke_json(id)).points));
const sorted = (inks) => inks.map((p) => JSON.stringify(p)).sort();

/** Writes `n` strokes side by side on a row `y` down the page. */
async function write(page, n, y = 200) {
  await page.evaluate(async ({ n, y }) => {
    const r = document.getElementById('stage').getBoundingClientRect();
    for (let i = 0; i < n; i++) await t.line(r.left + 120 + i * 120, r.top + y, r.left + 200 + i * 120, r.top + y + 60);
  }, { n, y });
}

test('writing, erasing and undoing in a note keeps its cloud copy exactly as the note', async () => {
  const { ctx, page, errors, server } = await app();
  await write(page, 1, 80);
  await syncNow(page);
  assert.equal(server.requests.filter((r) => r.path === '/v1/notes').length, 0, 'nothing is sent before mirroring is on');

  await turnOn(page);
  await write(page, 2);
  await syncNow(page);
  const first = server.requests.filter((r) => r.path === '/v1/notes');
  assert.ok(first.length >= 1);
  assert.match(first[0].secret, /^[0-9a-f]{64}$/, 'the contributor secret is sent');
  assert.equal(first[0].auth, `Bearer ${CODE}`);
  assert.equal(first[0].body.contributor.consent_version, 4);
  const up = first[0].body.notes[0];
  assert.deepEqual(Object.keys(up).sort(), ['add', 'app_version', 'channels', 'device', 'erase', 'format', 'id', 'note', 'version', 'written']);
  assert.notEqual(up.note, await page.evaluate(() => bedrock.noteId), 'the backend id is not the app\'s note id');
  assert.equal(cloud(server).strokes.size, 3, 'the stroke written before mirroring was on is sent too');
  assert.deepEqual(sorted([...cloud(server).strokes.values()].map((s) => s.points)), sorted(await canvasInk(page)), 'every raw sample, as the note holds it');

  // Erasing a stroke with the stroke eraser.
  await page.evaluate(async () => {
    document.querySelector('[data-tool="eraser"]').click();
    const r = document.getElementById('stage').getBoundingClientRect();
    await t.line(r.left + 150, r.top + 180, r.left + 170, r.top + 280, { id: 2 });
  });
  assert.equal(await page.evaluate(() => bedrock.canvas.stroke_count()), 2, 'one stroke erased');
  await syncNow(page);
  const erasing = server.requests.filter((r) => r.path === '/v1/notes').at(-1).body.notes;
  assert.equal(erasing.flatMap((u) => u.erase).length, 1, 'the erased stroke is sent as erased');
  assert.deepEqual(sorted([...cloud(server).strokes.values()].map((s) => s.points)), sorted(await canvasInk(page)), 'the cloud copy lost the erased ink');

  // Undo brings it back, with the same id in the note.
  await page.evaluate(() => bedrock.canvas.undo());
  assert.equal(await page.evaluate(() => bedrock.canvas.stroke_count()), 3);
  await syncNow(page);
  assert.deepEqual(sorted([...cloud(server).strokes.values()].map((s) => s.points)), sorted(await canvasInk(page)), 'the undone erase is back in the cloud copy');
  const before = server.requests.length;
  await syncNow(page);
  assert.equal(server.requests.length, before, 'nothing changed: nothing sent');

  // After a reload (once saved), only what changed is sent.
  await page.evaluate(() => bedrock.saveNow());
  await page.reload();
  await page.waitForFunction(() => window.bedrock?.ready, null, { timeout: 20000 });
  await page.evaluate(() => { bedrock.handwriting.enabled = false; });
  await syncNow(page);
  assert.deepEqual(server.requests.slice(before).map((r) => r.body), [], 'reopened unchanged: nothing sent');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('every note already in the library is mirrored in full, whatever format version it was saved in', async () => {
  const { ctx, page, errors, server } = await app();
  const ids = [];
  for (const [k, name] of OLD_NOTES.entries()) {
    const bytes = [...readFileSync(new URL(`${name}.bedrock`, OLD))];
    ids.push(await page.evaluate(async ({ k, name, bytes }) => {
      const id = `old-${k}`;
      await bedrock.store.put({ id, title: name, created: 1_700_000_000_000 + k, modified: 1_700_000_000_000 + k, folder: null, data: new Uint8Array(bytes) });
      return id;
    }, { k, name, bytes }));
  }
  await turnOn(page);
  await syncNow(page);
  assert.equal(server.mirrors.size, OLD_NOTES.length, 'one mirror per note (the open note is empty)');
  // Each note's mirror holds every handwritten stroke, with every sample.
  for (const [k, id] of ids.entries()) {
    await page.evaluate((id) => bedrock.openNote(id), id);
    const ink = await canvasInk(page);
    assert.ok(ink.length > 0, OLD_NOTES[k]);
    const mirror = await page.evaluate(async (id) => (await (await import('/src/mirror-notes.js')).deviceStore.get(id)).mirror, id);
    assert.deepEqual(sorted([...server.mirrors.get(mirror).strokes.values()].map((s) => s.points)), sorted(ink), `${OLD_NOTES[k]}: mirrored in full`);
  }
  // Opening them changed nothing, so nothing more is sent.
  const sent = server.requests.length;
  await syncNow(page);
  assert.equal(server.requests.length, sent, 'each note is sent once');

  // A note deleted from the library loses its mirror.
  await page.evaluate(async (id) => { await bedrock.newNote(); await bedrock.store.remove(id); }, ids[0]);
  await syncNow(page);
  const last = server.requests.at(-1).body.notes;
  assert.ok(last.some((u) => u.deleted === true), 'a deleted upload is sent');
  assert.equal(server.mirrors.size, OLD_NOTES.length - 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('"Delete my contributions" deletes the mirrors with the secret, and the device forgets them', async () => {
  const { ctx, page, errors, server } = await app();
  await turnOn(page);
  await write(page, 2);
  await syncNow(page);
  assert.equal(cloud(server).strokes.size, 2);
  const secret = server.requests.find((r) => r.path === '/v1/notes').secret;

  const setup = await ctx.newPage();
  setup.on('dialog', (d) => d.accept());
  await setup.goto(`${env.url}train/`);
  await setup.waitForFunction(() => window.setup?.ready, null, { timeout: 20000 });
  await setup.click('#delete');
  await setup.waitForFunction(() => /Deleted/.test(document.getElementById('state').textContent));
  const del = server.requests.find((r) => r.method === 'DELETE');
  assert.equal(del.secret, secret, 'sent with the contributor secret, as the backend now knows it');
  assert.equal(server.mirrors.size, 0);
  const left = await setup.evaluate(async () => {
    const m = await import('/src/mirror-notes.js');
    const c = await import('/src/collect.js');
    return { notes: (await m.deviceStore.all()).length, queued: await m.deviceQueue.count(), mirroring: c.isMirroring(), secretKnown: c.loadState().secretKnown };
  });
  assert.deepEqual(left, { notes: 0, queued: 0, mirroring: false, secretKnown: false });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('importing a PDF: each page becomes a note, and is mirrored, not sent as samples', async () => {
  const { ctx, page, errors, server } = await app();
  await turnOn(page);
  const pages = await page.evaluate(async (bytes) => bedrock.importPdf({ name: 'Lecture 7.pdf', bytes: new Uint8Array(bytes) }), goodnotesLikePdf());
  assert.equal(pages, 2);
  const notes = await page.evaluate(async () => (await bedrock.store.list()).map((n) => n.title).sort());
  assert.deepEqual(notes.filter((t) => t.startsWith('Lecture')), ['Lecture 7 (page 1)', 'Lecture 7 (page 2)']);
  assert.equal(await page.evaluate(() => bedrock.canvas.stroke_count()), 1, 'the last page is open');
  await syncNow(page);
  const sizes = [...server.mirrors.values()].map((m) => m.strokes.size).sort();
  assert.deepEqual(sizes, [1, 4], 'each page is mirrored with all its handwriting');
  assert.equal(server.requests.filter((r) => r.path === '/v1/samples').length, 0, 'no samples');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the training data spec lists what the app keeps for mirrors', () => {
  const spec = readFileSync(new URL('../../../openspec/specs/note-mirrors/spec.md', import.meta.url), 'utf8');
  for (const s of ['bedrock-mirror', 'X-Contributor-Secret', 'secretKnown', '"erased"', '"alias"']) assert.ok(spec.includes(s), s);
});
