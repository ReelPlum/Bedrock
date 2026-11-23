// The pen that writes while a note opens (openspec saving-and-opening):
// SVG and CSS in index.html, shown from the first paint, and by
// src/note-loading.js whenever a note is being opened.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openApp } from './helpers.mjs';

let env;
before(async () => { env = await launch(); });
after(async () => { await env?.close(); });

const state = (page) => page.evaluate(() => {
  const el = document.getElementById('note-loading');
  return { hidden: el.hidden, label: el.textContent.trim(), role: el.getAttribute('role') };
});

test('the pen writes while the app starts, and goes once the note is open', async () => {
  const ctx = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  // Slow WebAssembly, as on a first visit over a slow connection.
  let release;
  const held = new Promise((r) => { release = r; });
  await ctx.route('**/bedrock_web_bg.wasm', async (route) => { await held; await route.continue(); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(env.url);
  await page.waitForSelector('#note-loading');
  await page.waitForTimeout(500);
  const early = await page.evaluate(() => {
    const el = document.getElementById('note-loading');
    return {
      hidden: el.hidden,
      opacity: Number(getComputedStyle(el).opacity),
      ready: !!window.bedrock?.ready,
      covers: el.getBoundingClientRect().width === innerWidth && el.getBoundingClientRect().height === innerHeight,
      moving: document.getAnimations().map((a) => a.animationName).filter((n) => n.startsWith('nl-')).sort(),
    };
  });
  assert.equal(early.ready, false, 'the app is still loading');
  assert.equal(early.hidden, false, 'the pen shows from the first paint');
  assert.equal(early.opacity, 1, 'faded in');
  assert.ok(early.covers, 'it covers the canvas');
  assert.deepEqual(early.moving, ['nl-draw', 'nl-hop', 'nl-in', 'nl-move', 'nl-spark', 'nl-wiggle']);
  const s = await state(page);
  assert.equal(s.role, 'status');
  assert.equal(s.label, 'Opening note…', 'screen readers hear what is happening');
  release();
  await page.waitForFunction(() => window.bedrock?.ready, null, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('note-loading').hidden, null, { timeout: 2000 });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a note that takes a moment to open shows the pen while it opens, and its ink as soon as it has; a quick one shows nothing', async () => {
  const { page, ctx, errors } = await openApp(env);
  await page.evaluate(async () => {
    await t.line(200, 300, 500, 320);
    await bedrock.saveNow();
    window.first = bedrock.noteId;
    await bedrock.newNote();
  });
  assert.equal((await state(page)).hidden, true);
  // It waits a moment before fading in, so a quick open does not flash.
  const fade = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('note-loading'));
    return { name: cs.animationName, delay: parseFloat(cs.animationDelay) };
  });
  assert.equal(fade.name, 'nl-in');
  assert.ok(fade.delay >= 0.1, `fades in after a moment (${fade.delay}s)`);

  const opened = await page.evaluate(async () => {
    const get = bedrock.store.get.bind(bedrock.store);
    bedrock.store.get = async (id) => { await new Promise((r) => setTimeout(r, 700)); return get(id); };
    const done = bedrock.openNote(window.first);
    await new Promise((r) => setTimeout(r, 400));
    const el = document.getElementById('note-loading');
    const during = { hidden: el.hidden, opacity: Number(getComputedStyle(el).opacity) };
    await done;
    bedrock.store.get = get;
    return { during, strokes: bedrock.canvas.stroke_count() };
  });
  assert.equal(opened.strokes, 1, 'the note opened');
  assert.equal(opened.during.hidden, false, 'the pen showed while it opened');
  assert.equal(opened.during.opacity, 1);
  assert.equal((await state(page)).hidden, true, 'and goes at once when it has, so its ink shows straight away');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the nib stays on the end of the line while the pen writes', async () => {
  const { page, ctx } = await openApp(env);
  const gaps = await page.evaluate(async () => {
    bedrock.loading.show();
    await new Promise((r) => requestAnimationFrame(r));
    const line = document.querySelector('.nl-line');
    const ink = document.querySelector('.nl-ink').getBoundingClientRect();
    const pen = document.querySelector('.nl-pen');
    const anchor = getComputedStyle(pen).offsetAnchor.split(' ').map(parseFloat);
    const length = line.getTotalLength();
    const out = [];
    for (let t = 200; t <= 1500; t += 100) {
      for (const a of document.getAnimations()) { a.pause(); a.currentTime = t; }
      const drawn = 1 - parseFloat(getComputedStyle(line).strokeDashoffset) / 100;
      const end = line.getPointAtLength(length * drawn);
      const box = pen.getBoundingClientRect();
      out.push(Math.hypot(box.left + anchor[0] - (ink.left + end.x), box.top + anchor[1] - (ink.top + end.y)));
    }
    bedrock.loading.hide();
    return out;
  });
  assert.ok(gaps.every((g) => g < 1.5), `nib to line end, in pixels: ${gaps.map((g) => g.toFixed(2)).join(' ')}`);
  await ctx.close();
});

test('with reduced motion the pen rests at the end of a finished line, still', async () => {
  const context = await env.browser.newContext({ viewport: { width: 1024, height: 768 }, reducedMotion: 'reduce' });
  const { page } = await openApp(env, { context });
  const still = await page.evaluate(async () => {
    bedrock.loading.show();
    await new Promise((r) => setTimeout(r, 100));
    const el = document.getElementById('note-loading');
    const out = {
      opacity: Number(getComputedStyle(el).opacity),
      moving: document.getAnimations().map((a) => a.animationName).filter((n) => n.startsWith('nl-') && n !== 'nl-in'),
      offset: parseFloat(getComputedStyle(document.querySelector('.nl-line')).strokeDashoffset),
      distance: getComputedStyle(document.querySelector('.nl-pen')).offsetDistance,
    };
    bedrock.loading.hide();
    return out;
  });
  assert.deepEqual(still.moving, [], 'nothing moves');
  assert.equal(still.offset, 0, 'the line is drawn in full');
  assert.equal(still.distance, '100%', 'the pen is at its end');
  assert.equal(still.opacity, 1, 'shown at once');
  await context.close();
});
