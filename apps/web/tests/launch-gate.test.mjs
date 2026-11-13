// The launch gate: while Bedrock is invite-only, the app asks for the
// invite code and consent to send handwriting as soon as it starts, and
// cannot be used without them (src/consent.js). The backend is played by a
// route in the browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launch } from './helpers.mjs';

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
    server.requests.push({ method: req.method(), path, auth });
    const ok = !server.refuseAll && auth === `Bearer ${CODE}`;
    const body = !ok ? { error: 'code', detail: 'not accepted' }
      : path === '/v1/stats' ? { samples: 0 }
      : path === '/v1/prompts' ? { words: [], sentences: [], paragraphs: [] }
      : { accepted: (req.postDataJSON()?.samples || []).map((x) => x.id), refused: [] };
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
  assert.equal(s.collect.consent, 3);
  assert.equal(s.collect.code, CODE);
  assert.equal(s.collect.handedness, 'left');
  assert.equal(s.settings.shareWords, true, '"Send every word" is turned on by agreeing');
  assert.equal(await page.evaluate(() => bedrock.settings.shareWords), true, 'and in the running app');
  assert.equal(await page.isChecked('#share-words'), true);
  assert.equal(await page.isDisabled('#share-words'), true, 'it cannot be turned off while the gate is on');

  // Next launch: no gate.
  await page.reload();
  await page.waitForFunction(() => window.bedrock?.ready, null, { timeout: 20000 });
  assert.equal(await gateOpen(page), false);
  assert.equal(await page.evaluate(() => bedrock.settings.shareWords), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('with no server address built in, the app opens without the gate', async () => {
  const { ctx } = await context({ address: null });
  const { page, errors } = await openApp(ctx);
  assert.equal(await gateOpen(page), false);
  assert.equal(await page.isDisabled('#share-words'), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('offline, the code is kept and checked later; a code the server turns down brings the gate back', async () => {
  const { ctx, server } = await context();
  const { page, errors } = await openApp(ctx);
  server.down = true;
  await fillGate(page);
  await page.waitForFunction(() => !document.getElementById('launch-gate'));
  assert.equal((await stored(page)).collect.consent, 3, 'agreed, the code to be checked when online');

  // Back online, and the code has been withdrawn on the server.
  server.down = false;
  server.refuseAll = true;
  await page.evaluate(async () => {
    const c = await import('/src/collect.js');
    await c.enqueue(c.fromNote({ strokes: [{ start: 1, points: [0, 0, 0.5, 0, 1, 1, 0.5, 8] }], channels: ['x', 'y', 'pressure', 't'], label: 'hi', labelSource: 'unchecked' }));
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
  assert.equal(s.consent, 3);
  assert.equal(s.contributor, before.contributor, 'the same contributor');
  assert.equal(s.sent, before.sent, 'the count of sent samples is kept');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the Terms of Service page says what is sent, and /train agrees to it too, turning on "Send every word"', async () => {
  const { ctx } = await context();
  const terms = await ctx.newPage();
  await terms.goto(`${env.url}terms/`);
  assert.equal(await terms.title(), 'Bedrock terms of service');
  const version = await terms.evaluate(async () => (await import('/src/collect.js')).CONSENT_VERSION);
  assert.equal(await terms.getAttribute('#terms', 'data-consent-version'), String(version), 'the terms are the version people agree to');
  assert.match(await terms.textContent('#terms'), /Every handwritten word you write in a note/);
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
  assert.equal(s.collect.consent, 3);
  assert.equal(s.settings.shareWords, true);
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
  assert.equal(await a.page.evaluate(() => bedrock.settings.shareWords), true, 'and this window knows sending is on');
  assert.deepEqual([...a.errors, ...b.errors], []);
  await ctx.close();
});
