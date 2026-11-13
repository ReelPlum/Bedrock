// Catching errors and "Share with the Bedrock team" (src/errors.js and
// src/report-panel.js), in Chromium with the real app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launch, openApp } from './helpers.mjs';

let env;
before(async () => { env = await launch(); });
after(async () => { await env?.close(); });

// On a page served from this computer the app may use a stored backend
// address; the browser never reaches it, the test answers instead.
const API = 'http://127.0.0.1:9';

/** Answers POST /v1/reports and keeps what was sent. */
async function fakeBackend(ctx) {
  const sent = [];
  await ctx.addInitScript((api) => {
    try { localStorage.setItem('bedrock.collect.v1', JSON.stringify({ api })); } catch (_) { /* ignore */ }
    // Not about the launch gate (launch-gate.test.mjs): keep it out of the way.
    window.bedrockNoLaunchGate = true;
  }, API);
  await ctx.route(`${API}/v1/reports`, async (route) => {
    const body = JSON.parse(route.request().postData());
    sent.push(body);
    await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ id: body.id }) });
  });
  return sent;
}

/** The checks the backend makes (collect-core/src/report.rs), so a report
 *  the app builds is one the backend takes. */
function assertValidReport(r) {
  assert.equal(r.format, 'bedrock-error-report');
  assert.equal(r.version, 1);
  assert.match(r.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(['web', 'obsidian'].includes(r.app));
  assert.match(r.app_version, /^[A-Za-z0-9 ._\-/+]{1,40}$/);
  assert.ok(['ipad', 'iphone', 'android', 'windows', 'mac', 'linux', 'other'].includes(r.device));
  if (r.browser) assert.match(r.browser, /^[A-Za-z0-9 ._\-/+]{1,40}$/);
  assert.ok(['startup', 'running'].includes(r.stage));
  assert.ok(Number.isInteger(r.created));
  assert.ok(r.errors.length <= 50);
  for (const e of r.errors) {
    assert.ok(['error', 'rejection', 'panic', 'worker', 'shown'].includes(e.kind), e.kind);
    assert.ok(e.message.length >= 1 && e.message.length <= 500);
    if (e.stack) assert.ok(e.stack.length <= 4000);
    assert.ok(Number.isInteger(e.at));
  }
  for (const [k, v] of Object.entries(r.context)) {
    assert.match(k, /^[a-z0-9_]{1,32}$/);
    assert.equal(typeof v, 'boolean');
  }
  assert.ok(r.errors.length || r.comment);
  assert.ok(JSON.stringify(r).length < 64 * 1024);
}

test('folders and addresses are cut down to file names before anything is logged', async () => {
  const { page, ctx } = await openApp(env);
  const out = await page.evaluate(() => [
    'at load (app://obsidian.md/Users/frederik/Vaults/Private/.obsidian/plugins/bedrock-notes/main.js?v=3:10:5)',
    'could not open /Users/frederik/Documents/Diary.bedrock',
    'C:\\Users\\frederik\\Vault\\note.bedrock is locked',
    'Failed to fetch https://reelplum.github.io/Bedrock/src/main.js?x=1#y',
    'see blob:https://example.com/0a1b-2c',
  ].map((t) => window.bedrockErrors.scrub(t)));
  assert.deepEqual(out, [
    'at load (main.js:10:5)',
    'could not open Diary.bedrock',
    'note.bedrock is locked',
    'Failed to fetch main.js',
    'see 0a1b-2c',
  ]);
  for (const line of out) assert.doesNotMatch(line, /frederik|Vault|Users/);
  // The shared module (used by the Obsidian plugin) follows the same rules.
  const shared = await page.evaluate(async (lines) => {
    const { scrub } = await import('/src/error-report.js');
    return lines.map((t) => scrub(t));
  }, [
    'at load (app://obsidian.md/Users/frederik/Vaults/Private/.obsidian/plugins/bedrock-notes/main.js?v=3:10:5)',
    'could not open /Users/frederik/Documents/Diary.bedrock',
    'C:\\Users\\frederik\\Vault\\note.bedrock is locked',
    'Failed to fetch https://reelplum.github.io/Bedrock/src/main.js?x=1#y',
    'see blob:https://example.com/0a1b-2c',
  ]);
  assert.deepEqual(shared, out);
  await ctx.close();
});

// The screenshot that started this: a startup failure showed one line of
// text and nothing could be done with it.
test('a startup failure offers Reload and Share, and the report holds the error with its stack', async () => {
  const ctx = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const sent = await fakeBackend(ctx);
  // A page without the Duplicate button: main.js cannot start with it.
  const real = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const old = real.replace(/\s*<button[^>]*id="wm-duplicate"[^>]*>[^<]*<\/button>/, '');
  await ctx.route((u) => u.pathname === '/' || u.pathname === '/index.html', (r) => r.fulfill({ contentType: 'text/html', body: old }));
  const page = await ctx.newPage();
  await page.goto(env.url);
  await page.waitForFunction(() => document.querySelector('#fatal .bx-share'), null, { timeout: 20000 });
  assert.match(await page.textContent('#fatal'), /^Bedrock failed to start: /);
  assert.equal(await page.textContent('#fatal button'), 'Reload', 'Reload comes first');
  await page.click('#fatal .bx-share');
  await page.waitForSelector('.bx-panel pre');
  const shown = JSON.parse(await page.textContent('.bx-panel pre'));
  assert.equal(shown.stage, 'startup');
  const err = shown.errors.find((e) => e.kind === 'error' && /wm-duplicate|null/.test(e.message));
  assert.ok(err, JSON.stringify(shown.errors));
  assert.match(err.stack, /main\.js:\d+/, 'the stack says where');
  assert.doesNotMatch(err.stack, /127\.0\.0\.1|http/, 'file names only');
  assertValidReport(shown);
  await page.fill('.bx-panel textarea', 'It happened right after the update.');
  await page.click('.bx-panel .bx-send');
  await page.waitForFunction(() => /Sent, thank you/.test(document.querySelector('.bx-panel .bx-status').textContent));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { ...shown, comment: 'It happened right after the update.' }, 'exactly what was shown is sent');
  assert.equal(await page.evaluate(() => window.bedrockErrors.entries().length), 0, 'the log starts afresh');
  await ctx.close();
});

test('after a startup failure the half-started app does not try to save', async () => {
  // Bug: a save scheduled before the failure ran afterwards and failed
  // ("Cannot access 'saver' before initialization"), adding a second
  // error to the log, sometimes after the report about the first was sent.
  const ctx = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  await fakeBackend(ctx);
  const real = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const old = real.replace(/\s*<button[^>]*id="wm-duplicate"[^>]*>[^<]*<\/button>/, '');
  await ctx.route((u) => u.pathname === '/' || u.pathname === '/index.html', (r) => r.fulfill({ contentType: 'text/html', body: old }));
  const page = await ctx.newPage();
  await page.goto(env.url);
  await page.waitForFunction(() => document.querySelector('#fatal .bx-share'), null, { timeout: 20000 });
  // Longer than the autosave delay and the first scheduled jobs.
  await page.waitForTimeout(5000);
  const log = await page.evaluate(() => window.bedrockErrors.entries().map((e) => e.message));
  assert.deepEqual(log.filter((m) => /save/i.test(m)), [], JSON.stringify(log));
  await ctx.close();
});

test('an error while writing shows a quiet notice; Details shows the report and Send sends it', async () => {
  const ctx = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const sent = await fakeBackend(ctx);
  const { page } = await openApp(env, { context: ctx });
  await page.evaluate(() => setTimeout(() => { throw new TypeError('x.y is undefined'); }));
  await page.waitForSelector('.bx-notice');
  assert.match(await page.textContent('.bx-notice'), /Something went wrong/);
  assert.equal(await page.isVisible('#fatal'), false, 'the canvas stays usable');
  // A second error within the minute adds to the log, not another notice.
  await page.evaluate(() => { Promise.reject(new Error('second problem')); });
  await page.waitForFunction(() => window.bedrockErrors.entries().some((e) => e.kind === 'rejection'));
  assert.equal(await page.locator('.bx-notice').count(), 1);
  await page.click('.bx-notice button:text("Details")');
  const shown = JSON.parse(await page.textContent('.bx-panel pre'));
  assert.equal(shown.stage, 'running');
  assert.deepEqual(shown.errors.map((e) => [e.kind, e.message]), [['error', 'TypeError: x.y is undefined'], ['rejection', 'second problem']]);
  assert.equal(shown.context.webgl2, true);
  assertValidReport(shown);
  await page.click('.bx-panel .bx-send');
  await page.waitForFunction(() => /Sent/.test(document.querySelector('.bx-panel .bx-status').textContent));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, shown.id);
  await ctx.close();
});

test('a Rust panic reaches the log with its message', async () => {
  const { page, ctx } = await openApp(env);
  await page.evaluate(async () => {
    const m = await import('/pkg/bedrock_web.js');
    try { m.panic_for_tests('index out of bounds in a test'); } catch (_) { /* the panic's "unreachable" */ }
  });
  const panics = await page.evaluate(() => window.bedrockErrors.entries().filter((e) => e.kind === 'panic'));
  assert.equal(panics.length, 1);
  assert.match(panics[0].message, /^panicked at .*lib\.rs:\d+:\d+:\s*index out of bounds in a test$/s);
  await ctx.close();
});

test('Report a problem works without an error, and needs a comment then', async () => {
  const ctx = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const sent = await fakeBackend(ctx);
  const { page } = await openApp(env, { context: ctx });
  await page.click('#btn-menu');
  await page.click('[data-action="report"]');
  await page.waitForSelector('.bx-panel');
  assert.equal(await page.isDisabled('.bx-panel .bx-send'), true, 'nothing to send yet');
  await page.fill('.bx-panel textarea', 'The pen lags after an hour.');
  assert.equal(await page.isDisabled('.bx-panel .bx-send'), false);
  const shown = JSON.parse(await page.textContent('.bx-panel pre'));
  assert.deepEqual(shown.errors, []);
  assert.equal(shown.comment, 'The pen lags after an hour.');
  assertValidReport(shown);
  await page.click('.bx-panel .bx-send');
  await page.waitForFunction(() => /Sent/.test(document.querySelector('.bx-panel .bx-status').textContent));
  assert.equal(sent[0].comment, 'The pen lags after an hour.');
  await ctx.close();
});

test('without a backend address the report can be copied but not sent', async () => {
  const { page, ctx } = await openApp(env);
  await page.evaluate(() => window.bedrockErrors.record('error', new Error('boom')));
  await page.evaluate(() => { window.bedrockErrors.open(); });
  await page.waitForSelector('.bx-panel');
  assert.equal(await page.isDisabled('.bx-panel .bx-send'), true);
  assert.match(await page.textContent('.bx-panel .bx-status'), /not switched on/);
  await page.click('.bx-panel button:text("Close")');
  assert.equal(await page.locator('.bx-panel').count(), 0);
  await ctx.close();
});

test('the log survives a reload, repeats are counted, and it holds no note content', async () => {
  const { page, ctx } = await openApp(env);
  await page.evaluate(() => t.line(200, 300, 400, 320));
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.bedrockErrors.record('error', new Error('same thing')));
  await page.reload();
  await page.waitForFunction(() => window.bedrock?.ready);
  const entries = await page.evaluate(() => window.bedrockErrors.entries());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].count, 3);
  const report = await page.evaluate(async () => {
    const m = await import('/src/report-panel.js');
    return m.buildReport(window.bedrockErrors.entries(), { facts: m.context() });
  });
  assertValidReport(report);
  assert.equal(report.errors[0].count, 3);
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /strokes|points|"title"/);
  await ctx.close();
});

test('the browser is named by engine and major version only', async () => {
  const { page, ctx } = await openApp(env);
  const tags = await page.evaluate(async () => {
    const { browserTag } = await import('/src/report-panel.js');
    return [
      'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) obsidian/1.7.7 Chrome/128.0.6613.186 Electron/32.2.5 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; rv:133.0) Gecko/20100101 Firefox/133.0',
    ].map((ua) => browserTag(ua));
  });
  assert.deepEqual(tags, ['safari 18', 'chrome 131', 'chrome 128', 'firefox 133']);
  await ctx.close();
});
