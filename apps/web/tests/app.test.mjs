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

test('grid paper stays fixed to the page when zooming', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    const c = bedrock.canvas;
    c.set_paper('grid');
    // Vertical grid lines crossed along a row, as css x positions.
    const lines = () => {
      const xs = [];
      let prev = false;
      for (let x = 0; x < 1000; x += 0.5) {
        const [r] = c.pixel_at(x, 101.3);
        const on = r < 235;
        if (on && !prev) xs.push(x);
        prev = on;
      }
      return xs;
    };
    const gap = (xs) => (xs[xs.length - 1] - xs[0]) / (xs.length - 1);
    const at1 = gap(lines());
    c.zoom_at(0, 0, 1.5);
    const at15 = gap(lines());
    c.zoom_at(0, 0, 2);
    const at3 = gap(lines());
    return { at1, at15, at3 };
  });
  // Bug: the spacing was re-picked at every zoom, so the grid crept and jumped.
  assert.ok(Math.abs(r.at1 - 32) < 0.6, `32 px apart at 100% (${r.at1})`);
  assert.ok(Math.abs(r.at15 - 48) < 0.8, `48 px apart at 150% (${r.at15})`);
  assert.ok(Math.abs(r.at3 - 96) < 1.5, `96 px apart at 300% (${r.at3})`);
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

test('pen pressure feel: soft draws light touches wider, is remembered, and redraws old ink', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    const size = document.getElementById('size');
    size.value = '20';
    size.dispatchEvent(new Event('input'));
    await t.line(200, 300, 700, 300, { pressure: 0.25 });
    await t.frame();
    const normal = t.thickness(450, 270, 330);
    const slider = document.getElementById('pressure');
    slider.value = '100';
    slider.dispatchEvent(new Event('input'));
    await t.frame();
    await t.frame();
    const soft = t.thickness(450, 270, 330);
    const saved = JSON.parse(localStorage.getItem('bedrock.settings.v1')).pressure;
    return { normal, soft, saved, label: document.getElementById('pressure-value').textContent };
  });
  assert.ok(r.soft > r.normal, `soft ${r.soft}px should be wider than normal ${r.normal}px`);
  assert.equal(r.saved, 100);
  assert.equal(r.label, 'Soft');
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

test('a hovering pencil shows where the tool lands and how big it is, and draws nothing', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    const el = document.getElementById('hover-cursor');
    const stage = document.getElementById('stage').getBoundingClientRect();
    const box = () => {
      const b = el.getBoundingClientRect();
      return { shown: !el.hidden, cx: b.left + b.width / 2 - stage.left, cy: b.top + b.height / 2 - stage.top, d: b.width, bg: getComputedStyle(el).backgroundColor };
    };
    const start = box();
    bedrock.canvas.set_camera(0, 0, 1);
    // Pencil Pro above the glass: moves with no buttons and no pointerdown.
    t.ev('pointermove', 7, 'pen', 300, 250, { pressure: 0, buttons: 0 });
    const at1 = box();
    bedrock.canvas.set_camera(0, 0, 2);
    t.ev('pointermove', 7, 'pen', 320, 260, { pressure: 0, buttons: 0 });
    const at2 = box();
    document.querySelector('[data-tool="eraser"]').click();
    t.ev('pointermove', 7, 'pen', 330, 270, { pressure: 0, buttons: 0 });
    const eraser = { ...box(), cls: el.classList.contains('eraser') };
    // Touching down hides it; so does going quiet (out of hover range).
    t.ev('pointerdown', 7, 'pen', 330, 270, { pressure: 0.5 });
    const down = box();
    t.ev('pointerup', 7, 'pen', 330, 270, { pressure: 0 });
    t.ev('pointermove', 7, 'pen', 340, 270, { pressure: 0, buttons: 0 });
    await new Promise((res) => setTimeout(res, 700));
    const quiet = box();
    // A mouse moving around shows nothing.
    t.ev('pointermove', 8, 'mouse', 300, 300, { buttons: 0 });
    const mouse = box();
    return { start, at1, at2, eraser, down, quiet, mouse, strokes: bedrock.canvas.stroke_count() };
  });
  assert.equal(r.start.shown, false);
  assert.ok(r.at1.shown, 'shown while hovering');
  assert.ok(Math.abs(r.at1.cx - 300) < 1 && Math.abs(r.at1.cy - 250) < 1, `centred on the tip: ${r.at1.cx},${r.at1.cy}`);
  assert.ok(r.at1.d >= 2, `brush-sized: ${r.at1.d}`);
  assert.ok(Math.abs(r.at2.d / r.at1.d - 2) < 0.05 || r.at1.d === 4, `scales with zoom: ${r.at1.d} -> ${r.at2.d}`);
  assert.notEqual(r.at1.bg, 'rgba(0, 0, 0, 0)', 'filled with the brush colour');
  assert.ok(r.eraser.shown && r.eraser.cls, 'eraser shows its ring');
  assert.equal(r.eraser.bg, 'rgba(0, 0, 0, 0)');
  assert.equal(r.down.shown, false, 'hidden while touching');
  assert.equal(r.quiet.shown, false, 'hidden once the pencil leaves');
  assert.equal(r.mouse.shown, false, 'mouse shows no hover');
  assert.equal(r.strokes, 0, 'hovering draws nothing (the touch was with the eraser)');
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

test('a big dot is a true circle, not a polygon', async () => {
  const { page, ctx } = await openApp(env);
  const radii = await page.evaluate(async () => {
    bedrock.canvas.set_paper('plain');
    document.querySelector('[data-brush="marker"]').click();
    const sz = document.getElementById('size');
    sz.value = 30;
    sz.dispatchEvent(new Event('input'));
    t.ev('pointerdown', 1, 'pen', 400, 300, { pressure: 0.6 });
    t.ev('pointerup', 1, 'pen', 400, 300, { pressure: 0 });
    await t.frame();
    // Edge radius along 48 directions, to a tenth of a pixel, from coverage.
    const out = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * 2 * Math.PI;
      let r = 0;
      for (let d = 0; d < 40; d += 0.1) {
        const [cr] = bedrock.canvas.pixel_at(400 + Math.cos(a) * d, 300 + Math.sin(a) * d);
        if (cr > 120) { r = d; break; }
      }
      out.push(r);
    }
    return out;
  });
  const min = Math.min(...radii), max = Math.max(...radii);
  assert.ok(min > 10, `dot is drawn (radius ${min})`);
  // A 12-sided polygon of radius 14 is 0.48 px flatter mid-side than at its corners.
  assert.ok(max - min <= 1.0, `edge radius varies from ${min} to ${max} px`);
  await ctx.close();
});

test('ink drawn over a highlighter stays continuous', async () => {
  const { page, ctx } = await openApp(env);
  const gaps = await page.evaluate(async () => {
    bedrock.canvas.set_paper('plain');
    document.querySelector('[data-brush="highlighter"]').click();
    await t.line(100, 300, 800, 300, { pressure: 0.6 });
    document.querySelector('[data-brush="pen"]').click();
    await t.line(100, 290, 800, 320, { pressure: 0.5 });
    // Walk along the pen line inside the highlighter and look for breaks.
    let gaps = 0;
    for (let x = 200; x <= 700; x++) {
      const y = 290 + ((x - 100) / 700) * 30;
      let dark = false;
      for (let dy = -2; dy <= 2; dy++) {
        const [r, g, b] = bedrock.canvas.pixel_at(x, y + dy);
        if (r + g + b < 300) dark = true;
      }
      if (!dark) gaps++;
    }
    return gaps;
  });
  // Bug: the depth buffer wasn't cleared between batches, so the pen line was cut into dashes.
  assert.equal(gaps, 0);
  await ctx.close();
});

test('tapping the active tool again jumps back to the previous tool', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(() => {
    const active = () => document.querySelector('.tool[aria-checked="true"]').getAttribute('aria-label');
    const eraser = document.querySelector('[data-tool="eraser"]');
    const steps = [active()];
    eraser.click();
    steps.push(active());
    eraser.click(); // tap the active tool again
    steps.push(active());
    document.querySelector('[data-brush="pen"]').click();
    steps.push(active());
    return steps;
  });
  assert.deepEqual(r, ['Pen', 'Eraser', 'Pen', 'Eraser']);
  await ctx.close();
});

test('tool settings: eraser mode lives in the settings of the eraser', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    await t.line(200, 300, 600, 300);
    document.querySelector('[data-tool="eraser"]').click();
    document.getElementById('btn-stroke').click();
    const brushHidden = document.getElementById('pop-brush').hidden;
    document.querySelector('[data-eraser="erase-partial"]').click();
    await t.line(400, 200, 400, 400);
    // Partial erase splits the line in two instead of deleting it.
    return { brushHidden, title: document.getElementById('stroke-brush').textContent, strokes: bedrock.canvas.stroke_count() };
  });
  assert.deepEqual(r, { brushHidden: true, title: 'Eraser', strokes: 2 });
  await ctx.close();
});

test('three size presets per brush; the slider edits the selected one', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(() => {
    const presets = () => [...document.querySelectorAll('#size-presets .preset')];
    const n = presets().length;
    presets()[2].click();
    const picked = JSON.parse(localStorage.getItem('bedrock.settings.v1')).brushes.pen.size;
    const slider = document.getElementById('size');
    slider.value = 7.5;
    slider.dispatchEvent(new Event('input'));
    presets()[0].click();
    presets()[2].click();
    const s = JSON.parse(localStorage.getItem('bedrock.settings.v1')).brushes.pen;
    return { n, picked, size: s.size, presets: s.presets };
  });
  assert.equal(r.n, 3);
  assert.equal(r.picked, 5);
  assert.equal(r.size, 7.5, 'selecting the edited preset brings back the edited size');
  assert.deepEqual(r.presets, [1.5, 2.5, 7.5]);
  await ctx.close();
});

test('colour presets can be added and deleted, and are remembered', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    const swatches = () => document.querySelectorAll('#colors .swatch').length;
    const before = swatches();
    const ci = document.getElementById('color-input');
    ci.value = '#00aa88';
    ci.dispatchEvent(new Event('input'));
    document.getElementById('color-add').click();
    const added = swatches();
    // Long-press (here: right-click) enters delete mode; tapping a colour removes it.
    document.querySelector('#colors .swatch').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const editing = document.getElementById('colors').classList.contains('editing');
    document.querySelector('#colors .swatch').click();
    const s = JSON.parse(localStorage.getItem('bedrock.settings.v1'));
    return { before, added, editing, after: swatches(), saved: s.palettes.ink };
  });
  assert.equal(r.added, r.before + 1);
  assert.ok(r.editing);
  assert.equal(r.after, r.before);
  assert.ok(r.saved.includes('#00aa88') && !r.saved.includes('#1c1c1e'), JSON.stringify(r.saved));
  await ctx.close();
});

test('the toolbar can be docked to any edge and stays there', async () => {
  const { page, ctx } = await openApp(env);
  const box = () => page.evaluate(() => {
    const r = document.getElementById('toolbar').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
  });
  const bottom = await box();
  assert.ok(bottom.y + bottom.h > bottom.vh - 30 && bottom.w > bottom.h);
  // Drag the grip to the left edge.
  const grip = await page.locator('#dock-grip').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(20, 380, { steps: 5 });
  await page.mouse.up();
  const left = await box();
  assert.ok(left.x < 30 && left.h > left.w, `docked left: ${JSON.stringify(left)}`);
  await page.evaluate(() => { const d = document.getElementById('dock'); d.value = 'right'; d.dispatchEvent(new Event('change')); });
  const right = await box();
  assert.ok(right.x + right.w > right.vw - 30 && right.h > right.w);
  await page.reload();
  await page.waitForFunction(() => window.bedrock && window.bedrock.ready);
  const again = await box();
  assert.ok(again.x + again.w > again.vw - 30, 'position is remembered');
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
    const remembered = document.querySelector('#stroke-pop [data-style][aria-checked="true"]').dataset.style;
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

test('saving happens in the background and the saved note matches exactly', async () => {
  const context = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const { page } = await openApp(env, { context });
  const r = await page.evaluate(async () => {
    const c = bedrock.canvas;
    // A big note: 800 handwriting-sized strokes.
    let id = 100;
    for (let s = 0; s < 800; s++) {
      const x0 = 40 + (s % 40) * 22, y0 = 80 + Math.floor(s / 40) * 28;
      t.ev('pointerdown', id, 'pen', x0, y0, { pressure: 0.5 });
      for (let i = 1; i < 50; i++) t.ev('pointermove', id, 'pen', x0 + i * 0.3 + Math.sin(i / 3) * 4, y0 + Math.cos(i / 4) * 6, { pressure: 0.5 });
      t.ev('pointerup', id, 'pen', x0 + 15, y0, { pressure: 0 });
      id++;
    }
    await bedrock.saveNow();
    // Now edit: a new stroke, an erase, an undo, and measure the main thread
    // while the next save runs.
    await t.line(100, 700, 600, 700);
    document.querySelector('[data-tool="eraser"]').click();
    await t.line(52, 60, 52, 120);
    c.undo();
    document.querySelector('[data-brush="pen"]').click();
    const longest = { ms: 0 };
    const obs = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')
      ? new PerformanceObserver((l) => { for (const e of l.getEntries()) longest.ms = Math.max(longest.ms, e.duration); })
      : null;
    obs?.observe({ type: 'longtask' });
    const t0 = performance.now();
    const p = bedrock.saveNow();
    const sync = performance.now() - t0; // main-thread part before the worker takes over
    await p;
    await new Promise((res) => setTimeout(res, 50));
    obs?.disconnect();
    const saved = await bedrock.store.get(bedrock.noteId);
    const back = new bedrock.canvas.constructor(document.createElement('canvas'), document.createElement('canvas'), 1, 2);
    back.load(saved.data, 1, 2);
    return { stats: bedrock.saveStats, background: bedrock.backgroundSaving, sync, longest: longest.ms, same: back.export_json() === c.export_json(), strokes: back.stroke_count() };
  });
  assert.ok(r.background, 'saver worker is running');
  assert.deepEqual({ ...r.stats, background: r.stats.background > 0 }, { background: true, resyncs: 0, direct: 0 }, 'saved from the worker copy, no fallbacks');
  assert.ok(r.same, 'the saved file has exactly the strokes on screen');
  assert.equal(r.strokes, 801);
  assert.ok(r.sync < 30, `main thread spent ${r.sync.toFixed(1)} ms starting the save`);
  assert.ok(r.longest < 50, `longest main-thread task during the save: ${r.longest} ms`);
  await context.close();
});

/** Ink samples in what is actually on screen (a screenshot; pixel_at
 *  re-renders first, so it can't catch a frame that was never drawn). */
async function screenInk(page, x0, x1) {
  const png = (await page.screenshot()).toString('base64');
  return page.evaluate(async ({ png, x0, x1 }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let y = 100; y < 650; y += 3) for (let x = x0; x < x1; x += 3) {
      const i = (y * c.width + x) * 4;
      if (d[i] + d[i + 1] + d[i + 2] < 300) n++;
    }
    return n;
  }, { png, x0, x1 });
}

test('an opened note shows its ink straight away, without touching the canvas', async () => {
  const { page, ctx } = await openApp(env);
  // Two notes with the same number of strokes: one on the left, one on the right.
  const ids = await page.evaluate(async () => {
    bedrock.minimap.visible = false; // only look at the canvas
    // No recogniser download here: its "not available" toast is dark and
    // would be counted as ink.
    bedrock.handwriting.enabled = false;
    const ids = [];
    for (const x of [100, 600]) {
      await bedrock.newNote();
      for (let i = 0; i < 4; i++) await t.line(x, 200 + i * 80, x + 300, 200 + i * 80, { pressure: 0.9 });
      await bedrock.saveNow();
      ids.push(bedrock.noteId);
    }
    return ids;
  });
  const shown = [];
  for (const id of [ids[0], ids[1], ids[0]]) {
    await page.evaluate(async (id) => { await bedrock.openNote(id); bedrock.canvas.set_camera(0, 0, 1); bedrock.input.requestFrame(); }, id);
    await page.evaluate(() => t.frame());
    shown.push([await screenInk(page, 80, 420), await screenInk(page, 580, 920)]);
  }
  // Bug: the opened note's ink didn't appear (or the old note's stayed)
  // until a new stroke was drawn.
  for (const [i, [left, right]] of shown.entries()) {
    const wantLeft = i !== 1;
    assert.ok(wantLeft ? left > 50 && right === 0 : right > 50 && left === 0, `open #${i + 1}: left ${left}, right ${right}`);
  }
  await ctx.close();
});

test('the minimap shows the drawing and the view, follows them, shows zoom, fits, and moves the camera', async () => {
  const { page, ctx, errors } = await openApp(env, { viewport: { width: 1180, height: 820 } });
  const r = await page.evaluate(async () => {
    const mm = document.getElementById('minimap');
    const dark = () => {
      const c = mm.querySelector('canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 150 && d[i] + d[i + 1] + d[i + 2] < 300) n++;
      return n;
    };
    const visibleAtStart = !mm.hidden;
    const emptyInk = dark();
    for (let i = 0; i < 4; i++) await t.line(200, 200 + i * 60, 800, 220 + i * 60, { pressure: 0.9 });
    await new Promise((res) => setTimeout(res, 500));
    await t.frame();
    const inkPx = dark();
    const area1 = bedrock.canvas.minimap_region();
    // Scroll far away: the area grows to include the view.
    bedrock.canvas.pan(-3000, 0);
    bedrock.input.requestFrame();
    await t.frame();
    const area2 = bedrock.canvas.minimap_region();
    const view = bedrock.canvas.view_rect();
    // Tap the left edge of the minimap: the camera goes back to the ink.
    const c = mm.querySelector('canvas').getBoundingClientRect();
    const ev = (type) => mm.querySelector('canvas').dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 9, pointerType: 'touch', clientX: c.left + 20, clientY: c.top + c.height / 2, isPrimary: true,
    }));
    ev('pointerdown'); ev('pointerup');
    await t.frame();
    const back = bedrock.canvas.view_rect();
    // Back at the drawing, the area shrinks to it again.
    const area3 = bedrock.canvas.minimap_region();
    // Zoom label, and the fit button.
    bedrock.canvas.set_camera(5000, 5000, 0.5);
    bedrock.input.requestFrame();
    await t.frame();
    const zoomText = document.getElementById('zoom-level').textContent;
    document.getElementById('btn-fit').click();
    await t.frame();
    const fitted = bedrock.canvas.view_rect();
    const ink = bedrock.canvas.ink_bounds();
    document.getElementById('show-minimap').click();
    const hidden = mm.hidden;
    const saved = JSON.parse(localStorage.getItem('bedrock.settings.v1')).showMinimap;
    return { visibleAtStart, emptyInk, ink: inkPx, area1, area2, area3, view, back, zoomText, fitted, inkBox: ink, hidden, saved, strokes: bedrock.canvas.stroke_count() };
  });
  assert.ok(r.visibleAtStart);
  assert.equal(r.emptyInk, 0);
  assert.ok(r.ink > 20, `minimap shows ink (${r.ink} px)`);
  assert.ok(r.area2[2] >= r.view[2] && r.area2[0] <= r.inkBox[0], `area ${r.area2} holds view ${r.view} and the ink ${r.inkBox}`);
  assert.ok(r.back[0] < r.view[0] - 1000, `tapping moved the view from ${r.view[0]} to ${r.back[0]}`);
  assert.equal(r.strokes, 4, 'tapping the minimap does not draw');
  assert.ok(r.area3[2] - r.area3[0] < (r.area2[2] - r.area2[0]) / 2, `area shrank back from ${r.area2} to ${r.area3}`);
  assert.equal(r.zoomText, '50%');
  const [f, b] = [r.fitted, r.inkBox];
  assert.ok(f[0] <= b[0] && f[1] <= b[1] && f[2] >= b[2] && f[3] >= b[3], `fit shows ${b} in ${f}`);
  assert.ok(r.hidden);
  assert.equal(r.saved, false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('handwriting: words are recognised, misspellings get a red wavy underline, text is saved', async () => {
  const { page, ctx, errors } = await openApp(env);
  const r = await page.evaluate(async () => {
    const hw = bedrock.handwriting;
    for (let i = 0; i < 100 && !hw.dictionaryReady; i++) await new Promise((res) => setTimeout(res, 50));
    // A fake recogniser: the first word on the line reads "hello", the
    // second "wrold". It also records what it was given.
    const seen = [];
    hw.engine = async ({ kind, image, word }) => {
      seen.push({ kind, type: image.type, size: image.size });
      return { text: word.bounds[0] < 300 ? 'hello' : 'wrold', engine: 'fake' };
    };
    bedrock.minimap.visible = false;
    // Two words of zigzag "letters".
    const word = async (x0) => {
      for (let k = 0; k < 4; k++) {
        const x = x0 + k * 22;
        t.ev('pointerdown', 1, 'pen', x, 300, { pressure: 0.6 });
        for (let j = 1; j <= 8; j++) t.ev('pointermove', 1, 'pen', x + j * 2, 300 - (j % 2) * 26, { pressure: 0.6 });
        t.ev('pointerup', 1, 'pen', x + 16, 300, { pressure: 0 });
      }
      await t.frame();
    };
    await word(150);
    await word(350);
    await hw.run();
    await t.frame();
    await t.frame();
    const words = JSON.parse(bedrock.canvas.words_json());
    // Red pixels just under each word.
    const marks = document.getElementById('marks');
    const g = marks.getContext('2d');
    const dpr = marks.width / marks.clientWidth;
    const red = (x0, x1) => {
      const d = g.getImageData(x0 * dpr, 300 * dpr, (x1 - x0) * dpr, 12 * dpr).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 100 && d[i] > 150 && d[i + 1] < 120) n++;
      return n;
    };
    const underline = { first: red(150, 230), second: red(350, 430) };
    const suggestions = bedrock.canvas.suggestions(words[1].id);
    await bedrock.saveNow();
    const id = bedrock.noteId;
    await bedrock.newNote();
    await bedrock.openNote(id);
    const reopened = JSON.parse(bedrock.canvas.words_json()).map((w) => w.text);
    return { n: words.length, texts: words.map((w) => w.text), kinds: words.map((w) => w.kind), seen, underline, suggestions, reopened };
  });
  assert.equal(r.n, 2);
  assert.deepEqual(r.texts, ['hello', 'wrold']);
  assert.deepEqual(r.kinds, ['text', 'text']);
  assert.ok(r.seen.length === 2 && r.seen.every((s) => s.type === 'image/png' && s.size > 100), JSON.stringify(r.seen));
  assert.equal(r.underline.first, 0, 'correct word is not underlined');
  assert.ok(r.underline.second > 10, `misspelled word is underlined (${r.underline.second} red px)`);
  assert.equal(r.suggestions[0], 'world');
  assert.deepEqual(r.reopened, ['hello', 'wrold'], 'recognised text is saved with the note');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the recogniser view shows each word as the recogniser sees it, with what it read or why not', async () => {
  const { page, ctx, errors } = await openApp(env);
  const r = await page.evaluate(async () => {
    const hw = bedrock.handwriting;
    let calls = 0;
    hw.engine = async () => {
      calls++;
      if (calls === 2) throw new Error('model not loaded');
      return { text: 'hello', engine: 'fake' };
    };
    bedrock.minimap.visible = false;
    for (const x0 of [150, 350]) {
      for (let k = 0; k < 4; k++) {
        const x = x0 + k * 22;
        t.ev('pointerdown', 1, 'pen', x, 300, { pressure: 0.6 });
        for (let j = 1; j <= 8; j++) t.ev('pointermove', 1, 'pen', x + j * 2, 300 - (j % 2) * 26, { pressure: 0.6 });
        t.ev('pointerup', 1, 'pen', x + 16, 300, { pressure: 0 });
      }
      await t.frame();
    }
    const panel = document.getElementById('recognizer-view');
    const hiddenAtStart = panel.hidden;
    document.getElementById('show-recognizer').click();
    await hw.run();
    await bedrock.recognizerView.refresh();
    const rows = [...panel.querySelectorAll('.rv-list li')];
    const imgs = await Promise.all(rows.map(async (li) => {
      const img = li.querySelector('img');
      await img.decode();
      return { w: img.naturalWidth, h: img.naturalHeight };
    }));
    const out = {
      hiddenAtStart,
      shown: !panel.hidden,
      texts: rows.map((li) => li.querySelector('.rv-text').textContent),
      pending: rows.map((li) => li.classList.contains('pending')),
      imgs,
      count: panel.querySelector('.rv-count').textContent,
    };
    document.getElementById('rv-close').click();
    out.closed = panel.hidden && !document.getElementById('show-recognizer').checked;
    return out;
  });
  assert.equal(r.hiddenAtStart, true);
  assert.ok(r.shown);
  assert.deepEqual(r.texts, ['hello', 'Failed: model not loaded']);
  assert.deepEqual(r.pending, [false, true]);
  assert.equal(r.count, '2 words');
  assert.ok(r.imgs.every((i) => i.w > 40 && i.h > 40), JSON.stringify(r.imgs));
  assert.ok(r.closed, 'closes from its button and unticks the menu');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the formula recogniser runs Pix2Text MFR on ONNX Runtime: files at the repo root, greedy decoding to LaTeX', async () => {
  // Stand-ins: ONNX Runtime from node_modules, tiny models with the real
  // input/output names (tests/fixtures/make-mfr.py), a tokenizer stub.
  const { readFile } = await import('node:fs/promises');
  const ctx = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const asked = [];
  await ctx.route('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/**', async (route) => {
    const file = new URL(route.request().url()).pathname.split('/').pop();
    const type = file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
    route.fulfill({ body: await readFile(new URL(`../node_modules/onnxruntime-web/dist/${file}`, import.meta.url)), contentType: type });
  });
  await ctx.route('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `export const AutoTokenizer = { from_pretrained: async (m) => ({ model: m, decode: (ids, o) => ids.map((i) => ({ 5: '\\\\frac', 6: '{a}', 7: '{b}' })[i] ?? '').join('') }) };`,
  }));
  await ctx.route('https://huggingface.co/**', async (route) => {
    const url = route.request().url();
    asked.push(url);
    const file = url.split('/').pop();
    route.fulfill({ body: await readFile(new URL(`./fixtures/mfr/${file}`, import.meta.url)), contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } });
  });
  const { page, errors } = await openApp(env, { context: ctx });
  if (process.env.DEBUG_MFR) {
    page.on('console', (m) => console.log('console', m.text()));
    page.on('worker', (w) => w.on('console', (m) => console.log('worker', m.text())));
    ctx.on('request', (q) => console.log('req', q.url()));
    ctx.on('requestfailed', (q) => console.log('failed', q.url(), q.failure()?.errorText));
  }
  const r = await page.evaluate(async () => {
    const hw = bedrock.handwriting;
    const statuses = [];
    const prev = hw.onStatus;
    hw.onStatus = (m) => { statuses.push(m.status || `error: ${m.error}`); };
    const c = new OffscreenCanvas(120, 80);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 120, 80);
    g.fillStyle = '#000'; g.fillRect(20, 38, 80, 4);
    const image = await c.convertToBlob({ type: 'image/png' });
    hw.engine = null;
    const first = await hw._engine()({ kind: 'math', image });
    const second = await hw._engine()({ kind: 'math', image });
    hw.onStatus = prev;
    return { first, second, statuses };
  });
  assert.equal(r.first.text, '\\frac{a}{b}');
  assert.equal(r.second.text, '\\frac{a}{b}');
  assert.match(r.first.engine, /pix2text-mfr-1\.5/);
  assert.ok(r.statuses.includes('ready'), JSON.stringify(r.statuses));
  assert.ok(!r.statuses.some((s) => s.startsWith('error')), JSON.stringify(r.statuses));
  assert.deepEqual(asked.map((u) => u.replace('https://huggingface.co/', '')).sort(), [
    'breezedeus/pix2text-mfr-1.5/resolve/main/decoder_model.onnx',
    'breezedeus/pix2text-mfr-1.5/resolve/main/encoder_model.onnx',
  ], 'downloads the root-level files once');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('careful reading: the larger model re-reads words after a pause, stops when writing resumes, and follows the menu mode', async () => {
  const { page, ctx, errors } = await openApp(env);
  const r = await page.evaluate(async () => {
    const hw = bedrock.handwriting;
    bedrock.minimap.visible = false;
    const calls = [];
    let onCareful = null;
    hw.engine = async ({ quality, word }) => {
      calls.push(quality);
      if (quality === 'careful') {
        onCareful?.();
        return { text: 'world', engine: 'Xenova/trocr-base-handwritten (fake)' };
      }
      return { text: 'wrold', engine: 'Xenova/trocr-small-handwritten (fake)' };
    };
    const word = async (x0, y = 300) => {
      for (let k = 0; k < 4; k++) {
        const x = x0 + k * 22;
        t.ev('pointerdown', 1, 'pen', x, y, { pressure: 0.6 });
        for (let j = 1; j <= 8; j++) t.ev('pointermove', 1, 'pen', x + j * 2, y - (j % 2) * 26, { pressure: 0.6 });
        t.ev('pointerup', 1, 'pen', x + 16, y, { pressure: 0 });
      }
      await t.frame();
    };
    const texts = () => JSON.parse(bedrock.canvas.words_json()).map((w) => w.text);
    const out = {};
    // Both (default): live first, then the careful pass replaces it.
    out.defaultMode = hw.mode;
    await word(150);
    await hw.run();
    out.live = texts();
    const rev = bedrock.canvas.revision();
    await hw.runCareful();
    out.careful = texts();
    out.engine = JSON.parse(bedrock.canvas.words_json())[0].engine;
    out.revisionKept = bedrock.canvas.revision() === rev;
    await hw.runCareful();
    out.calls1 = calls.splice(0);
    // Writing resumes during a careful pass: it stops after the current word.
    await word(150, 450);
    await word(350, 450);
    onCareful = () => { onCareful = null; hw.schedule(); };
    await hw.runCareful();
    out.calls2 = calls.splice(0);
    // Live only: no careful pass.
    document.getElementById('recognize-mode').value = 'live';
    document.getElementById('recognize-mode').dispatchEvent(new Event('change'));
    await hw.runCareful();
    out.calls3 = calls.splice(0);
    // Careful only: the live pass does nothing; the careful one reads new words.
    document.getElementById('recognize-mode').value = 'careful';
    document.getElementById('recognize-mode').dispatchEvent(new Event('change'));
    await word(150, 600);
    await hw.run();
    out.calls4 = calls.splice(0);
    await hw.runCareful();
    out.calls5 = calls.splice(0);
    out.saved = JSON.parse(localStorage.getItem('bedrock.settings.v1') || '{}').recognizeMode;
    return out;
  });
  assert.equal(r.defaultMode, 'both');
  assert.deepEqual(r.live, ['wrold']);
  assert.deepEqual(r.careful, ['world'], 'careful answer replaces the live one');
  assert.match(r.engine, /trocr-base-handwritten/);
  assert.ok(r.revisionKept, 'storing text does not count as an edit (which would stop the pass)');
  assert.deepEqual(r.calls1, ['fast', 'careful'], 'a word the careful model read is not read again');
  assert.deepEqual(r.calls2, ['careful'], 'stops when writing resumes');
  assert.deepEqual(r.calls3, []);
  assert.deepEqual(r.calls4, []);
  assert.ok(r.calls5.length >= 1 && r.calls5.every((q) => q === 'careful'), JSON.stringify(r.calls5));
  assert.equal(r.saved, 'careful', 'mode is remembered');
  assert.deepEqual(errors, []);
  await ctx.close();
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
