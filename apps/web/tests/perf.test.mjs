// Noticing when Bedrock is slow and what was running (src/perf.js), the
// slow entries in the error log (src/errors.js), and opt-in automatic
// performance reports. In Chromium with the real app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openApp } from './helpers.mjs';

let env;
before(async () => { env = await launch(); });
after(async () => { await env?.close(); });

const API = 'http://127.0.0.1:9';

async function fakeBackend(ctx) {
  const sent = [];
  await ctx.addInitScript((api) => {
    try { localStorage.setItem('bedrock.collect.v1', JSON.stringify({ api })); } catch (_) { /* ignore */ }
  }, API);
  await ctx.route(`${API}/v1/reports`, async (route) => {
    const body = JSON.parse(route.request().postData());
    sent.push(body);
    await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ id: body.id }) });
  });
  return sent;
}

const NAME = /^[a-z0-9_+-]{1,32}$/;

/** The version 2 checks the backend makes (collect-core/src/report.rs). */
function assertValidV2(r) {
  assert.equal(r.format, 'bedrock-error-report');
  assert.equal(r.version, 2);
  assert.ok(['person', 'auto'].includes(r.sent));
  for (const e of r.errors) {
    assert.ok(['error', 'rejection', 'panic', 'worker', 'shown', 'slow'].includes(e.kind), e.kind);
    assert.ok(e.message.length >= 1 && e.message.length <= 500);
    if (e.kind !== 'slow') {
      assert.equal(e.what, undefined);
      assert.equal(e.snapshot, undefined);
      continue;
    }
    assert.ok(['latency', 'stutter', 'slow_tap', 'long_job'].includes(e.what), e.what);
    assert.ok(Number.isInteger(e.ms) && e.ms >= 0);
    const s = e.snapshot;
    if (!s) continue;
    assert.ok(s.running.length <= 10);
    for (const j of s.running) {
      assert.match(j.job, NAME);
      assert.ok(Number.isInteger(j.ms));
    }
    for (const k of ['doing', 'tool', 'strokes_bucket', 'zoom_bucket', 'recognizer']) if (s[k] !== undefined) assert.match(s[k], NAME, k);
    assert.ok((s.scripts || []).length <= 5);
    for (const sc of s.scripts || []) {
      assert.ok(sc.source.length >= 1 && sc.source.length <= 80);
      if (sc.function) assert.ok(sc.function.length <= 80);
      assert.ok(Number.isInteger(sc.ms));
    }
  }
  if (r.sent === 'auto') {
    assert.ok(r.errors.length > 0);
    assert.ok(r.errors.every((e) => e.kind === 'slow'));
    assert.equal(r.comment, undefined);
  }
}

test('the watcher notices pen lag, stutters, slow taps and long jobs, with what was running', async () => {
  const { page, ctx } = await openApp(env);
  const got = await page.evaluate(async () => {
    const { PerfWatcher } = await import('/src/perf.js');
    const out = [];
    let t = 1000;
    const w = new PerfWatcher({
      record: (e) => out.push(e),
      now: () => t,
      facts: () => ({ doing: 'writing', tool: 'pen', strokes: 1234, zoom: 1.5, recognizer: 'both', secret: 'My diary' }),
    });
    // A smooth stroke: nothing.
    for (let i = 0; i < 20; i++) { t += 8; w.frame({ latency: 12, drawing: true }); }
    w.frame({ drawing: false });
    const smooth = out.length;
    // A laggy stroke while saving.
    const endSave = w.start('save');
    for (let i = 0; i < 20; i++) { t += 8; w.frame({ latency: 40, drawing: true }); }
    w.frame({ drawing: false });
    // One frame long after the pen moved.
    t += 150; w.frame({ latency: 150, moving: true });
    t += 2500; endSave(); // a save of over 2 s
    w.tap(90);
    w.tap(320);
    // Not every job is timed against a limit.
    w.job('export', () => { t += 9000; });
    return { smooth, out };
  });
  assert.equal(got.smooth, 0, 'a smooth stroke is not an episode');
  assert.deepEqual(got.out.map((e) => e.what), ['latency', 'stutter', 'long_job', 'slow_tap']);
  const [lag, stutter, job, tap] = got.out;
  assert.equal(lag.ms, 40);
  assert.equal(lag.message, 'The pen lagged');
  assert.deepEqual(lag.snapshot.running, [{ job: 'save', ms: 160, running: true }]);
  assert.equal(lag.snapshot.doing, 'writing');
  assert.equal(lag.snapshot.tool, 'pen');
  assert.equal(lag.snapshot.strokes_bucket, '1k-5k');
  assert.equal(lag.snapshot.zoom_bucket, '1-2');
  assert.equal(lag.snapshot.recognizer, 'both');
  assert.ok(!JSON.stringify(got.out).includes('diary'), 'only the known facts, as classes');
  assert.equal(stutter.ms, 150);
  assert.equal(job.message, 'A job took long: save');
  assert.ok(job.ms > 2000);
  assert.deepEqual(job.snapshot.running.map((j) => [j.job, !!j.running]), [['save', false]], 'the job that just ended');
  assert.equal(tap.ms, 320);
  await ctx.close();
});

test('scripts of Obsidian, other plugins and extensions are labelled, never named', async () => {
  const { page, ctx } = await openApp(env);
  const got = await page.evaluate(async () => {
    const { PerfWatcher, scriptSource } = await import('/src/perf.js');
    const base = 'app://abc123/Users/frederik/Vault/.obsidian/plugins/bedrock-notes/web/';
    const labels = [
      `${base}src/main.js`,
      'plugin:secret-journal-plugin',
      'app://obsidian.md/app.js',
      'chrome-extension://abcdef/content.js',
      'https://example.com/tracker.js',
      '',
    ].map((u) => scriptSource(u, { appBase: base }));
    let t = 0;
    const out = [];
    const w = new PerfWatcher({ record: (e) => out.push(e), now: () => t, appBase: base });
    w.longFrame({ startTime: 100, duration: 180, scripts: [
      { sourceURL: `${base}src/main.js`, sourceFunctionName: 'onFrame', duration: 90 },
      { sourceURL: 'plugin:secret-journal-plugin', sourceFunctionName: 'indexMyDiary', duration: 70 },
      { sourceURL: `${base}src/main.js`, sourceFunctionName: 'onFrame', duration: 10 },
    ] });
    t = 290;
    w.frame({ latency: 180, drawing: true });
    return { labels, out };
  });
  assert.deepEqual(got.labels, ['main.js', 'another plugin', 'obsidian', 'extension', 'other', 'unknown']);
  assert.deepEqual(got.out[0].snapshot.scripts, [
    { source: 'main.js', function: 'onFrame', ms: 100 },
    { source: 'another plugin', ms: 70 },
  ]);
  const text = JSON.stringify(got.out);
  assert.ok(!/secret|Diary|frederik|Vault/.test(text), text);
  await ctx.close();
});

test('a laggy stroke in the app is logged with what was running, and repeats add to one entry', async () => {
  const { page, ctx } = await openApp(env);
  await page.evaluate(() => {
    // The page is busy for 120 ms on each pen move, as if something else ran.
    document.getElementById('stage').addEventListener('pointermove', () => {
      const end = performance.now() + 120;
      while (performance.now() < end) { /* busy */ }
    }, { capture: true });
  });
  await page.evaluate(async () => {
    const endSave = window.bedrock.perf.start('save');
    // A frame after each move, as on a real iPad.
    t.ev('pointerdown', 1, 'pen', 200, 300);
    for (let i = 1; i <= 6; i++) {
      t.ev('pointermove', 1, 'pen', 200 + i * 20, 300 + i * 2);
      await t.frame();
    }
    t.ev('pointerup', 1, 'pen', 320, 312, { pressure: 0 });
    await t.frame();
    endSave();
  });
  const slow = await page.evaluate(() => window.bedrockErrors.entries().filter((e) => e.kind === 'slow'));
  assert.ok(slow.length >= 1, JSON.stringify(slow));
  const stutter = slow.find((e) => e.what === 'stutter');
  assert.ok(stutter, JSON.stringify(slow));
  assert.ok(stutter.ms > 100);
  assert.ok(stutter.snapshot.running.some((j) => j.job === 'save'), JSON.stringify(stutter.snapshot));
  assert.equal(stutter.snapshot.tool, 'pen');
  assert.equal(stutter.snapshot.strokes_bucket, '0-100');
  // Within 30 s, the same kind of moment adds to the same entry.
  assert.equal(slow.filter((e) => e.what === 'stutter').length, 1);
  await ctx.close();
});

test('after 3 slow moments a quiet notice offers Details; the report is version 2 and sends', async () => {
  const ctx = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const sent = await fakeBackend(ctx);
  const { page } = await openApp(env, { context: ctx });
  await page.evaluate(() => {
    window.bedrockErrors.record('error', new Error('boom'));
    document.querySelector('.bx-notice')?.remove();
  });
  await page.evaluate(() => {
    const s = window.bedrockErrors;
    s.slow({ what: 'latency', ms: 40, message: 'The pen lagged', snapshot: { running: [{ job: 'recognize', ms: 900, running: true }], tool: 'pen' } });
    s.slow({ what: 'nonsense', ms: 1 }); // not a kind: ignored
    s.slow({ what: 'stutter', ms: 140, message: 'Bedrock stuttered' });
  });
  assert.equal(await page.locator('.bx-notice:has-text("Bedrock seems slow")').count(), 0, 'two are not enough');
  await page.evaluate(() => window.bedrockErrors.slow({ what: 'slow_tap', ms: 300, message: 'A tap was slow to answer' }));
  const entries = await page.evaluate(() => window.bedrockErrors.entries());
  assert.deepEqual(entries.map((e) => e.kind), ['error', 'slow', 'slow', 'slow']);
  await page.evaluate(() => { window.bedrockErrors.open(); });
  await page.waitForSelector('.bx-panel');
  const shown = JSON.parse(await page.textContent('.bx-panel pre'));
  assertValidV2(shown);
  assert.equal(shown.sent, 'person');
  assert.deepEqual(shown.errors.map((e) => e.what), [undefined, 'latency', 'stutter', 'slow_tap']);
  assert.equal(shown.errors[1].snapshot.running[0].job, 'recognize');
  await page.click('.bx-panel .bx-send');
  await page.waitForFunction(() => /Sent/.test(document.querySelector('.bx-panel .bx-status').textContent));
  assert.equal(sent[0].version, 2);
  await ctx.close();
});

test('the slow notice shows after 3 moments in 5 minutes', async () => {
  const { page, ctx } = await openApp(env);
  for (const what of ['latency', 'stutter', 'slow_tap']) {
    await page.evaluate((w) => window.bedrockErrors.slow({ what: w, ms: 200, message: w }), what);
  }
  await page.waitForSelector('.bx-notice');
  assert.match(await page.textContent('.bx-notice'), /Bedrock seems slow/);
  await page.click('.bx-notice button:text("Details")');
  await page.waitForSelector('.bx-panel');
  assert.match(await page.textContent('.bx-panel p'), /was slow/);
  await ctx.close();
});

test('automatic performance reports are off until agreed, send slow entries only, at most 3 a day', async () => {
  const ctx = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const sent = await fakeBackend(ctx);
  const { page } = await openApp(env, { context: ctx });
  assert.equal(await page.evaluate(() => window.bedrock.autoSender.on), false, 'off by default');
  await page.evaluate(() => window.bedrockErrors.slow({ what: 'stutter', ms: 150, message: 'before' }));
  assert.equal(await page.evaluate(() => window.bedrock.autoSender.flush()), 'off');

  await page.click('#btn-menu');
  let consent = '';
  page.once('dialog', (d) => { consent = d.message(); d.dismiss(); });
  await page.click('#auto-perf');
  assert.match(consent, /No notes, no words, no file names/);
  assert.match(consent, /At most 3 reports a day/);
  assert.equal(await page.isChecked('#auto-perf'), false, 'saying no keeps it off');
  page.once('dialog', (d) => d.accept());
  await page.click('#auto-perf');
  assert.equal(await page.isChecked('#auto-perf'), true);
  assert.equal(await page.evaluate(() => window.bedrock.autoSender.on), true);

  // An error and a slow moment: only the slow moment goes, without comment.
  await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 5));
    window.bedrockErrors.record('error', new Error('not sent automatically'));
    window.bedrockErrors.slow({ what: 'long_job', ms: 2600, message: 'A job took long: save', snapshot: { running: [{ job: 'save', ms: 2600 }] } });
  });
  assert.equal(await page.evaluate(() => window.bedrock.autoSender.flush()), 'sent');
  assert.equal(sent.length, 1);
  assertValidV2(sent[0]);
  assert.equal(sent[0].sent, 'auto');
  assert.deepEqual(sent[0].errors.map((e) => e.message), ['A job took long: save'], 'not what happened before it was switched on');
  assert.equal(await page.evaluate(() => window.bedrock.autoSender.flush()), 'nothing', 'nothing is sent twice');

  for (let i = 0; i < 3; i++) {
    await page.evaluate(async (n) => {
      await new Promise((r) => setTimeout(r, 5));
      window.bedrockErrors.slow({ what: 'latency', ms: 30 + n, message: `lag ${n}` });
    }, i);
    await page.evaluate(() => window.bedrock.autoSender.flush());
  }
  assert.equal(sent.length, 3, 'at most 3 a day');
  // While it is on, slow moments do not show a notice.
  for (const what of ['latency', 'stutter', 'slow_tap']) {
    await page.evaluate((w) => window.bedrockErrors.slow({ what: w, ms: 200, message: `${w}!` }), what);
  }
  assert.equal(await page.locator('.bx-notice:has-text("Bedrock seems slow")').count(), 0);
  // Switching it off stops it.
  await page.click('#auto-perf');
  assert.equal(await page.evaluate(() => window.bedrock.autoSender.flush()), 'off');
  await ctx.close();
});
