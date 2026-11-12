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
      sample: { format: s.format, version: s.version, source: s.source, kind: s.kind, label: s.label, labelSource: s.label_source, strokes: s.strokes.length, points: s.strokes[0].points.length, channels: s.channels, keys: Object.keys(s.strokes[0]) },
      first, cleared: trainer.canvas.stroke_count(), disabledAgain: done.disabled,
    };
  });
  assert.equal(r.before.disabled, true, 'Done waits for ink');
  assert.ok(r.before.prompt.length > 0);
  assert.equal(r.enabled, true);
  assert.equal(r.count, '1 done');
  assert.deepEqual([r.sample.format, r.sample.version, r.sample.source, r.sample.labelSource], ['bedrock-training', 2, 'train', 'prompt']);
  assert.equal(r.sample.kind, r.first.kind);
  assert.equal(r.sample.label, r.first.kind === 'math' ? r.first.latex : r.first.text, 'a formula is labelled with its LaTeX');
  assert.deepEqual(r.sample.keys, ['start', 'points'], 'no brush, colour or stroke id leaves the device');
  assert.equal(r.sample.strokes, 2);
  assert.ok(r.sample.points > 10 * 6, 'raw samples, six channels each');
  assert.deepEqual(r.sample.channels, ['x', 'y', 'pressure', 'altitude', 'azimuth', 't']);
  assert.equal(r.cleared, 0);
  assert.equal(r.disabledAgain, true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('handwriting trainer: any mix of words, sentences, paragraphs and maths, never none; maths prompts carry LaTeX', async () => {
  const { page, ctx } = await openTrainer('train/handwriting/');
  const r = await page.evaluate(() => {
    const buttons = Object.fromEntries([...document.querySelectorAll('#options button')].map((b) => [b.textContent, b]));
    const only = (name) => {
      if (buttons[name].getAttribute('aria-pressed') !== 'true') buttons[name].click();
      for (const [n, b] of Object.entries(buttons)) if (n !== name && b.getAttribute('aria-pressed') === 'true') b.click();
    };
    const shapes = () => { const seen = new Set(); for (let i = 0; i < 100; i++) { trainer.next(); seen.add(trainer.prompt.kind === 'math' ? 'math' : trainer.prompt.shape); } return [...seen]; };
    const all = shapes();
    // Maths only; turning it off too would leave nothing, so it is refused.
    for (const b of Object.values(buttons)) if (b.textContent !== 'Maths' && b.getAttribute('aria-pressed') === 'true') b.click();
    let latex = true;
    const maths = new Set();
    for (let i = 0; i < 20; i++) { trainer.next(); maths.add(trainer.prompt.kind); latex &&= !!trainer.prompt.latex; }
    buttons.Maths.click();
    const stillMaths = buttons.Maths.getAttribute('aria-pressed');
    only('Sentences');
    const sentences = shapes();
    const oneSentence = trainer.prompt;
    only('Paragraphs');
    const paragraphs = shapes();
    const p = trainer.prompt;
    return {
      names: Object.keys(buttons), all, maths: [...maths], latex, stillMaths, sentences, paragraphs,
      sentence: { text: oneSentence.text, long: document.getElementById('prompt-text').classList.contains('long') },
      paragraph: { lines: p.text.split('\n'), html: p.html, kind: p.kind, shown: document.getElementById('prompt-kind').textContent, hint: document.getElementById('hint').textContent },
    };
  });
  assert.deepEqual(r.names, ['Words', 'Sentences', 'Paragraphs', 'Maths']);
  assert.deepEqual(r.all.sort(), ['math', 'paragraph', 'sentence', 'word'], 'all four are on at first');
  assert.deepEqual(r.maths, ['math']);
  assert.equal(r.latex, true);
  assert.equal(r.stillMaths, 'true');
  assert.deepEqual(r.sentences, ['sentence']);
  assert.match(r.sentence.text, /^[A-Z].*[.?!]$/, 'a whole sentence');
  assert.deepEqual(r.paragraphs, ['paragraph']);
  assert.equal(r.paragraph.kind, 'text');
  assert.ok(r.paragraph.lines.length >= 3 && r.paragraph.lines.every((l) => l.length <= 32), 'shown in short lines');
  assert.equal(r.paragraph.html.split('class="line"').length - 1, r.paragraph.lines.length, 'shown with the same line breaks');
  assert.equal(r.paragraph.shown, 'Write this paragraph');
  assert.match(r.paragraph.hint, /line by line/);
  await ctx.close();
});

test('handwriting trainer: every paragraph fits a narrow phone line for line, so the writer breaks lines where the label does', async () => {
  const { page, ctx } = await openTrainer('train/handwriting/');
  await page.setViewportSize({ width: 340, height: 700 });
  const r = await page.evaluate(async () => {
    const { PARAGRAPHS, wrap } = await import('/train/prompts.js');
    const el = document.getElementById('prompt-text');
    el.classList.add('long');
    const bad = [];
    for (const text of PARAGRAPHS) {
      el.innerHTML = wrap(text).map((l) => `<span class="line">${l}</span>`).join('');
      if (el.scrollWidth > el.clientWidth + 1) bad.push(text);
    }
    return bad;
  });
  assert.deepEqual(r, []);
  await ctx.close();
});

test('handwriting trainer: a paragraph sample keeps its line breaks in the label', async () => {
  const { page, ctx, errors } = await openTrainer('train/handwriting/');
  const r = await page.evaluate(async () => {
    const buttons = [...document.querySelectorAll('#options button')];
    for (const b of buttons) if (b.textContent !== 'Paragraphs') b.click();
    trainer.next();
    const want = trainer.prompt.text;
    const box = document.getElementById('stage').getBoundingClientRect();
    const lines = want.split('\n').length;
    for (let k = 0; k < lines; k++) await t.line(box.left + 40, box.top + 60 + k * 70, box.left + 300, box.top + 70 + k * 70);
    document.getElementById('done').click();
    return { want, label: trainer.samples[0].label, strokes: trainer.samples[0].strokes.length };
  });
  assert.equal(r.label, r.want);
  assert.ok(r.label.includes('\n'));
  assert.ok(r.strokes >= 3);
  assert.deepEqual(errors, []);
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
    return { target, n, warned, n2, sample: trainer.samples[0].kind, prompt: trainer.samples[0].label };
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
