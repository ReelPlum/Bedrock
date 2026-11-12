// Manual end-to-end check against the real backend running locally:
// the app's samples must pass the backend's own checks.
//
//   BACKEND=/path/to/Bedrock-Backend node tests/e2e-backend.manual.mjs
//
// Not part of `npm test`: it needs the private backend repository (with
// `npm install` done in its worker folder).
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from '../serve.mjs';
import { installPointerHelpers } from './helpers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const worker = join(process.env.BACKEND || '../../../Bedrock-Backend', 'worker');
const wrangler = join(worker, 'node_modules', '.bin', 'wrangler');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const [INVITE, ADMIN, PORT, APP_PORT] = ['e2e-invite', 'e2e-admin', 8798, 8797];
const API = `http://127.0.0.1:${PORT}`;
const localEnv = { ...process.env, CI: '1', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };

const state = mkdtempSync(join(tmpdir(), 'bedrock-e2e-'));
execFileSync(wrangler, ['d1', 'migrations', 'apply', 'bedrock-training', '--local', '--persist-to', state], { cwd: worker, stdio: 'pipe', env: localEnv });
const dev = spawn(wrangler, ['dev', '--local', '--port', String(PORT), '--persist-to', state, '--var', `INVITE_HASHES:${sha(INVITE)}`, '--var', `ADMIN_HASHES:${sha(ADMIN)}`, '--var', `ALLOWED_ORIGINS:http://127.0.0.1:${APP_PORT}`], { cwd: worker, stdio: 'ignore', env: localEnv });
const server = await startServer(APP_PORT);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${API}/v1/health`)).ok) break; } catch (_) { /* not up yet */ }
    if (i > 600) throw new Error('the Worker did not start');
    await new Promise((r) => setTimeout(r, 500));
  }
  const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
  const app = `http://127.0.0.1:${APP_PORT}/`;
  const sent = async (page, n) => {
    for (let i = 0; i < 200; i++) {
      if (await page.evaluate(async (k) => (await (await import('/src/collect.js')).status()).sent === k, n)) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`not sent: ${JSON.stringify(await page.evaluate(async () => (await import('/src/collect.js')).status()))}`);
  };

  // Consent, then three training samples (words, maths) and a scribble.
  const setup = await ctx.newPage();
  await setup.goto(`${app}train/`);
  await setup.waitForFunction(() => window.setup?.ready);
  await setup.fill('#code', INVITE);
  await setup.evaluate((a) => { document.getElementById('api').value = a; }, API);
  await setup.check('#agree');
  await setup.click('#save');

  const page = await ctx.newPage();
  await page.goto(`${app}train/handwriting/`);
  await page.waitForFunction(() => window.trainer?.ready);
  await installPointerHelpers(page);
  await page.evaluate(async () => (await import('/src/collect.js')).setSendInterval(0));
  for (let i = 0; i < 3; i++) {
    await page.evaluate(async () => {
      const box = document.getElementById('stage').getBoundingClientRect();
      await t.line(box.left + 100, box.top + 120, box.left + 300, box.top + 140);
      await t.line(box.left + 320, box.top + 110, box.left + 380, box.top + 160);
      document.getElementById('done').click();
    });
  }
  await sent(page, 3);
  // A paragraph, written line by line: about 160 strokes, label with line breaks.
  await page.evaluate(async () => {
    for (const b of document.querySelectorAll('#options button')) if (b.textContent !== 'Paragraphs') b.click();
    trainer.next();
    const box = document.getElementById('stage').getBoundingClientRect();
    const lines = trainer.prompt.text.split('\n');
    for (let k = 0; k < lines.length; k++) {
      for (let i = 0; i < 40; i++) await t.line(box.left + 30 + i * 18, box.top + 40 + k * 64, box.left + 40 + i * 18, box.top + 70 + k * 64);
    }
    document.getElementById('done').click();
  });
  await sent(page, 4);
  await page.goto(`${app}train/scribble/`);
  await page.waitForFunction(() => window.trainer?.ready);
  await installPointerHelpers(page);
  await page.evaluate(async () => (await import('/src/collect.js')).setSendInterval(0));
  await page.evaluate(async () => {
    const box = document.getElementById('stage').getBoundingClientRect();
    await t.line(box.left + 300, box.top + 200, box.left + 500, box.top + 220);
    document.getElementById('done').click();
  });
  await sent(page, 5);

  // "Send every word": two words from a note go up unchecked, then the
  // writer corrects one and says the other is not a word.
  await page.goto(app);
  await page.waitForFunction(() => window.bedrock?.ready);
  await installPointerHelpers(page);
  await page.evaluate(async () => (await import('/src/collect.js')).setSendInterval(0));
  const words = () => page.evaluate(() => JSON.parse(bedrock.canvas.words_json()));
  await page.evaluate(async () => {
    bedrock.handwriting.enabled = false;
    bedrock.wordSharer.settleMs = 0;
    document.getElementById('share-words').click();
    const box = document.getElementById('stage').getBoundingClientRect();
    await t.line(box.left + 200, box.top + 200, box.left + 230, box.top + 240);
    await t.line(box.left + 500, box.top + 500, box.left + 560, box.top + 520);
    const [a, b] = JSON.parse(bedrock.canvas.words_json());
    bedrock.canvas.set_word_text(a.id, 'helo', 'text', 'Xenova/trocr-small-handwritten (fake)', 0.8);
    bedrock.canvas.set_word_text(b.id, 'x', 'text', 'Xenova/trocr-small-handwritten (fake)', 0.4);
    await bedrock.wordSharer.scan();
  });
  assert.equal((await words()).length, 2);
  await sent(page, 7);
  await page.evaluate(() => bedrock.wordMenu.open(JSON.parse(bedrock.canvas.words_json())[0]));
  await page.click('#wm-correct');
  await page.fill('#wm-correct-text', 'hello');
  await page.press('#wm-correct-text', 'Enter');
  await sent(page, 8);
  await page.evaluate(() => bedrock.wordMenu.open(JSON.parse(bedrock.canvas.words_json())[1]));
  await page.click('#wm-drawing');
  await sent(page, 9);

  const rows = (await (await fetch(`${API}/v1/export`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json()).samples;
  console.table(rows.map((r) => ({ source: r.source, kind: r.kind, label: r.label, label_source: r.label_source, model_reading: r.model_reading, status: r.status, strokes: r.strokes, points: r.points, device: r.device, pointer: r.pointer, language: r.language })));
  assert.equal(rows.length, 9, 'every sample the app sent passed the backend\'s checks');
  assert.deepEqual(rows.map((r) => r.source), ['train', 'train', 'train', 'train', 'train', 'note', 'note', 'note', 'note']);
  assert.equal(rows[4].kind, 'scribble');
  assert.ok(rows[3].label.includes('\n') && rows[3].strokes >= 120, 'the paragraph kept its lines and all its strokes');
  const note = rows.slice(5).map((r) => [r.kind, r.label, r.label_source, r.status]);
  assert.deepEqual(note.sort(), [
    ['drawing', '', 'corrected', 'new'],
    ['text', 'hello', 'corrected', 'new'],
    ['text', 'helo', 'unchecked', 'superseded'],
    ['text', 'x', 'unchecked', 'superseded'],
  ]);

  // And "Delete my contributions" really deletes.
  setup.on('dialog', (d) => d.accept());
  await setup.click('#delete');
  await setup.waitForFunction(() => /Deleted 9 samples/.test(document.getElementById('state').textContent));
  const left = (await (await fetch(`${API}/v1/export`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json()).samples;
  assert.equal(left.length, 0);
  console.log('ok: the app and the backend agree');
} finally {
  await browser.close();
  server.close();
  dev.kill('SIGTERM');
  rmSync(state, { recursive: true, force: true });
}
