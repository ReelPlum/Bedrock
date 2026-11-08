// End-to-end tests of the web app in Chromium: real WebAssembly, real
// WebGL2 rendering, synthetic Pointer Events shaped like Apple Pencil input.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openApp } from './helpers.mjs';

let env;
before(async () => { env = await launch(); });
after(async () => { await env?.close(); });

test('starts without errors and renders the paper', async () => {
  const { page, errors, ctx } = await openApp(env);
  const bg = await page.evaluate(() => Array.from(window.bedrock.canvas.pixel_at(13, 500)));
  assert.equal(bg[3], 255);
  assert.ok(bg[0] > 200 && bg[1] > 200 && bg[2] > 200, `paper is light: ${bg}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a pen stroke puts ink on the canvas', async () => {
  const { page, errors, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    await t.line(200, 300, 700, 300, { pressure: 0.6 });
    return { strokes: bedrock.canvas.stroke_count(), ink: t.isInk(450, 300), blank: t.isInk(450, 500) };
  });
  assert.deepEqual(r, { strokes: 1, ink: true, blank: false });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('pressure changes the line width', async () => {
  const { page, ctx } = await openApp(env);
  const [light, heavy] = await page.evaluate(async () => {
    await t.line(200, 200, 700, 200, { pressure: 0.05 });
    await t.line(200, 400, 700, 400, { pressure: 1.0 });
    return [t.thickness(450, 185, 215), t.thickness(450, 385, 415)];
  });
  assert.ok(light >= 1, `light stroke visible (${light}px)`);
  assert.ok(heavy > light, `heavy ${heavy}px should be wider than light ${light}px`);
  await ctx.close();
});

test('tilting the pencil makes a broader stroke', async () => {
  const { page, ctx } = await openApp(env);
  const [upright, tilted] = await page.evaluate(async () => {
    document.querySelector('[data-brush="pencil"]').click();
    await t.line(200, 200, 700, 200, { pressure: 0.8, tiltX: 0 });
    await t.line(200, 400, 700, 400, { pressure: 0.8, tiltX: 70 });
    const wide = (y0, y1) => {
      let n = 0;
      for (let y = y0; y <= y1; y++) {
        const [r, g, b] = bedrock.canvas.pixel_at(450, y);
        if (r + g + b < 700) n++; // pencil is lighter, use a looser threshold
      }
      return n;
    };
    return [wide(180, 220), wide(370, 430)];
  });
  assert.ok(tilted > upright * 1.5, `tilted ${tilted}px vs upright ${upright}px`);
  await ctx.close();
});

test('coalesced pen samples are all recorded, predicted ones are not saved', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    const mk = (x) => new PointerEvent('pointermove', { pointerId: 3, pointerType: 'pen', clientX: x, clientY: 300, pressure: 0.5, buttons: 1 });
    t.ev('pointerdown', 3, 'pen', 100, 300);
    // One frame's event carrying four 240 Hz samples, plus a predicted tail.
    t.ev('pointermove', 3, 'pen', 140, 300, {
      coalesced: [mk(110), mk(120), mk(130), mk(140)],
      predicted: [mk(180), mk(220)],
    });
    await t.frame();
    const liveCount = bedrock.canvas.stroke_count();
    t.ev('pointerup', 3, 'pen', 140, 300);
    await t.frame();
    const note = JSON.parse(bedrock.canvas.export_json());
    const xs = [];
    const pts = note.strokes[0].points;
    for (let i = 0; i < pts.length; i += note.channels.length) xs.push(pts[i]);
    return { liveCount, xs };
  });
  assert.equal(r.liveCount, 0, 'stroke is not committed while the pen is down');
  assert.deepEqual(r.xs, [100, 110, 120, 130, 140]);
  await ctx.close();
});

test('fingers pan the canvas and do not draw; a resting palm is ignored', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    const before = bedrock.canvas.camera();
    await t.line(500, 500, 400, 450, { id: 20, type: 'touch' });
    const after = bedrock.canvas.camera();
    // Palm rests and moves while the pen writes.
    t.ev('pointerdown', 1, 'pen', 100, 100);
    t.ev('pointerdown', 21, 'touch', 600, 600);
    t.ev('pointermove', 21, 'touch', 650, 640);
    t.ev('pointermove', 1, 'pen', 300, 100);
    t.ev('pointerup', 21, 'touch', 650, 640);
    t.ev('pointerup', 1, 'pen', 300, 100);
    await t.frame();
    return { before, after, afterPalm: bedrock.canvas.camera(), strokes: bedrock.canvas.stroke_count() };
  });
  assert.equal(r.after[0] - r.before[0], 100, 'panned with the finger');
  assert.equal(r.after[1] - r.before[1], 50);
  assert.deepEqual(r.afterPalm, r.after, 'palm did not move the canvas');
  assert.equal(r.strokes, 1, 'only the pen drew');
  await ctx.close();
});

test('two-finger tap undoes and three-finger tap redoes', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    await t.line(200, 300, 600, 300);
    const tap = async (n) => {
      for (let i = 0; i < n; i++) t.ev('pointerdown', 40 + i, 'touch', 300 + i * 60, 500);
      for (let i = 0; i < n; i++) t.ev('pointerup', 40 + i, 'touch', 300 + i * 60, 500);
      await t.frame();
      return bedrock.canvas.stroke_count();
    };
    return [bedrock.canvas.stroke_count(), await tap(2), await tap(3)];
  });
  assert.deepEqual(r, [1, 0, 1]);
  await ctx.close();
});

test('the eraser removes strokes and can be undone', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    await t.line(200, 300, 600, 300);
    document.querySelector('[data-tool="eraser"]').click();
    await t.line(400, 200, 400, 400);
    const afterErase = bedrock.canvas.stroke_count();
    bedrock.canvas.undo();
    return [afterErase, bedrock.canvas.stroke_count()];
  });
  assert.deepEqual(r, [0, 1]);
  await ctx.close();
});

test('pinch with two fingers zooms', async () => {
  const { page, ctx } = await openApp(env);
  const zoom = await page.evaluate(async () => {
    t.ev('pointerdown', 50, 'touch', 400, 400);
    t.ev('pointerdown', 51, 'touch', 600, 400);
    for (let i = 1; i <= 10; i++) {
      t.ev('pointermove', 50, 'touch', 400 - i * 10, 400);
      t.ev('pointermove', 51, 'touch', 600 + i * 10, 400);
    }
    t.ev('pointerup', 50, 'touch', 300, 400);
    t.ev('pointerup', 51, 'touch', 700, 400);
    await t.frame();
    return bedrock.canvas.camera()[2];
  });
  assert.ok(zoom > 1.8 && zoom < 2.2, `zoom ${zoom}`);
  await ctx.close();
});

test('notes autosave locally and reopen where you left off', async () => {
  const context = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const { page } = await openApp(env, { context });
  const id = await page.evaluate(async () => {
    document.getElementById('title').value = 'Physics';
    document.getElementById('title').dispatchEvent(new Event('input'));
    await t.line(200, 300, 600, 300);
    await t.line(200, 350, 600, 350);
    await t.line(500, 500, 450, 520, { id: 30, type: 'touch' }); // finger pan
    await bedrock.saveNow();
    return bedrock.noteId;
  });
  await page.waitForFunction(() => document.getElementById('save-state').textContent === 'Saved');
  const camBefore = await page.evaluate(() => bedrock.canvas.camera());
  await page.waitForTimeout(100);
  await page.reload();
  await page.waitForFunction(() => window.bedrock && window.bedrock.ready);
  const r = await page.evaluate(() => ({
    id: bedrock.noteId, strokes: bedrock.canvas.stroke_count(), title: document.getElementById('title').value,
    cam: bedrock.canvas.camera(),
  }));
  assert.equal(r.id, id);
  assert.equal(r.strokes, 2);
  assert.equal(r.title, 'Physics');
  assert.deepEqual(r.cam, camBefore);
  await context.close();
});

test('a .bedrock export opens again with identical strokes', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    for (const b of ['pen', 'pencil', 'fountain', 'marker', 'highlighter']) {
      document.querySelector(`[data-brush="${b}"]`).click();
      await t.line(100, 100 + Math.random() * 400, 800, 300, { pressure: 0.7 });
    }
    const c = bedrock.canvas;
    const before = JSON.parse(c.export_json());
    const bytes = c.export_bedrock();
    const svg = c.export_svg();
    const warnings = c.load(bytes, 1, 2);
    const after = JSON.parse(c.export_json());
    return {
      zipMagic: Array.from(bytes.slice(0, 2)), warnings, svgPaths: (svg.match(/<path /g) || []).length,
      same: JSON.stringify(before.strokes) === JSON.stringify(after.strokes),
    };
  });
  assert.deepEqual(r.zipMagic, [0x50, 0x4b]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.svgPaths, 5);
  assert.ok(r.same);
  await ctx.close();
});

test('opening a damaged note recovers what it can instead of failing', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(() => {
    const json = JSON.stringify({
      format: 'bedrock-note', version: 1,
      strokes: [
        { id: 'a1', brush: { kind: 'pen', color: '#000000', size: 2 }, points: [10, 10, 0.5, 1.5, 0, 0, 50, 50, 0.5, 1.5, 0, 4] },
        { id: 'b2', brush: { kind: 'unknown-brush', color: '#000000', size: 2 }, points: [] },
      ],
    });
    const warnings = bedrock.canvas.load(new TextEncoder().encode(json), 1, 1);
    let error = null;
    try { bedrock.canvas.load(new TextEncoder().encode('hello'), 1, 1); } catch (e) { error = String(e); }
    return { warnings: warnings.length, strokes: bedrock.canvas.stroke_count(), error };
  });
  assert.equal(r.warnings, 1);
  assert.equal(r.strokes, 1);
  assert.match(r.error, /Bedrock note/);
  await ctx.close();
});

test('ink latency: input to frame stays under the 40 ms budget', async () => {
  const { page, ctx } = await openApp(env);
  const budget = Number(process.env.BEDROCK_LATENCY_BUDGET_MS || 40);
  const samples = await page.evaluate(async () => {
    const out = [];
    t.ev('pointerdown', 9, 'pen', 100, 400);
    await t.frame();
    for (let i = 0; i < 60; i++) {
      const start = performance.now();
      t.ev('pointermove', 9, 'pen', 100 + i * 10, 400 + Math.sin(i / 5) * 60, { pressure: 0.5 });
      await new Promise((r) => requestAnimationFrame(r)); // the frame that draws it
      out.push(performance.now() - start);
    }
    t.ev('pointerup', 9, 'pen', 700, 400);
    return out;
  });
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  assert.ok(p95 < budget, `p95 input→frame ${p95.toFixed(1)} ms exceeds ${budget} ms`);
  await ctx.close();
});
