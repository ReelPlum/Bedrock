// The launch gate: while Bedrock is invite-only, the app asks for the
// invite code and consent to send handwriting as soon as it starts, and
// cannot be used without them (src/consent.js). The backend is played by a
// route in the browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { launch, installPointerHelpers } from './helpers.mjs';

let env;
before(async () => { env = await launch(); });
after(async () => { await env?.close(); });

const API = 'https://collect.test';
const CODE = 'bedrock-abcde-fghjk-mnpqr-stuvw-xyz23';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };

/** A pretend backend that takes `CODE` only. `server.down` makes it
 *  unreachable; `server.refuseAll` turns every code down. */
async function context({ address = API, state = null } = {}) {
  const ctx = await env.browser.newContext({ viewport: { width: 900, height: 800 } });
  await ctx.addInitScript(([a, st]) => {
    if (st && !localStorage.getItem('bedrock.collect.v1')) localStorage.setItem('bedrock.collect.v1', st);
    const s = JSON.parse(localStorage.getItem('bedrock.collect.v1') || '{}');
    if (a && !s.api) localStorage.setItem('bedrock.collect.v1', JSON.stringify({ ...s, api: a }));
  }, [address, state]);
  const server = { requests: [], down: false, refuseAll: false };
  await ctx.route(`${API}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (server.down) return route.abort();
    const path = new URL(req.url()).pathname;
    const auth = req.headers().authorization;
    // Uploads come gzipped (Content-Encoding: gzip), as to the real backend.
    const raw = req.postDataBuffer();
    const sent = raw ? JSON.parse((req.headers()['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString()) : null;
    server.requests.push({ method: req.method(), path, auth, body: sent });
    const ok = !server.refuseAll && auth === `Bearer ${CODE}`;
    const body = !ok ? { error: 'code', detail: 'not accepted' }
      : path === '/v1/stats' ? { samples: 0 }
      : path === '/v1/prompts' ? { words: [], sentences: [], paragraphs: [] }
      : path === '/v1/notes' ? { accepted: (sent?.notes || []).map((x) => x.id), refused: [] }
      : { accepted: (sent?.samples || []).map((x) => x.id), refused: [] };
    return route.fulfill({ status: ok ? 200 : 401, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  });
  return { ctx, server };
}

async function openApp(ctx) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(env.url);
  await page.waitForFunction(() => window.bedrock?.ready, null, { timeout: 20000 });
  return { page, errors };
}

const gateOpen = (page) => page.evaluate(() => !!document.getElementById('launch-gate')?.open);
const stored = (page) => page.evaluate(() => ({
  collect: JSON.parse(localStorage.getItem('bedrock.collect.v1') || '{}'),
  settings: JSON.parse(localStorage.getItem('bedrock.settings.v1') || '{}'),
}));

async function fillGate(page, { code = CODE, tick = true, hand = '' } = {}) {
  await page.fill('#gate-code', code);
  if (hand) await page.selectOption('#gate-hand', hand);
  if (tick) await page.check('#gate-agree');
  else await page.uncheck('#gate-agree');
  await page.click('#gate-go');
}

test('the app asks for the invite code and consent at once, and cannot be used until both are given', async () => {
  const { ctx, server } = await context();
  const { page, errors } = await openApp(ctx);
  assert.equal(await gateOpen(page), true, 'shown at launch');
  assert.equal(await page.getAttribute('#launch-gate a', 'href'), `${env.url}terms/`, 'the box agrees to the Terms of Service, linked');
  assert.equal((await page.textContent('.gate-agree')).trim(), 'I agree to the Terms of Service');
  // Escape does not close it, and the app behind cannot be clicked.
  await page.keyboard.press('Escape');
  assert.equal(await gateOpen(page), true, 'Escape does not close it');
  assert.equal(await page.evaluate(() => document.elementFromPoint(5, 5)?.closest('#launch-gate') !== null), true, 'the app behind cannot be reached');

  await fillGate(page, { tick: false });
  assert.match(await page.textContent('#gate-error'), /Tick the box/);
  await fillGate(page, { code: '' });
  assert.match(await page.textContent('#gate-error'), /Enter your invite code/);
  assert.equal(server.requests.length, 0, 'nothing asked of the server yet');

  await fillGate(page, { code: 'bedrock-wrong' });
  await page.waitForFunction(() => /not accepted/.test(document.getElementById('gate-error').textContent));
  assert.equal(await gateOpen(page), true);
  assert.deepEqual(server.requests.map((r) => r.path), ['/v1/stats'], 'the code is checked against the server');
  assert.equal((await stored(page)).collect.consent ?? 0, 0, 'a wrong code saves nothing');

  await fillGate(page, { hand: 'left' });
  await page.waitForFunction(() => !document.getElementById('launch-gate'));
  const s = await stored(page);
  assert.equal(s.collect.consent, 4);
  assert.equal(s.collect.code, CODE);
  assert.equal(s.collect.handedness, 'left');
  assert.equal(s.collect.mirror, 4, '"Mirror my notes" is turned on by agreeing');
  assert.equal(await page.isChecked('#mirror-notes'), true, 'and in the running app');
  assert.equal(await page.isDisabled('#mirror-notes'), true, 'it cannot be turned off while the gate is on');

  // Next launch: no gate.
  await page.reload();
  await page.waitForFunction(() => window.bedrock?.ready, null, { timeout: 20000 });
  assert.equal(await gateOpen(page), false);
  assert.equal(await page.evaluate(async () => (await import('/src/collect.js')).isMirroring()), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('with no server address built in, the app opens without the gate', async () => {
  const { ctx } = await context({ address: null });
  const { page, errors } = await openApp(ctx);
  assert.equal(await gateOpen(page), false);
  assert.equal(await page.isDisabled('#mirror-notes'), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('offline, the code is kept and checked later; a code the server turns down brings the gate back', async () => {
  const { ctx, server } = await context();
  const { page, errors } = await openApp(ctx);
  server.down = true;
  await fillGate(page);
  await page.waitForFunction(() => !document.getElementById('launch-gate'));
  assert.equal((await stored(page)).collect.consent, 4, 'agreed, the code to be checked when online');

  // Back online, and the code has been withdrawn on the server.
  server.down = false;
  server.refuseAll = true;
  await page.evaluate(async () => {
    const c = await import('/src/collect.js');
    await c.enqueue(c.fromTraining({ prompt: { kind: 'text', text: 'hi' }, note: { strokes: [{ start: 1, points: [0, 0, 0.5, 0, 1, 1, 0.5, 8] }], channels: ['x', 'y', 'pressure', 't'] }, written: 9 }));
    await c.flush();
  });
  await page.waitForFunction(() => document.getElementById('launch-gate')?.open);
  assert.match(await page.textContent('#gate-error'), /not accepted/);
  assert.equal(await page.inputValue('#gate-code'), CODE, 'the code is filled in to check');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('consent given to the version 2 text is asked for again, keeping the code and the contributor id', async () => {
  const v2 = readFileSync(new URL('../../../crates/bedrock-core/tests/fixtures/old-formats/collect-state-consent-v2.json', import.meta.url), 'utf8').trim();
  const before = JSON.parse(v2);
  const { ctx } = await context({ state: v2 });
  const { page, errors } = await openApp(ctx);
  assert.equal(await gateOpen(page), true, 'asked again');
  assert.equal(await page.inputValue('#gate-code'), before.code, 'the code is filled in');
  assert.equal(await page.inputValue('#gate-hand'), 'left');
  await page.check('#gate-agree');
  await page.click('#gate-go');
  await page.waitForFunction(() => !document.getElementById('launch-gate'));
  const s = (await stored(page)).collect;
  assert.equal(s.consent, 4);
  assert.equal(s.contributor, before.contributor, 'the same contributor');
  assert.equal(s.sent, before.sent, 'the count of sent samples is kept');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('consent given to the version 3 text (word by word) is asked for again, and agreeing turns on mirroring with the same secret', async () => {
  // Written by the app as it was on 24 November 2026, with "Mirror my notes" on.
  const v3 = readFileSync(new URL('../../../crates/bedrock-core/tests/fixtures/old-formats/collect-state-consent-v3.json', import.meta.url), 'utf8').trim();
  const before = JSON.parse(v3);
  const { ctx } = await context({ state: v3 });
  const { page, errors } = await openApp(ctx);
  assert.equal(await gateOpen(page), true, 'asked again');
  assert.equal(await page.evaluate(async () => (await import('/src/collect.js')).isMirroring()), false, 'nothing is mirrored until then');
  assert.equal(await page.inputValue('#gate-code'), before.code, 'the code is filled in');
  await page.check('#gate-agree');
  await page.click('#gate-go');
  await page.waitForFunction(() => !document.getElementById('launch-gate'));
  const s = (await stored(page)).collect;
  assert.deepEqual([s.consent, s.mirror, s.contributor, s.secret, s.sent], [4, 4, before.contributor, before.secret, before.sent]);
  assert.equal(await page.isChecked('#mirror-notes'), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the Terms of Service page says what is sent, and /train agrees to it too, turning on "Mirror my notes"', async () => {
  const { ctx } = await context();
  const terms = await ctx.newPage();
  await terms.goto(`${env.url}terms/`);
  assert.equal(await terms.title(), 'Bedrock terms of service');
  const version = await terms.evaluate(async () => (await import('/src/collect.js')).CONSENT_VERSION);
  assert.equal(await terms.getAttribute('#terms', 'data-consent-version'), String(version), 'the terms are the version people agree to');
  assert.match(await terms.textContent('#terms'), /keeps a copy of the handwriting in every note/);
  assert.match(await terms.textContent('#terms'), /Delete my contributions/);

  const page = await ctx.newPage();
  await page.goto(`${env.url}train/`);
  await page.waitForFunction(() => window.setup?.ready);
  assert.equal(await page.getAttribute('#agree-text a', 'href'), `${env.url}terms/`);
  await page.fill('#code', CODE);
  await page.check('#agree');
  await page.click('#save');
  await page.waitForFunction(() => /^On\./.test(document.getElementById('state').textContent));
  const s = await stored(page);
  assert.equal(s.collect.consent, 4);
  assert.equal(s.collect.mirror, 4);
  // "Stop saving" withdraws it, and the app asks again.
  await page.click('#stop');
  const app = await openApp(ctx);
  assert.equal(await gateOpen(app.page), true);
  await ctx.close();
});

test('agreeing in another window of the app closes the gate in this one', async () => {
  const { ctx } = await context();
  const a = await openApp(ctx);
  const b = await openApp(ctx);
  assert.equal(await gateOpen(a.page), true);
  await fillGate(b.page);
  await b.page.waitForFunction(() => !document.getElementById('launch-gate'));
  await a.page.waitForFunction(() => !document.getElementById('launch-gate'));
  assert.equal(await a.page.isChecked('#mirror-notes'), true, 'and this window knows mirroring is on');
  assert.deepEqual([...a.errors, ...b.errors], []);
  await ctx.close();
});

// Bug (CI runs 209, 210, 212 and 214): agreeing turns on "Mirror my notes",
// and the gzipped mirror upload made this file's pretend backend throw
// ("POST data is not a valid JSON object"). Whether it came before the
// test closed its window depended on timing, so the file failed only
// sometimes, with an unhandled rejection after the tests had passed.
// Before the fix the upload was never answered, so the test hung: it has a
// time limit to fail instead.
test('bug: after agreeing, the notes written are mirrored to the server', { timeout: 30000 }, async () => {
  const { ctx, server } = await context();
  const { page, errors } = await openApp(ctx);
  await fillGate(page);
  await page.waitForFunction(() => !document.getElementById('launch-gate'));
  await installPointerHelpers(page);
  await page.evaluate(async () => {
    bedrock.handwriting.enabled = false;
    await t.line(200, 300, 600, 300, { pressure: 0.6 });
    await bedrock.mirrorOpen(true);
    await bedrock.mirrors.flush();
  });
  const uploads = server.requests.filter((r) => r.path === '/v1/notes');
  assert.ok(uploads.length >= 1, 'the note was sent');
  assert.equal(uploads.at(-1).body.notes[0].add.length, 1, 'with its one stroke');
  assert.deepEqual(errors, []);
  await ctx.close();
});
