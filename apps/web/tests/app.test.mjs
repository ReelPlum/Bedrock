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

test('two-finger double tap undoes and three-finger double tap redoes; single taps do nothing', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    await t.line(200, 300, 600, 300);
    let id = 40;
    const tap = async (n) => {
      const ids = Array.from({ length: n }, () => id++);
      ids.forEach((p, i) => t.ev('pointerdown', p, 'touch', 300 + i * 60, 500));
      ids.forEach((p, i) => t.ev('pointerup', p, 'touch', 300 + i * 60, 500));
      await t.frame();
      return bedrock.canvas.stroke_count();
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const start = bedrock.canvas.stroke_count();
    const single = await tap(2);
    await wait(500); // longer than the double-tap window
    await tap(2);
    const undone = await tap(2);
    await wait(500);
    const singleRedo = await tap(3);
    await wait(500);
    await tap(3);
    const redone = await tap(3);
    return [start, single, undone, singleRedo, redone];
  });
  assert.deepEqual(r, [1, 1, 0, 0, 1]);
  await ctx.close();
});

test('lifting the pencil ends the line: hover moves after lift add no ink', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    bedrock.canvas.set_paper('plain');
    t.ev('pointerdown', 1, 'pen', 200, 300, { pressure: 0.5 });
    for (let x = 210; x <= 400; x += 10) t.ev('pointermove', 1, 'pen', x, 300, { pressure: 0.5 });
    // The tip leaves the glass: Safari keeps sending moves with pressure 0 and
    // no buttons before (or instead of) pointerup.
    for (let x = 410; x <= 600; x += 10) t.ev('pointermove', 1, 'pen', x, 300, { pressure: 0, buttons: 0 });
    t.ev('pointerup', 1, 'pen', 600, 300, { pressure: 0 });
    await t.frame();
    const note = JSON.parse(bedrock.canvas.export_json());
    const n = note.channels.length, xi = note.channels.indexOf('x');
    const xs = note.strokes[0].points.filter((_, i) => i % n === xi);
    return { strokes: note.strokes.length, drawn: t.isInk(300, 300), tail: t.isInk(500, 300), maxX: Math.max(...xs) };
  });
  assert.equal(r.strokes, 1);
  assert.ok(r.drawn, 'ink where the tip touched');
  assert.ok(!r.tail, 'no ink where the tip only hovered');
  assert.ok(r.maxX < 420, `stroke ends at the lift point, not at ${r.maxX}`);
  await ctx.close();
});

test('stroke edges are antialiased, not stair-stepped', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    bedrock.canvas.set_paper('plain');
    await t.line(200, 200, 700, 330, { pressure: 0.6 }); // shallow diagonal: worst case for aliasing
    const bg = bedrock.canvas.pixel_at(450, 600).slice(0, 3).reduce((a, b) => a + b);
    let ink = 999, partial = 0;
    for (let x = 300; x < 600; x += 7) {
      for (let y = 180; y < 360; y++) {
        const v = bedrock.canvas.pixel_at(x, y).slice(0, 3).reduce((a, b) => a + b);
        ink = Math.min(ink, v);
        if (v > ink + 60 && v < bg - 60) partial++;
      }
    }
    return { bg, ink, partial };
  });
  assert.ok(r.ink < 200, `stroke core is dark (${r.ink})`);
  assert.ok(r.partial >= 40, `edges have in-between shades (${r.partial} partial pixels)`);
  await ctx.close();
});

test('dashed and dotted line styles and the stabiliser are set per brush and saved', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    bedrock.canvas.set_paper('plain');
    const pick = (style) => {
      document.getElementById('btn-stroke').click();
      document.querySelector(`#stroke-pop [data-style="${style}"]`).click();
    };
    const runs = (y) => {
      let n = 0, prev = false;
      for (let x = 200; x <= 700; x++) {
        const [r, g, b] = bedrock.canvas.pixel_at(x, y);
        const on = r + g + b < 600; // the marker is blue, so not "dark" ink
        if (on && !prev) n++;
        prev = on;
      }
      return n;
    };
    pick('dashed');
    const stab = document.getElementById('stabilizer');
    stab.value = 40;
    stab.dispatchEvent(new Event('input'));
    await t.line(200, 200, 700, 200, { pressure: 0.6 });
    pick('dotted');
    await t.line(200, 400, 700, 400, { pressure: 0.6 });
    // Another brush keeps its own (solid) style.
    document.querySelector('[data-brush="marker"]').click();
    await t.line(200, 600, 700, 600, { pressure: 0.6 });
    const note = JSON.parse(bedrock.canvas.export_json());
    document.querySelector('[data-brush="pen"]').click();
    document.getElementById('btn-stroke').click();
    const remembered = document.querySelector('#stroke-pop [aria-checked="true"]').dataset.style;
    return {
      dashes: runs(200), dots: runs(400), solid: runs(600),
      brushes: note.strokes.map((s) => [s.brush.style ?? 'solid', s.brush.stabilizer ?? 0]),
      remembered, stabLabel: document.getElementById('stabilizer-value').textContent,
    };
  });
  assert.ok(r.dashes >= 10, `dashed line has gaps (${r.dashes} dashes)`);
  assert.ok(r.dots > r.dashes, `dotted line has more, shorter pieces (${r.dots} dots)`);
  assert.equal(r.solid, 1);
  assert.deepEqual(r.brushes, [['dashed', 0.4], ['dotted', 0.4], ['solid', 0]]);
  assert.equal(r.remembered, 'dotted');
  assert.equal(r.stabLabel, '40%');
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

// Ink latency budget (research target: under ~40 ms from pen to pixels).
// End to end = Bedrock's own work + waiting for the next display frame
// (8 ms at 120 Hz on iPad Pro, 17 ms at 60 Hz) + the compositor. The frame
// wait belongs to the browser and headless CI machines pace frames
// erratically, so this test checks the part Bedrock controls: handling a pen
// sample and drawing it must fit in half a 60 Hz frame (8 ms), which keeps
// the total inside the budget on real hardware. The full input-to-frame time
// is printed for reference, and "Show latency" displays it on a device.
test('ink latency: handling and drawing a pen sample fits in half a frame', async () => {
  const { page, ctx } = await openApp(env);
  const budget = Number(process.env.BEDROCK_WORK_BUDGET_MS || 8);
  const r = await page.evaluate(async () => {
    const c = bedrock.canvas;
    const work = [];
    const frame = [];
    t.ev('pointerdown', 9, 'pen', 100, 400);
    await t.frame();
    for (let i = 0; i < 120; i++) {
      const start = performance.now();
      t.ev('pointermove', 9, 'pen', 100 + i * 5, 400 + Math.sin(i / 5) * 60, { pressure: 0.5 });
      c.render(); // exactly what the next animation frame does
      work.push(performance.now() - start);
      await new Promise((res) => requestAnimationFrame(res));
      frame.push(performance.now() - start);
    }
    t.ev('pointerup', 9, 'pen', 700, 400);
    const p95 = (a) => a.sort((x, y) => x - y)[Math.floor(a.length * 0.95)];
    return { work: p95(work), frame: p95(frame) };
  });
  console.log(`p95 Bedrock work ${r.work.toFixed(2)} ms, p95 input→frame incl. browser frame wait ${r.frame.toFixed(1)} ms`);
  assert.ok(r.work < budget, `p95 work per pen sample ${r.work.toFixed(2)} ms exceeds ${budget} ms`);
  await ctx.close();
});
