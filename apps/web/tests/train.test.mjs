// The /train pages: prompts, a writing box run by the Bedrock engine, Done.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, installPointerHelpers } from './helpers.mjs';

let env;
before(async () => { env = await launch(); });
after(async () => { await env?.close(); });

async function openTrainer(path) {
  const ctx = await env.browser.newContext({ viewport: { width: 900, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(env.url + path);
  await page.waitForFunction(() => window.trainer && window.trainer.ready, null, { timeout: 20000 });
  await installPointerHelpers(page);
  return { page, ctx, errors };
}

test('the /train page links to both trainers', async () => {
  const ctx = await env.browser.newContext();
  const page = await ctx.newPage();
  await page.goto(env.url + 'train/');
  const links = await page.$$eval('a.choice', (as) => as.map((a) => a.getAttribute('href')));
  assert.deepEqual(links, ['handwriting/', 'scribble/']);
  await ctx.close();
});

test('handwriting trainer: shows a prompt, takes ink, Done makes a sample and shows the next prompt', async () => {
  const { page, ctx, errors } = await openTrainer('train/handwriting/');
  const r = await page.evaluate(async () => {
    const done = document.getElementById('done');
    const before = { disabled: done.disabled, prompt: document.getElementById('prompt-text').textContent };
    const box = document.getElementById('stage').getBoundingClientRect();
    await t.line(box.left + 100, box.top + 120, box.left + 300, box.top + 140);
    await t.line(box.left + 320, box.top + 110, box.left + 380, box.top + 160);
    const first = trainer.prompt;
    const enabled = !done.disabled;
    done.click();
    const s = trainer.samples[0];
    return {
      before, enabled, count: document.getElementById('count').textContent,
      sample: { task: s.task, prompt: s.prompt, strokes: s.strokes.length, points: s.strokes[0].points.length, channels: s.channels },
      first, cleared: trainer.canvas.stroke_count(), disabledAgain: done.disabled,
    };
  });
  assert.equal(r.before.disabled, true, 'Done waits for ink');
  assert.ok(r.before.prompt.length > 0);
  assert.equal(r.enabled, true);
  assert.equal(r.count, '1 done');
  assert.equal(r.sample.task, 'handwriting');
  assert.deepEqual(r.sample.prompt, { kind: r.first.kind, text: r.first.text, latex: r.first.latex });
  assert.equal(r.sample.strokes, 2);
  assert.ok(r.sample.points > 10 * 6, 'raw samples, six channels each');
  assert.deepEqual(r.sample.channels, ['x', 'y', 'pressure', 'altitude', 'azimuth', 't']);
  assert.equal(r.cleared, 0);
  assert.equal(r.disabledAgain, true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('handwriting trainer: words only, maths only, never neither; maths prompts carry LaTeX', async () => {
  const { page, ctx } = await openTrainer('train/handwriting/');
  const r = await page.evaluate(() => {
    const [words, maths] = document.querySelectorAll('#options button');
    words.click(); // maths only
    const kinds = new Set();
    let latex = true;
    for (let i = 0; i < 20; i++) { trainer.next(); kinds.add(trainer.prompt.kind); latex &&= !!trainer.prompt.latex; }
    maths.click(); // would leave nothing: refused
    const stillMaths = maths.getAttribute('aria-pressed');
    words.click();
    maths.click(); // words only
    const kinds2 = new Set();
    for (let i = 0; i < 20; i++) { trainer.next(); kinds2.add(trainer.prompt.kind); }
    return { kinds: [...kinds], latex, stillMaths, kinds2: [...kinds2] };
  });
  assert.deepEqual(r.kinds, ['math']);
  assert.equal(r.latex, true);
  assert.equal(r.stillMaths, 'true');
  assert.deepEqual(r.kinds2, ['text']);
  await ctx.close();
});

test('scribble trainer: the word to scribble out is in the box, and only one stroke is taken', async () => {
  const { page, ctx, errors } = await openTrainer('train/scribble/');
  const r = await page.evaluate(async () => {
    const target = document.getElementById('target').textContent;
    const box = document.getElementById('stage').getBoundingClientRect();
    const cy = box.top + box.height / 2;
    // A zig-zag scribble in one stroke.
    t.ev('pointerdown', 1, 'pen', box.left + 300, cy);
    for (let i = 1; i <= 24; i++) t.ev('pointermove', 1, 'pen', box.left + 300 + (i % 2 ? 200 : 0), cy - 30 + i * 2.5);
    t.ev('pointerup', 1, 'pen', box.left + 300, cy + 30);
    await t.frame();
    await t.line(box.left + 100, cy, box.left + 200, cy); // a second stroke: refused
    const n = trainer.canvas.stroke_count();
    const warned = document.getElementById('hint').classList.contains('warn');
    document.getElementById('undo').click();
    await t.line(box.left + 100, cy, box.left + 200, cy); // after Undo: taken
    const n2 = trainer.canvas.stroke_count();
    document.getElementById('done').click();
    return { target, n, warned, n2, sample: trainer.samples[0].task, prompt: trainer.samples[0].prompt.text };
  });
  assert.ok(r.target.length > 0);
  assert.equal(r.n, 1, 'only the scribble');
  assert.equal(r.warned, true);
  assert.equal(r.n2, 1);
  assert.equal(r.sample, 'scribble');
  assert.equal(r.prompt, r.target);
  assert.deepEqual(errors, []);
  await ctx.close();
});
