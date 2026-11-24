// Manual end-to-end check against the real backend running locally:
// the app's samples must pass the backend's own checks.
//
//   BACKEND=/path/to/Bedrock-Backend node tests/e2e-backend.manual.mjs
//
// Not part of `npm test`: it needs the private backend repository (with
// `npm install` done in its worker folder).
import { spawn, execFileSync } from 'node:child_process';
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
// The backend keeps codes as keyed BLAKE3 hashes (docs/security.md). Node has
// no BLAKE3, so the hashes of the two codes under this test key are written
// out (made with `bedrock-data hash` and the hash key set to CODE_KEY; the Worker reads it as HASH_KEY).
const CODE_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const INVITE_HASH = 'b3:8e17709cd503ad150d4a4a9bba16c58b46d32c2013991feadaacfab801cada8d';
const ADMIN_HASH = 'b3:8feca8359a9ff321bba76167f9fa5132b49c40d1572a39cc956c46bebeda2ee7';
const [INVITE, ADMIN, PORT, APP_PORT] = ['e2e-invite', 'e2e-admin', 8798, 8797];
const API = `http://127.0.0.1:${PORT}`;
const localEnv = { ...process.env, CI: '1', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };

const state = mkdtempSync(join(tmpdir(), 'bedrock-e2e-'));
execFileSync(wrangler, ['d1', 'migrations', 'apply', 'bedrock-training', '--local', '--persist-to', state], { cwd: worker, stdio: 'pipe', env: localEnv });
const dev = spawn(wrangler, ['dev', '--local', '--port', String(PORT), '--persist-to', state, '--var', `HASH_KEY:${CODE_KEY}`, '--var', `INVITE_HASHES:${INVITE_HASH}`, '--var', `ADMIN_HASHES:${ADMIN_HASH}`, '--var', `ALLOWED_ORIGINS:http://127.0.0.1:${APP_PORT}`], { cwd: worker, stdio: 'ignore', env: localEnv });
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
  // The address is built into the app; a page on this computer may use a stored one.
  await ctx.addInitScript((a) => localStorage.setItem('bedrock.collect.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('bedrock.collect.v1') || '{}'), api: a })), API);
  const setup = await ctx.newPage();
  await setup.goto(`${app}train/`);
  await setup.waitForFunction(() => window.setup?.ready);
  await setup.fill('#code', INVITE);
  await setup.check('#agree');
  await setup.click('#save');

  // Prompts set on the backend replace the built-in sentences.
  const put = await fetch(`${API}/v1/prompts`, { method: 'PUT', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sentences: ['Vi ses  i morgen.', 'Vi ses i morgen.'] }) });
  assert.deepEqual(await put.json(), { words: 0, sentences: 1, paragraphs: 0 });

  const page = await ctx.newPage();
  await page.goto(`${app}train/handwriting/`);
  await page.waitForFunction(() => window.trainer?.ready);
  const fromBackend = await page.evaluate(async () => {
    await trainer.promptsLoaded;
    const p = await import('/train/prompts.js');
    return { sentence: p.sentencePrompt().text, from: p.lists().fromBackend };
  });
  assert.deepEqual(fromBackend, { sentence: 'Vi ses i morgen.', from: { words: false, sentences: true, paragraphs: false } });
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

  // "Mirror my notes": two strokes in a note are mirrored whole, then one
  // is erased (undone) and the backend's copy follows.
  await page.goto(app);
  await page.waitForFunction(() => window.bedrock?.ready);
  await installPointerHelpers(page);
  page.on('dialog', (d) => d.accept());
  await page.evaluate(async () => {
    bedrock.handwriting.enabled = false;
    const box = document.getElementById('mirror-notes');
    if (!box.checked) { box.checked = true; box.dispatchEvent(new Event('change')); }
    const r = document.getElementById('stage').getBoundingClientRect();
    await t.line(r.left + 200, r.top + 200, r.left + 230, r.top + 240);
    await t.line(r.left + 500, r.top + 500, r.left + 560, r.top + 520);
  });
  const mirrored = async () => {
    await page.evaluate(() => bedrock.mirrorAll());
    const list = (await (await fetch(`${API}/v1/export/notes`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json()).notes;
    return list.map((n) => [n.strokes, n.erased]);
  };
  assert.deepEqual(await mirrored(), [[2, 0]], 'the note is mirrored whole');
  await page.evaluate(() => bedrock.canvas.undo());
  assert.deepEqual(await mirrored(), [[1, 1]], 'an undone stroke is erased in the copy');

  const rows = (await (await fetch(`${API}/v1/export`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json()).samples;
  console.table(rows.map((r) => ({ source: r.source, kind: r.kind, label: r.label, label_source: r.label_source, status: r.status, strokes: r.strokes, points: r.points, device: r.device, pointer: r.pointer, language: r.language })));
  assert.equal(rows.length, 5, 'every sample the app sent passed the backend\'s checks');
  assert.deepEqual(rows.map((r) => r.source), ['train', 'train', 'train', 'train', 'train'], 'nothing from a note is sent as a sample');
  assert.equal(rows[4].kind, 'scribble');
  assert.ok(rows[3].label.includes('\n') && rows[3].strokes >= 120, 'the paragraph kept its lines and all its strokes');

  // And "Delete my contributions" really deletes.
  setup.on('dialog', (d) => d.accept());
  await setup.click('#delete');
  await setup.waitForFunction(() => /Deleted 6 samples/.test(document.getElementById('state').textContent));
  const left = (await (await fetch(`${API}/v1/export`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json()).samples;
  assert.equal(left.length, 0);
  const notesLeft = (await (await fetch(`${API}/v1/export/notes`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json()).notes;
  assert.equal(notesLeft.length, 0, 'and the mirrors');
  console.log('ok: the app and the backend agree');
} finally {
  await browser.close();
  server.close();
  dev.kill('SIGTERM');
  rmSync(state, { recursive: true, force: true });
}
