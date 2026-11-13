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

// The Duplicate update failed to start for a writer whose browser kept the
// old page (without the Duplicate button) while loading the new scripts.
test('a page from an older version than its scripts reloads once by itself and starts; if that does not help it says so with a Reload button', async () => {
  const fs = await import('node:fs/promises');
  const real = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
  const old = real.replace(/\s*<button[^>]*id="wm-duplicate"[^>]*>[^<]*<\/button>/, '');
  assert.notEqual(old, real, 'the old page lacks the Duplicate button');
  const run = async (stale) => {
    const ctx = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await ctx.newPage();
    let loads = 0;
    await page.route((u) => u.pathname === '/' || u.pathname === '/index.html', (route) => {
      loads++;
      route.fulfill({ contentType: 'text/html', body: stale(loads) ? old : real });
    });
    await page.goto(env.url);
    return { page, ctx, loads: () => loads };
  };
  // The browser's copy once, then the server's: it heals itself.
  const a = await run((n) => n === 1);
  await a.page.waitForFunction(() => window.bedrock?.ready, null, { timeout: 20000 });
  assert.equal(a.loads(), 2, 'one reload');
  await a.ctx.close();
  // Always the old page: one reload, then a message with a Reload button.
  const b = await run(() => true);
  await b.page.waitForFunction(() => !document.getElementById('fatal')?.hidden && document.querySelector('#fatal button'), null, { timeout: 20000 });
  const text = await b.page.textContent('#fatal');
  assert.match(text, /^Bedrock failed to start: /);
  assert.equal(await b.page.textContent('#fatal button'), 'Reload');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(b.loads(), 2, 'no reload loop');
  await b.ctx.close();
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
    c.zoom_at(0, 0, 1.5);
    const at225 = gap(lines());
    return { at1, at15, at225 };
  });
  // Bug: the spacing was re-picked at every zoom, so the grid crept and jumped.
  assert.ok(Math.abs(r.at1 - 32) < 0.6, `32 px apart at 100% (${r.at1})`);
  assert.ok(Math.abs(r.at15 - 48) < 0.8, `48 px apart at 150% (${r.at15})`);
  assert.ok(Math.abs(r.at225 - 72) < 1.2, `72 px apart at 225% (${r.at225})`);
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
    // This measures the saver alone. Recognition would otherwise wake up
    // during the measured save, and the first word image it draws starts
    // the browser's canvas rasteriser, which takes ~800 ms in a headless
    // browser without a GPU (CI) and has nothing to do with saving.
    bedrock.handwriting.enabled = false;
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
    // Everything but the save time: an autosave can stamp the open note
    // again between this save and the comparison (CI flake).
    const sameNote = (a, b) => {
      const strip = (j) => { const n = JSON.parse(j); delete n.modified; return JSON.stringify(n); };
      return strip(a) === strip(b);
    };
    const back = new bedrock.canvas.constructor(document.createElement('canvas'), document.createElement('canvas'), 1, 2);
    back.load(saved.data, 1, 2);
    return { stats: bedrock.saveStats, background: bedrock.backgroundSaving, sync, longest: longest.ms, same: sameNote(back.export_json(), c.export_json()), strokes: back.stroke_count() };
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
      texts: rows.map((li) => li.querySelector('.rv-text').value || li.querySelector('.rv-text').placeholder),
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

test('the formula recogniser runs Pix2Text MFR through Transformers.js (one runtime): files at the repo root, greedy decoding to LaTeX', async () => {
  // The real Transformers.js and its ONNX Runtime, served locally; tiny
  // models with the real file names and input/output names
  // (tests/fixtures/make-mfr.py) and a small tokenizer.
  const { readFile } = await import('node:fs/promises');
  const { TRANSFORMERS_JS } = await import('./fetch-libs.mjs');
  const ctx = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const asked = [];
  const ortFiles = [];
  await ctx.route('https://cdn.jsdelivr.net/npm/onnxruntime-web@*/dist/**', async (route) => {
    const file = new URL(route.request().url()).pathname.split('/').pop();
    ortFiles.push(file);
    route.fulfill({ body: await readFile(new URL(`../node_modules/onnxruntime-web/dist/${file}`, import.meta.url)), contentType: file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' });
  });
  await ctx.route('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1', async (route) => route.fulfill({ body: await readFile(TRANSFORMERS_JS), contentType: 'text/javascript' }));
  await ctx.route('https://huggingface.co/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    asked.push(path);
    const m = path.match(/^\/breezedeus\/pix2text-mfr-1\.5\/resolve\/main\/+(.+)$/);
    try {
      if (!m) throw new Error('not here');
      route.fulfill({ body: await readFile(new URL(`./fixtures/mfr/${m[1]}`, import.meta.url)), contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } });
    } catch (_) { route.fulfill({ status: 404, body: 'not found', headers: { 'access-control-allow-origin': '*' } }); }
  });
  const { page, errors } = await openApp(env, { context: ctx });
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
    const run = hw._engine();
    const first = await run({ kind: 'math', image }).catch((e) => ({ error: e.message }));
    const second = await run({ kind: 'math', image }).catch((e) => ({ error: e.message }));
    hw.onStatus = prev;
    return { first, second, statuses };
  });
  assert.ok(!r.first.error, r.first.error);
  assert.equal(r.first.text.replace(/\s/g, ''), '\\frac{a}{b}');
  assert.equal(r.second.text.replace(/\s/g, ''), '\\frac{a}{b}');
  assert.match(r.first.engine, /pix2text-mfr-1\.5/);
  assert.ok(r.statuses.includes('ready'), JSON.stringify(r.statuses));
  const models = asked.filter((p) => p.endsWith('.onnx')).map((p) => p.replace(/\/+/g, '/'));
  for (const f of ['encoder_model.onnx', 'decoder_model.onnx']) {
    assert.ok(models.includes(`/breezedeus/pix2text-mfr-1.5/resolve/main/${f}`), `loads ${f} from the top level of the repo: ${models}`);
  }
  assert.equal(ortFiles.filter((f) => f.endsWith('.wasm')).length, 1, `one WebAssembly runtime (${ortFiles})`);
  assert.deepEqual(errors.filter((e) => !/Too many inputs/.test(e)), []);
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

test('all recognition models share one worker (one WebAssembly runtime); out of memory restarts it', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    const hw = bedrock.handwriting;
    const made = [];
    const Real = window.Worker;
    // A stand-in worker: the first math request runs out of memory.
    let mathCalls = 0;
    window.Worker = class {
      constructor() { this.terminated = false; this.got = []; made.push(this); }
      postMessage(m) {
        this.got.push(m.release ? `release ${m.release}` : `${m.kind}/${m.quality}`);
        if (m.release) return;
        const reply = m.kind === 'math' && ++mathCalls === 1
          ? { id: m.id, error: 'breezedeus/pix2text-mfr-1.5: no available backend found. ERR: [wasm] RangeError: Out of memory' }
          : { id: m.id, text: `${m.kind}/${m.quality}`, engine: 'fake' };
        setTimeout(() => this.onmessage({ data: reply }), 0);
      }
      terminate() { this.terminated = true; }
    };
    const image = new Blob(['x'], { type: 'image/png' });
    hw.engine = null;
    const run = hw._engine();
    const out = {};
    out.fast = (await run({ kind: 'text', image, quality: 'fast' })).text;
    out.careful = (await run({ kind: 'text', image, quality: 'careful' })).text;
    out.workersBefore = made.length;
    out.oom = await run({ kind: 'math', image }).then(() => 'ok', (e) => e.message);
    out.terminated = made[0].terminated;
    out.math = (await run({ kind: 'math', image })).text;
    hw.releaseModel('text-careful');
    out.made = made.length;
    out.second = made[1]?.got;
    window.Worker = Real;
    return out;
  });
  assert.equal(r.fast, 'text/fast');
  assert.equal(r.careful, 'text/careful');
  assert.equal(r.workersBefore, 1, 'one worker for every model');
  assert.match(r.oom, /pix2text-mfr-1\.5: .*memory/i, 'the error names the model');
  assert.ok(r.terminated, 'the worker that ran out of memory is stopped');
  assert.equal(r.math, 'math/undefined', 'a fresh worker takes the next request');
  assert.equal(r.made, 2);
  assert.deepEqual(r.second, ['math/undefined', 'release text-careful']);
  await ctx.close();
});

test('correcting a reading: type the real text, pick a suggestion or tick it; it is kept with what was read and saved', async () => {
  const { page, ctx, errors } = await openApp(env);
  const r = await page.evaluate(async () => {
    const hw = bedrock.handwriting;
    for (let i = 0; i < 100 && !hw.dictionaryReady; i++) await new Promise((res) => setTimeout(res, 50));
    let n = 0;
    const reads = ['helo', 'wrold', 'tree'];
    hw.engine = async () => ({ text: reads[n++], engine: 'Xenova/trocr-small-handwritten (fake)' });
    bedrock.minimap.visible = false;
    for (const x0 of [150, 350, 550]) {
      for (let k = 0; k < 4; k++) {
        const x = x0 + k * 22;
        t.ev('pointerdown', 1, 'pen', x, 300, { pressure: 0.6 });
        for (let j = 1; j <= 8; j++) t.ev('pointermove', 1, 'pen', x + j * 2, 300 - (j % 2) * 26, { pressure: 0.6 });
        t.ev('pointerup', 1, 'pen', x + 16, 300, { pressure: 0 });
      }
      await t.frame();
    }
    await hw.run();
    document.getElementById('show-recognizer').click();
    await bedrock.recognizerView.refresh();
    const rows = () => [...document.querySelectorAll('#recognizer-view .rv-list li')];
    const out = { underlinedBefore: bedrock.canvas.misspelled().length / 4 };
    out.misspelledRows = rows().map((li) => li.classList.contains('misspelled'));
    // 1: type the real text (Enter commits).
    const input = rows()[0].querySelector('.rv-text');
    input.focus();
    input.value = 'Hello';
    input.dispatchEvent(new Event('change'));
    input.blur();
    await bedrock.recognizerView.refresh();
    // 2: pick the spelling suggestion.
    out.chips = [...rows()[1].querySelectorAll('.rv-chips button')].map((b) => b.textContent);
    rows()[1].querySelector('.rv-chips button').click();
    // 3: the reading was right: tick it.
    rows()[2].querySelector('.rv-ok').click();
    await bedrock.recognizerView.refresh();
    const words = JSON.parse(bedrock.canvas.words_json());
    out.texts = words.map((w) => w.text);
    out.engines = words.map((w) => w.engine);
    out.alts = words.map((w) => w.alternatives);
    out.labels = rows().map((li) => li.querySelector('.rv-kind').textContent);
    out.was = rows()[0].querySelector('.rv-was')?.textContent;
    out.underlinedAfter = bedrock.canvas.misspelled().length / 4;
    // The careful pass leaves the writer's text alone.
    const before = n;
    await hw.runCareful();
    out.carefulCalls = n - before;
    await bedrock.saveNow();
    const id = bedrock.noteId;
    await bedrock.newNote();
    await bedrock.openNote(id);
    out.reopened = JSON.parse(bedrock.canvas.words_json()).map((w) => [w.text, w.engine, w.alternatives]);
    return out;
  });
  assert.equal(r.underlinedBefore, 2);
  assert.deepEqual(r.misspelledRows, [true, true, false]);
  assert.equal(r.chips[0], 'world');
  assert.deepEqual(r.texts, ['Hello', 'world', 'tree']);
  assert.deepEqual(r.engines, ['user', 'user', 'user']);
  assert.deepEqual(r.alts, [['helo'], ['wrold'], []], 'what the recogniser read is kept beside the truth');
  assert.deepEqual(r.labels, ['Yours', 'Yours', 'Yours']);
  assert.equal(r.was, 'Read as: helo');
  assert.equal(r.underlinedAfter, 0);
  assert.equal(r.carefulCalls, 0);
  assert.deepEqual(r.reopened, [['Hello', 'user', ['helo']], ['world', 'user', ['wrold']], ['tree', 'user', []]]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('holding a word opens its menu: make it a website link (saved, underlined, in links.md); writing and empty paper are unaffected', async () => {
  const { page, ctx, errors } = await openApp(env);
  const r = await page.evaluate(async () => {
    const hw = bedrock.handwriting;
    hw.engine = async () => ({ text: 'Bedrock', engine: 'fake' });
    bedrock.minimap.visible = false;
    for (let k = 0; k < 4; k++) {
      const x = 300 + k * 22;
      t.ev('pointerdown', 1, 'pen', x, 300, { pressure: 0.6 });
      for (let j = 1; j <= 8; j++) t.ev('pointermove', 1, 'pen', x + j * 2, 300 - (j % 2) * 26, { pressure: 0.6 });
      t.ev('pointerup', 1, 'pen', x + 16, 300, { pressure: 0 });
    }
    await t.frame();
    await hw.run();
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const menu = document.getElementById('word-menu');
    const out = { strokes0: bedrock.canvas.stroke_count() };
    // Holding the pen still on empty paper: a dot, no menu.
    t.ev('pointerdown', 2, 'pen', 700, 500, { pressure: 0.5 });
    await sleep(700);
    t.ev('pointerup', 2, 'pen', 700, 500, { pressure: 0 });
    out.emptyMenu = !menu.hidden;
    out.strokes1 = bedrock.canvas.stroke_count();
    // Pressing on the word but moving (writing over it): no menu.
    t.ev('pointerdown', 3, 'pen', 330, 290, { pressure: 0.5 });
    t.ev('pointermove', 3, 'pen', 360, 290, { pressure: 0.5 });
    await sleep(700);
    t.ev('pointerup', 3, 'pen', 360, 290, { pressure: 0 });
    out.movedMenu = !menu.hidden;
    out.strokes2 = bedrock.canvas.stroke_count();
    await hw.run(); // the stroke joined the word: read it again
    // Holding still on the word: the menu, and no ink from the hold.
    t.ev('pointerdown', 4, 'pen', 340, 288, { pressure: 0.5 });
    t.ev('pointermove', 4, 'pen', 341, 289, { pressure: 0.5 });
    await sleep(700);
    t.ev('pointerup', 4, 'pen', 341, 289, { pressure: 0 });
    await t.frame();
    out.menu = !menu.hidden;
    out.title = document.getElementById('wm-word').textContent;
    out.reading = document.getElementById('wm-reading').textContent;
    out.strokes3 = bedrock.canvas.stroke_count();
    // Make it a link; a bad address is refused first.
    document.getElementById('wm-link').click();
    out.types = [...document.querySelectorAll('#wm-link-type option')].map((o) => o.value);
    document.getElementById('wm-link-target').value = 'not a site';
    document.querySelector('#wm-link-form .wm-save').click();
    out.error = !document.getElementById('wm-link-error').hidden;
    document.getElementById('wm-link-target').value = 'example.com/docs';
    document.querySelector('#wm-link-form .wm-save').click();
    out.closed = menu.hidden;
    out.link = JSON.parse(bedrock.canvas.words_json()).find((w) => w.link)?.link;
    await t.frame();
    const marks = document.getElementById('marks');
    const g = marks.getContext('2d');
    const dpr = marks.width / marks.clientWidth;
    const d = g.getImageData(300 * dpr, 300 * dpr, 80 * dpr, 12 * dpr).data;
    let blue = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 100 && d[i + 2] > 180 && d[i] < 120) blue++;
    out.blue = blue;
    // Reopening the menu shows it, and offers to open or remove it.
    bedrock.wordMenu.open(JSON.parse(bedrock.canvas.words_json()).find((w) => w.link));
    out.linkNow = document.getElementById('wm-link-now').textContent;
    out.canOpen = !document.getElementById('wm-open').hidden && !document.getElementById('wm-unlink').hidden;
    bedrock.wordMenu.close();
    // Saved with the note, and as Markdown in the .bedrock archive.
    await bedrock.saveNow();
    const id = bedrock.noteId;
    await bedrock.newNote();
    await bedrock.openNote(id);
    out.reopened = JSON.parse(bedrock.canvas.words_json()).find((w) => w.link)?.link;
    out.json = JSON.parse(bedrock.canvas.export_json()).links;
    return out;
  });
  assert.equal(r.emptyMenu, false, 'no menu over empty paper');
  assert.equal(r.strokes1, r.strokes0 + 1, 'the hold on paper drew its dot');
  assert.equal(r.movedMenu, false);
  assert.equal(r.strokes2, r.strokes1 + 1);
  assert.ok(r.menu, 'holding still on a word opens its menu');
  assert.equal(r.title, 'Handwritten word');
  assert.equal(r.reading, 'Read as “Bedrock” · quick model', 'shows what it was read as');
  assert.equal(r.strokes3, r.strokes2, 'the hold that opened the menu left no ink');
  assert.deepEqual(r.types, ['url'], 'websites for now');
  assert.ok(r.error, 'refuses something that is not a web address');
  assert.ok(r.closed);
  assert.deepEqual(r.link, { target: 'https://example.com/docs', type: 'url' });
  assert.ok(r.blue > 20, `linked word is underlined (${r.blue} blue px)`);
  assert.equal(r.linkNow, 'Links to example.com/docs');
  assert.ok(r.canOpen);
  assert.deepEqual(r.reopened, { target: 'https://example.com/docs', type: 'url' });
  assert.equal(r.json.length, 1);
  assert.equal(r.json[0].text, 'Bedrock');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('lasso: draw around ink to select it, drag to move it (text and link go along), hold it to make it one word, link it, delete it', async () => {
  const { page, ctx, errors } = await openApp(env);
  const r = await page.evaluate(async () => {
    const hw = bedrock.handwriting;
    const reads = [];
    hw.engine = async ({ kind, word }) => { reads.push(kind); return { text: kind === 'math' ? 'x^2' : `w${word.strokes.length}`, engine: 'fake' }; };
    bedrock.minimap.visible = false;
    const c = bedrock.canvas;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const word = (x0, n) => {
      for (let k = 0; k < n; k++) {
        const x = x0 + k * 22;
        t.ev('pointerdown', 1, 'pen', x, 300, { pressure: 0.6 });
        for (let j = 1; j <= 8; j++) t.ev('pointermove', 1, 'pen', x + j * 2, 300 - (j % 2) * 26, { pressure: 0.6 });
        t.ev('pointerup', 1, 'pen', x + 16, 300, { pressure: 0 });
      }
    };
    word(300, 3);
    word(420, 2); // a clear gap: two words
    word(300, 0);
    await t.frame();
    await hw.run();
    const words = () => JSON.parse(c.words_json());
    const out = { words0: words().map((w) => w.text) };
    const strokes0 = c.stroke_count();
    document.querySelector('[data-tool="lasso"]').click();
    out.checked = document.querySelector('[data-tool="lasso"]').getAttribute('aria-checked');
    // A loop around the first word only.
    const loop = [[285, 255], [380, 255], [385, 315], [285, 318], [282, 260]];
    t.ev('pointerdown', 2, 'pen', ...loop[0], { pressure: 0.5 });
    for (const p of loop.slice(1)) t.ev('pointermove', 2, 'pen', ...p, { pressure: 0.5 });
    await t.frame();
    const marks = document.getElementById('marks');
    const g = marks.getContext('2d');
    const dpr = marks.width / marks.clientWidth;
    const blueIn = (x, y, w, h) => {
      const d = g.getImageData(x * dpr, y * dpr, w * dpr, h * dpr).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 60 && d[i + 2] > 150 && d[i] < 140) n++;
      return n;
    };
    out.loopShown = blueIn(280, 250, 110, 8);
    t.ev('pointerup', 2, 'pen', 282, 260, { pressure: 0 });
    await t.frame();
    let sel = JSON.parse(c.selection_json());
    out.selected = sel.strokes.length;
    out.selWord = sel.word === words()[0].id;
    out.noInk = c.stroke_count() === strokes0;
    out.boxShown = blueIn(285, 260, 100, 50) > 0;
    // Drag it down 100 px.
    t.ev('pointerdown', 3, 'pen', 330, 290, { pressure: 0.5 });
    t.ev('pointermove', 3, 'pen', 330, 340, { pressure: 0.5 });
    t.ev('pointermove', 3, 'pen', 330, 390, { pressure: 0.5 });
    await t.frame();
    out.floating = JSON.stringify(Array.from(c.drag_offset()));
    t.ev('pointerup', 3, 'pen', 330, 390, { pressure: 0 });
    await t.frame();
    const moved = words().find((w) => w.bounds[1] > 330);
    out.moved = moved && { text: moved.text, top: Math.round(moved.bounds[1]) };
    const inkIn = (y0) => {
      let n = 0;
      for (let x = 300; x < 360; x += 4) for (let y = y0 - 28; y < y0 + 2; y += 4) if ([...c.pixel_at(x, y)].slice(0, 3).some((v) => v < 120)) n++;
      return n;
    };
    out.inkMoved = inkIn(400) > 5;
    out.leftBehind = inkIn(300) > 0;
    out.strokesAfterMove = c.stroke_count();
    // Bring it back up beside the second word and select both.
    t.ev('pointerdown', 4, 'pen', 330, 390, { pressure: 0.5 });
    t.ev('pointermove', 4, 'pen', 330, 290, { pressure: 0.5 });
    t.ev('pointerup', 4, 'pen', 330, 290, { pressure: 0 });
    const both = [[285, 250], [480, 250], [480, 320], [285, 320], [283, 255]];
    t.ev('pointerdown', 5, 'pen', ...both[0], { pressure: 0.5 });
    for (const p of both.slice(1)) t.ev('pointermove', 5, 'pen', ...p, { pressure: 0.5 });
    t.ev('pointerup', 5, 'pen', 283, 255, { pressure: 0 });
    sel = JSON.parse(c.selection_json());
    out.both = sel.strokes.length;
    const boundsBefore = JSON.stringify(sel.bounds);
    // Hold on the selection: its menu, and the hold moves nothing.
    t.ev('pointerdown', 6, 'pen', 400, 290, { pressure: 0.5 });
    await sleep(700);
    t.ev('pointerup', 6, 'pen', 400, 290, { pressure: 0 });
    await t.frame();
    const menu = document.getElementById('word-menu');
    const $ = (id) => document.getElementById(id);
    out.menu = !menu.hidden && $('wm-word').textContent;
    out.menuButtons = ['wm-group', 'wm-ungroup', 'wm-delete', 'wm-link', 'wm-kind'].filter((id) => !$(id).hidden);
    out.notMoved = c.stroke_count() === strokes0 && JSON.stringify(JSON.parse(c.selection_json()).bounds) === boundsBefore;
    $('wm-group').click();
    await hw.run();
    out.grouped = words().map((w) => w.text);
    // Hold again: now it's one word, so it can be linked.
    t.ev('pointerdown', 7, 'pen', 400, 290, { pressure: 0.5 });
    await sleep(700);
    t.ev('pointerup', 7, 'pen', 400, 290, { pressure: 0 });
    out.menu2 = $('wm-word').textContent;
    out.reading2 = $('wm-reading').textContent;
    out.menuButtons2 = ['wm-group', 'wm-ungroup', 'wm-delete'].filter((id) => !$(id).hidden);
    $('wm-link').click();
    $('wm-link-target').value = 'example.com';
    document.querySelector('#wm-link-form .wm-save').click();
    out.link = words().find((w) => w.link)?.strokes.length;
    // Saved with the note: the one word and its link.
    await bedrock.saveNow();
    const id = bedrock.noteId;
    await bedrock.newNote();
    await bedrock.openNote(id);
    out.reopened = words().map((w) => [w.strokes.length, w.link?.target ?? null]);
    out.groupsInFile = JSON.parse(c.export_json()).groups?.map((g) => g.length);
    // Select it again and delete it; undo brings it back.
    // Still the lasso after reopening (the tool is a setting).
    if (document.querySelector('[data-tool="lasso"]').getAttribute('aria-checked') !== 'true') document.querySelector('[data-tool="lasso"]').click();
    t.ev('pointerdown', 8, 'pen', ...both[0], { pressure: 0.5 });
    for (const p of both.slice(1)) t.ev('pointermove', 8, 'pen', ...p, { pressure: 0.5 });
    t.ev('pointerup', 8, 'pen', 283, 255, { pressure: 0 });
    bedrock.wordMenu.openSelection(JSON.parse(c.selection_json()));
    $('wm-delete').click();
    out.deleted = c.stroke_count();
    c.undo();
    out.undone = c.stroke_count();
    // Switching to the pen clears the selection.
    t.ev('pointerdown', 9, 'pen', ...both[0], { pressure: 0.5 });
    for (const p of both.slice(1)) t.ev('pointermove', 9, 'pen', ...p, { pressure: 0.5 });
    t.ev('pointerup', 9, 'pen', 283, 255, { pressure: 0 });
    document.querySelector('[data-brush="pen"]').click();
    out.clearedOnPen = JSON.parse(c.selection_json()).strokes.length;
    return out;
  });
  assert.deepEqual(r.words0, ['w3', 'w2']);
  assert.equal(r.checked, 'true');
  assert.ok(r.loopShown > 10, `the loop is drawn while drawing it (${r.loopShown} px)`);
  assert.equal(r.selected, 3, 'the first word, not its neighbour');
  assert.ok(r.selWord);
  assert.ok(r.noInk, 'the loop is not ink');
  assert.ok(r.boxShown, 'the selection is outlined');
  assert.equal(r.floating, '[0,100]');
  assert.equal(r.moved?.text, 'w3', 'the moved word keeps its text');
  assert.ok(r.moved.top > 360, `moved down (${r.moved.top})`);
  assert.ok(r.inkMoved, 'ink drawn where it was dropped');
  assert.ok(!r.leftBehind, 'and not where it was');
  assert.equal(r.strokesAfterMove, 5);
  assert.equal(r.both, 5);
  assert.equal(r.menu, '5 strokes selected');
  assert.deepEqual(r.menuButtons, ['wm-group', 'wm-delete', 'wm-link', 'wm-kind']);
  assert.ok(r.notMoved, 'holding to open the menu did not move anything');
  assert.deepEqual(r.grouped, ['w5'], 'one word, read again');
  assert.equal(r.menu2, 'Selected word');
  assert.equal(r.reading2, 'Read as “w5” · quick model');
  assert.deepEqual(r.menuButtons2, ['wm-ungroup', 'wm-delete']);
  assert.equal(r.link, 5);
  assert.deepEqual(r.reopened, [[5, 'https://example.com/']]);
  assert.deepEqual(r.groupsInFile, [5]);
  assert.equal(r.deleted, 0);
  assert.equal(r.undone, 5);
  assert.equal(r.clearedOnPen, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('word menu: says when a word is still waiting to be read, and switches a word between text and maths', async () => {
  const { page, ctx, errors } = await openApp(env);
  const r = await page.evaluate(async () => {
    const hw = bedrock.handwriting;
    const reads = [];
    hw.engine = async ({ kind }) => { reads.push(kind); return { text: kind === 'math' ? 'x^{2}' : 'abc', engine: kind === 'math' ? 'mfr' : 'fake' }; };
    bedrock.minimap.visible = false;
    for (let k = 0; k < 3; k++) {
      const x = 300 + k * 22;
      t.ev('pointerdown', 1, 'pen', x, 300, { pressure: 0.6 });
      for (let j = 1; j <= 8; j++) t.ev('pointermove', 1, 'pen', x + j * 2, 300 - (j % 2) * 26, { pressure: 0.6 });
      t.ev('pointerup', 1, 'pen', x + 16, 300, { pressure: 0 });
    }
    await t.frame();
    const c = bedrock.canvas;
    const $ = (id) => document.getElementById(id);
    const word = () => JSON.parse(c.words_json())[0];
    const out = {};
    bedrock.wordMenu.open(word());
    out.waiting = $('wm-reading').textContent;
    out.kindButton = $('wm-kind').textContent;
    bedrock.wordMenu.close();
    await hw.run();
    bedrock.wordMenu.open(word());
    out.read = $('wm-reading').textContent;
    $('wm-kind').click();
    out.kindNow = word().kind;
    out.textDropped = word().text;
    await hw.run();
    bedrock.wordMenu.open(word());
    out.title = $('wm-word').textContent;
    out.readMath = $('wm-reading').textContent;
    out.kindButton2 = $('wm-kind').textContent;
    $('wm-kind').click();
    await hw.run();
    out.back = [word().kind, word().text];
    out.reads = reads;
    out.saved = JSON.parse(c.export_json()).kinds;
    return out;
  });
  assert.equal(r.waiting, 'Waiting to be read…');
  assert.equal(r.kindButton, 'Read it as maths');
  assert.equal(r.read, 'Read as “abc” · quick model');
  assert.equal(r.kindNow, 'math');
  assert.equal(r.textDropped, null, 'read again by the formula model');
  assert.equal(r.title, 'Formula');
  assert.equal(r.readMath, 'Read as LaTeX “x^{2}” · formula model');
  assert.equal(r.kindButton2, 'Not maths: read it as text');
  assert.deepEqual(r.back, ['text', 'abc']);
  assert.deepEqual(r.reads, ['text', 'math', 'text']);
  assert.equal(r.saved.length, 1);
  assert.equal(r.saved[0].kind, 'text');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('scribbling over a word erases it (one undo brings it back); over empty paper, or with the setting off, it is ink', async () => {
  const { page, ctx, errors } = await openApp(env);
  const r = await page.evaluate(async () => {
    bedrock.handwriting.enabled = false;
    const c = bedrock.canvas;
    const word = () => {
      for (let k = 0; k < 3; k++) {
        const x = 300 + k * 22;
        t.ev('pointerdown', 1, 'pen', x, 300, { pressure: 0.6 });
        for (let j = 1; j <= 8; j++) t.ev('pointermove', 1, 'pen', x + j * 2, 300 - (j % 2) * 26, { pressure: 0.6 });
        t.ev('pointerup', 1, 'pen', x + 16, 300, { pressure: 0 });
      }
    };
    const scribble = (y0) => {
      t.ev('pointerdown', 2, 'pen', 290, y0, { pressure: 0.6 });
      for (let i = 1; i <= 60; i++) {
        const pass = Math.floor(i / 6);
        const f = (i % 6) / 6;
        const x = pass % 2 === 0 ? 290 + 80 * f : 370 - 80 * f;
        t.ev('pointermove', 2, 'pen', x, y0 + i * 0.5, { pressure: 0.6 });
      }
      t.ev('pointerup', 2, 'pen', 290, y0 + 30, { pressure: 0 });
    };
    word();
    const out = { before: c.stroke_count() };
    scribble(272);
    await t.frame();
    out.after = c.stroke_count();
    out.toast = document.querySelector('.toast')?.textContent || '';
    c.undo();
    out.undone = c.stroke_count();
    scribble(500);
    out.onPaper = c.stroke_count();
    c.undo();
    document.getElementById('scribble-erase').click();
    out.setting = JSON.parse(localStorage.getItem('bedrock.settings.v1')).scribbleErase;
    scribble(272);
    out.off = c.stroke_count();
    return out;
  });
  assert.equal(r.before, 3);
  assert.equal(r.after, 0, 'the word is gone and the scribble is not kept');
  assert.match(r.toast, /Undo brings it back/);
  assert.equal(r.undone, 3);
  assert.equal(r.onPaper, 4, 'a scribble over nothing is ink');
  assert.equal(r.setting, false);
  assert.equal(r.off, 4, 'with the setting off it is ink');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a lassoed paragraph becomes one link but stays separate words; "Not a word" is never read; a one-finger double tap toggles the eraser', async () => {
  const { page, ctx, errors } = await openApp(env);
  const r = await page.evaluate(async () => {
    const hw = bedrock.handwriting;
    const reads = [];
    hw.engine = async ({ word }) => { reads.push(word.id); return { text: `w${word.strokes.length}`, engine: 'fake' }; };
    bedrock.minimap.visible = false;
    const c = bedrock.canvas;
    const $ = (id) => document.getElementById(id);
    const word = (x0, n, y = 300) => {
      for (let k = 0; k < n; k++) {
        const x = x0 + k * 22;
        t.ev('pointerdown', 1, 'pen', x, y, { pressure: 0.6 });
        for (let j = 1; j <= 8; j++) t.ev('pointermove', 1, 'pen', x + j * 2, y - (j % 2) * 26, { pressure: 0.6 });
        t.ev('pointerup', 1, 'pen', x + 16, y, { pressure: 0 });
      }
    };
    word(300, 3);
    word(420, 2);
    word(300, 1, 400); // a doodle on the next line
    await t.frame();
    await hw.run();
    const words = () => JSON.parse(c.words_json());
    const out = {};
    document.querySelector('[data-tool="lasso"]').click();
    const loop = [[285, 250], [480, 250], [480, 320], [285, 320], [283, 255]];
    t.ev('pointerdown', 2, 'pen', ...loop[0], { pressure: 0.5 });
    for (const p of loop.slice(1)) t.ev('pointermove', 2, 'pen', ...p, { pressure: 0.5 });
    t.ev('pointerup', 2, 'pen', 283, 255, { pressure: 0 });
    bedrock.wordMenu.openSelection(JSON.parse(c.selection_json()));
    $('wm-link').click();
    $('wm-link-target').value = 'example.com';
    document.querySelector('#wm-link-form .wm-save').click();
    out.words = words().map((w) => [w.text, w.link?.target ?? null]);
    out.linkText = JSON.parse(c.export_json()).links.map((l) => l.text);
    out.underlines = c.link_bounds().length / 4;
    bedrock.wordMenu.openSelection(JSON.parse(c.selection_json()));
    out.linkNow = $('wm-link-now').textContent;
    bedrock.wordMenu.close();
    // The doodle: not a word.
    const doodle = words().find((w) => w.bounds[1] > 350);
    bedrock.wordMenu.open(doodle);
    out.drawingOffered = !$('wm-drawing').hidden;
    $('wm-drawing').click();
    const readsBefore = reads.length;
    await hw.run();
    await hw.runCareful();
    const d = words().find((w) => w.bounds[1] > 350);
    out.doodle = [d.kind, d.text, reads.slice(readsBefore).filter((id) => id === d.id).length];
    bedrock.wordMenu.open(d);
    out.doodleMenu = [$('wm-word').textContent, $('wm-kind').textContent, $('wm-drawing').hidden];
    bedrock.wordMenu.close();
    // One-finger double tap: eraser, then back to the lasso.
    const tap = async () => {
      t.ev('pointerdown', 9, 'touch', 700, 600);
      t.ev('pointerup', 9, 'touch', 700, 600);
      await new Promise((res) => setTimeout(res, 60));
    };
    const tool = () => document.querySelector('.tool[aria-checked="true"]')?.dataset.tool || document.querySelector('.tool[aria-checked="true"]')?.dataset.brush;
    await tap(); await tap();
    out.afterDouble = tool();
    await tap(); await tap();
    out.afterSecond = tool();
    out.strokes = c.stroke_count();
    return out;
  });
  assert.deepEqual(r.words, [['w3', 'https://example.com/'], ['w2', 'https://example.com/'], ['w1', null]], 'still two words, both linked');
  assert.deepEqual(r.linkText, ['w3 w2']);
  assert.equal(r.underlines, 2, 'underlined word by word');
  assert.equal(r.linkNow, 'Links to example.com');
  assert.ok(r.drawingOffered);
  assert.deepEqual(r.doodle, ['drawing', null, 0], 'not read, by either model');
  assert.deepEqual(r.doodleMenu, ['Not a word', 'It is writing: read it', true]);
  assert.equal(r.afterDouble, 'eraser');
  assert.equal(r.afterSecond, 'lasso');
  assert.equal(r.strokes, 6, 'taps draw nothing');
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

test('pen feel: tuning is saved with new strokes, per brush, and "usual" leaves it out', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    document.getElementById('btn-stroke').click();
    const usualLabel = document.getElementById('tune-taper_end-value').textContent;
    const set = (k, v) => { const el = document.getElementById(`tune-${k}`); el.value = v; el.dispatchEvent(new Event('input')); };
    set('taper_end', 90);
    set('pressure', 20);
    set('taper_fade', 40);
    await t.line(200, 200, 700, 200, { pressure: 0.6 });
    // Switching brushes and back keeps the pen's tuning; the marker has none.
    document.querySelector('[data-brush="marker"]').click();
    await t.line(200, 400, 700, 400, { pressure: 0.6 });
    document.querySelector('[data-brush="pen"]').click();
    await t.line(200, 600, 700, 600, { pressure: 0.6 });
    const note = JSON.parse(bedrock.canvas.export_json());
    const saved = JSON.parse(localStorage.getItem('bedrock.settings.v1')).brushes.pen.tune;
    document.getElementById('tune-reset').click();
    await t.line(200, 700, 700, 700, { pressure: 0.6 });
    const after = JSON.parse(bedrock.canvas.export_json()).strokes.at(-1).brush;
    const pick = (b) => ({ taper_end: b.taper_end, pressure: b.pressure, taper_fade: b.taper_fade, taper_start: b.taper_start });
    return { usualLabel, strokes: note.strokes.map((s) => pick(s.brush)), saved, after: pick(after) };
  });
  assert.equal(r.usualLabel, 'Usual (50%)');
  assert.deepEqual(r.strokes[0], { taper_end: 0.9, pressure: 0.2, taper_fade: 0.4, taper_start: undefined });
  assert.deepEqual(r.strokes[1], { taper_end: undefined, pressure: undefined, taper_fade: undefined, taper_start: undefined });
  assert.deepEqual(r.strokes[2], r.strokes[0]);
  assert.deepEqual(r.saved, { taper_start: null, taper_end: 90, taper_fade: 40, pressure: 20, speed: null });
  assert.deepEqual(r.after, { taper_end: undefined, pressure: undefined, taper_fade: undefined, taper_start: undefined });
  await ctx.close();
});

test('pen feel: less pressure sensitivity keeps light and hard lines closer in width', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    const width = (y) => {
      let n = 0;
      for (let yy = y - 30; yy <= y + 30; yy += 0.5) { const [r] = bedrock.canvas.pixel_at(450, yy); if (r < 128) n++; }
      return n / 2;
    };
    await t.line(200, 100, 700, 100, { pressure: 0.1 });
    await t.line(200, 200, 700, 200, { pressure: 1.0 });
    document.getElementById('btn-stroke').click();
    const el = document.getElementById('tune-pressure');
    el.value = 0;
    el.dispatchEvent(new Event('input'));
    await t.line(200, 400, 700, 400, { pressure: 0.1 });
    await t.line(200, 500, 700, 500, { pressure: 1.0 });
    await t.frame();
    return { usual: [width(100), width(200)], flat: [width(400), width(500)] };
  });
  assert.ok(r.usual[1] > r.usual[0] * 1.5, `usual pen responds to pressure: ${r.usual}`);
  assert.ok(Math.abs(r.flat[1] - r.flat[0]) <= 1, `no sensitivity: same width ${r.flat}`);
  await ctx.close();
});

test('trim eraser cuts an overshoot back to the crossing, keeps the rest', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    await t.line(200, 300, 700, 300); // horizontal
    await t.line(300, 200, 300, 600); // vertical crossing it at (300, 300)
    document.querySelector('[data-tool="eraser"]').click();
    document.getElementById('btn-stroke').click();
    document.querySelector('[data-eraser="erase-trim"]').click();
    const badge = document.getElementById('eraser-mode').textContent;
    const hint = document.getElementById('eraser-hint').textContent;
    // Swipe across the vertical line's top overshoot (above the crossing).
    await t.line(260, 240, 340, 240);
    const ink = (x, y) => bedrock.canvas.pixel_at(x, y)[0] < 128;
    return {
      badge, hint: hint.length > 0,
      overshoot: ink(300, 220), below: ink(300, 450), horizontal: ink(600, 300),
      strokes: bedrock.canvas.stroke_count(),
      mode: JSON.parse(localStorage.getItem('bedrock.settings.v1')).eraserMode,
    };
  });
  assert.deepEqual(r, { badge: 'T', hint: true, overshoot: false, below: true, horizontal: true, strokes: 2, mode: 'erase-trim' });
  await ctx.close();
});

test('pressure curve: points can be added and dragged, it is remembered, and soft/firm still works', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    document.getElementById('btn-menu').click();
    const svg = document.getElementById('pressure-curve');
    const box = svg.getBoundingClientRect();
    const at = (x, y) => ({ clientX: box.left + x * box.width, clientY: box.top + (1 - y) * box.height, pointerId: 9, bubbles: true });
    // Tap at (0.5, 0.5) adds a point, then drag it up to (0.4, 0.8): a soft curve.
    svg.dispatchEvent(new PointerEvent('pointerdown', at(0.5, 0.5)));
    svg.dispatchEvent(new PointerEvent('pointermove', at(0.4, 0.8)));
    svg.dispatchEvent(new PointerEvent('pointerup', at(0.4, 0.8)));
    const pts = Array.from(bedrock.canvas.pressure_points());
    const mid = bedrock.canvas.pressure_curve_samples(3)[1];
    const label = document.getElementById('pressure-value').textContent;
    const saved = JSON.parse(localStorage.getItem('bedrock.settings.v1')).pressureCurve;
    const circles = svg.querySelectorAll('circle').length;
    // Moving the firm/soft slider replaces the custom curve.
    const slider = document.getElementById('pressure');
    slider.value = -60;
    slider.dispatchEvent(new Event('input'));
    const firmMid = bedrock.canvas.pressure_curve_samples(3)[1];
    const after = JSON.parse(localStorage.getItem('bedrock.settings.v1')).pressureCurve;
    return { pts, mid, label, saved, circles, firmMid, after, label2: document.getElementById('pressure-value').textContent };
  });
  assert.equal(r.pts.length, 2);
  assert.ok(Math.abs(r.pts[0] - 0.4) < 0.03 && Math.abs(r.pts[1] - 0.8) < 0.03, `dragged point ${r.pts}`);
  assert.ok(r.mid > 0.8, `soft curve lifts half pressure (${r.mid})`);
  assert.equal(r.label, 'Custom');
  assert.equal(r.saved.length, 1);
  assert.equal(r.circles, 1);
  assert.ok(r.firmMid < 0.45, `firm curve lowers half pressure (${r.firmMid})`);
  assert.equal(r.after, null);
  assert.equal(r.label2, 'Firm');
  await ctx.close();
});

test('pressure curve, steady hand and line smoothing survive a reload', async () => {
  const { page, ctx } = await openApp(env);
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('bedrock.settings.v1') || '{}');
    s.pressureCurve = [[0.3, 0.6], [0.7, 0.95]];
    s.smoothing = 60;
    s.smoother = 'classic';
    localStorage.setItem('bedrock.settings.v1', JSON.stringify(s));
  });
  await page.reload();
  await page.waitForFunction(() => window.bedrock?.canvas);
  const r = await page.evaluate(() => ({
    pts: Array.from(bedrock.canvas.pressure_points()).map((v) => Math.round(v * 100) / 100),
    smoothing: document.getElementById('smoothing').value,
    label: document.getElementById('smoothing-value').textContent,
    smoother: document.getElementById('smoother').value,
  }));
  assert.deepEqual(r, { pts: [0.3, 0.6, 0.7, 0.95], smoothing: '60', label: '60%', smoother: 'classic' });
  await ctx.close();
});

test('steady hand smooths a shaky line, old ink included', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async () => {
    // Zig-zag 6 px up and down: how far the ink strays from the middle.
    t.ev('pointerdown', 1, 'pen', 200, 300, { pressure: 0.5 });
    for (let i = 1; i <= 60; i++) t.ev('pointermove', 1, 'pen', 200 + i * 8, 300 + (i % 2 ? 6 : -6), { pressure: 0.5 });
    t.ev('pointerup', 1, 'pen', 680, 300, { pressure: 0 });
    await t.frame();
    const spread = () => {
      let lo = Infinity, hi = -Infinity;
      // A few peaks and troughs (pixel reads are slow).
      for (const x of [352, 360, 368, 376]) for (let yy = 290; yy <= 310; yy += 1) {
        if (bedrock.canvas.pixel_at(x, yy)[0] < 128) { lo = Math.min(lo, yy); hi = Math.max(hi, yy); }
      }
      return hi - lo;
    };
    const off = spread();
    const el = document.getElementById('smoothing');
    el.value = 100;
    el.dispatchEvent(new Event('input'));
    await t.frame();
    return { off, on: spread(), saved: JSON.parse(localStorage.getItem('bedrock.settings.v1')).smoothing };
  });
  assert.ok(r.on < r.off * 0.8, `smoothed line wobbles less: ${r.on} vs ${r.off}`);
  assert.equal(r.saved, 100);
  await ctx.close();
});

test('line smoothing: the Ink Stroke Modeler smooths timed pen input, Classic brings back the old filters', async () => {
  const { page, ctx, errors } = await openApp(env);
  const r = await page.evaluate(async () => {
    // A shaky line as a real pen reports it: a sample every 8 ms, wobbling
    // 6 px up and down.
    const t0 = performance.now() - 1000;
    t.ev('pointerdown', 1, 'pen', 200, 300, { pressure: 0.5, time: t0 });
    for (let i = 1; i <= 60; i++) t.ev('pointermove', 1, 'pen', 200 + i * 8, 300 + (i % 2 ? 6 : -6), { pressure: 0.5, time: t0 + i * 8 });
    t.ev('pointerup', 1, 'pen', 680, 300, { pressure: 0, time: t0 + 61 * 8 });
    await t.frame();
    const spread = () => {
      let lo = Infinity, hi = -Infinity;
      for (const x of [352, 360, 368, 376, 500, 508]) for (let yy = 285; yy <= 315; yy += 1) {
        if (bedrock.canvas.pixel_at(x, yy)[0] < 128) { lo = Math.min(lo, yy); hi = Math.max(hi, yy); }
      }
      return hi - lo;
    };
    // The rightmost column with ink: the line still reaches where the pen lifted.
    const reach = () => {
      for (let x = 700; x > 600; x -= 2) for (let yy = 285; yy <= 315; yy += 1) if (bedrock.canvas.pixel_at(x, yy)[0] < 128) return x;
      return 0;
    };
    const natural = { spread: spread(), reach: reach() };
    const el = document.getElementById('smoother');
    const usual = el.value;
    el.value = 'classic';
    el.dispatchEvent(new Event('change'));
    await t.frame();
    const classic = { spread: spread(), reach: reach() };
    return { usual, natural, classic, saved: JSON.parse(localStorage.getItem('bedrock.settings.v1')).smoother };
  });
  assert.equal(r.usual, 'modeler', 'the modeler is the default');
  assert.ok(r.natural.spread * 3 <= r.classic.spread, `the modeler takes out the wobble: ${r.natural.spread} vs ${r.classic.spread} px`);
  assert.ok(r.natural.reach >= 676 && r.classic.reach >= 676, `both reach the end: ${r.natural.reach}, ${r.classic.reach}`);
  assert.equal(r.saved, 'classic');
  assert.deepEqual(errors, []);
  await ctx.close();
});

/** A solid-colour PNG made in the page. */
const makePicture = `async (w, h, color) => {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, w, h);
  const b = await c.convertToBlob({ type: 'image/png' });
  return new File([b], 'square.png', { type: 'image/png' });
}`;

test('pictures: inserted in the middle under the ink, saved as a plain file in the note, and back after a reload', async () => {
  const context = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const { page, errors } = await openApp(env, { context });
  const r = await page.evaluate(async (make) => {
    const picture = await eval(make)(200, 100, '#e53935');
    await bedrock.insertPictures([picture]);
    for (let i = 0; i < 40 && bedrock.canvas.missing_images().length; i++) await t.frame();
    const tool = document.querySelector('[data-tool="lasso"]').getAttribute('aria-checked');
    const sel = JSON.parse(bedrock.canvas.selection_json());
    const [w, h] = [innerWidth, innerHeight];
    const centre = Array.from(bedrock.canvas.pixel_at(w / 2, h / 2));
    // Ink drawn over the picture stays on top.
    document.querySelector('[data-brush="pen"]').click();
    await t.line(w / 2 - 60, h / 2, w / 2 + 60, h / 2, { pressure: 1 });
    const inked = Array.from(bedrock.canvas.pixel_at(w / 2, h / 2));
    const note = JSON.parse(bedrock.canvas.export_json());
    await bedrock.saveNow();
    const saved = await bedrock.store.get(bedrock.noteId);
    return { tool, sel, centre, inked, images: note.images, files: bedrock.canvas.image_files(), size: saved.data.length };
  }, makePicture);
  assert.equal(r.tool, 'true', 'the lasso is picked so it can be moved right away');
  assert.equal(r.sel.images.length, 1);
  assert.ok(r.sel.handle, 'a lone picture has a resize handle');
  assert.ok(r.centre[0] > 200 && r.centre[1] < 90 && r.centre[2] < 90, `red picture in the middle: ${r.centre}`);
  assert.ok(r.inked[0] < 80, `pen ink over the picture: ${r.inked}`);
  assert.equal(r.images.length, 1);
  assert.match(r.images[0].file, /^images\/[0-9a-f]{32}\.png$/);
  assert.deepEqual([r.images[0].w, r.images[0].h], [200, 100]);
  assert.deepEqual(r.files, [r.images[0].file]);
  await page.waitForTimeout(100);
  await page.reload();
  await page.waitForFunction(() => window.bedrock && window.bedrock.ready);
  const back = await page.evaluate(async () => {
    // (the pointer helpers are gone after a reload)
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (let i = 0; i < 60 && bedrock.canvas.missing_images().length; i++) await frame();
    await frame();
    const img = JSON.parse(bedrock.canvas.images_json())[0];
    const [ox, oy, zoom] = bedrock.canvas.camera();
    const px = Array.from(bedrock.canvas.pixel_at((img.x + 20 - ox) * zoom, (img.y + 20 - oy) * zoom));
    return { n: JSON.parse(bedrock.canvas.images_json()).length, px };
  });
  assert.equal(back.n, 1);
  assert.ok(back.px[0] > 200 && back.px[1] < 90, `the picture shows after reopening: ${back.px}`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('pictures: drag the corner to resize, drag to move, delete; undo brings each back', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async (make) => {
    await bedrock.insertPictures([await eval(make)(200, 100, '#2f6bff')]);
    const c = bedrock.canvas;
    const img = () => JSON.parse(c.images_json())[0];
    const [ox, oy, zoom] = c.camera();
    const scr = (x, y) => [(x - ox) * zoom, (y - oy) * zoom];
    const a = img();
    const [hx, hy] = scr(a.x + a.w, a.y + a.h);
    await t.line(hx, hy, hx + 100, hy + 10); // handle → 300 wide
    const resized = img();
    const [mx, my] = scr(resized.x + 50, resized.y + 50);
    await t.line(mx, my, mx - 40, my + 30); // move
    const moved = img();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace' }));
    const afterDelete = JSON.parse(c.images_json()).length;
    c.undo();
    const undone1 = img();
    c.undo();
    const undone2 = img();
    c.undo();
    return { a, resized, moved, afterDelete, undone1, undone2, gone: JSON.parse(c.images_json()).length };
  }, makePicture);
  assert.ok(Math.abs(r.resized.w - 300) < 1 && Math.abs(r.resized.h - 150) < 1, `kept its shape: ${JSON.stringify(r.resized)}`);
  assert.equal(r.resized.x, r.a.x);
  assert.ok(Math.abs(r.moved.x - (r.resized.x - 40)) < 1 && Math.abs(r.moved.y - (r.resized.y + 30)) < 1);
  assert.equal(r.afterDelete, 0);
  assert.deepEqual(r.undone1, r.moved);
  assert.deepEqual(r.undone2, r.resized);
  assert.equal(r.gone, 1, 'the third undo takes back the resize, the picture stays');
  await ctx.close();
});

test('lasso: duplicate strokes and a picture from the selection menu; the copy is selected and drags away, one undo', async () => {
  const context = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const { page, errors } = await openApp(env, { context });
  const r = await page.evaluate(async (make) => {
    bedrock.minimap.visible = false;
    const c = bedrock.canvas;
    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    await t.line(100, 100, 200, 120);
    await bedrock.insertPictures([await eval(make)(200, 100, '#2f6bff')]);
    for (let i = 0; i < 40 && c.missing_images().length; i++) await t.frame();
    const out = { tool: document.querySelector('[data-tool="lasso"]').getAttribute('aria-checked') };
    // A loop around everything: the line and the picture.
    const loop = [[20, 20], [1000, 20], [1000, 740], [20, 740], [22, 24]];
    t.ev('pointerdown', 2, 'pen', ...loop[0], { pressure: 0.5 });
    for (const p of loop.slice(1)) t.ev('pointermove', 2, 'pen', ...p, { pressure: 0.5 });
    t.ev('pointerup', 2, 'pen', 22, 24, { pressure: 0 });
    const sel0 = JSON.parse(c.selection_json());
    out.selected = [sel0.strokes.length, sel0.images.length];
    const ink0 = JSON.parse(c.export_json()).strokes.map((s) => s.points.slice(0, 2));
    // Hold on the selection to open its menu, then Duplicate.
    const pic = JSON.parse(c.images_json())[0];
    const [ox, oy, zoom] = c.camera();
    const px = (pic.x + pic.w / 2 - ox) * zoom;
    const py = (pic.y + pic.h / 2 - oy) * zoom;
    t.ev('pointerdown', 3, 'pen', px, py, { pressure: 0.5 });
    await sleep(700);
    t.ev('pointerup', 3, 'pen', px, py, { pressure: 0 });
    await t.frame();
    out.duplicateShown = !$('wm-duplicate').hidden;
    $('wm-duplicate').click();
    await t.frame();
    out.menuClosed = $('word-menu').hidden;
    const sel1 = JSON.parse(c.selection_json());
    out.counts = [c.stroke_count(), JSON.parse(c.images_json()).length];
    out.copySelected = [sel1.strokes.length, sel1.images.length];
    out.newIds = !sel1.strokes.some((id) => sel0.strokes.includes(id)) && !sel1.images.some((id) => sel0.images.includes(id));
    out.offset = [sel1.bounds[0] - sel0.bounds[0], sel1.bounds[1] - sel0.bounds[1]].map((v) => Math.round(v * zoom));
    // Drag the copy 150 px right: the original stays.
    const cx = ((sel1.bounds[0] + sel1.bounds[2]) / 2 - ox) * zoom;
    const cy = ((sel1.bounds[1] + sel1.bounds[3]) / 2 - oy) * zoom;
    await t.line(cx, cy, cx + 150, cy);
    const sel2 = JSON.parse(c.selection_json());
    out.dragged = Math.round((sel2.bounds[0] - sel1.bounds[0]) * zoom);
    const doc = JSON.parse(c.export_json());
    out.originalStays = JSON.stringify(doc.strokes[0].points.slice(0, 2)) === JSON.stringify(ink0[0]);
    out.oneFile = c.image_files().length;
    // Undo the drag and the duplicate.
    c.undo();
    c.undo();
    out.undone = [c.stroke_count(), JSON.parse(c.images_json()).length];
    // ⌘/Ctrl+D duplicates the selection too.
    const loop2 = [[20, 20], [1000, 20], [1000, 740], [20, 740], [22, 24]];
    t.ev('pointerdown', 4, 'pen', ...loop2[0], { pressure: 0.5 });
    for (const p of loop2.slice(1)) t.ev('pointermove', 4, 'pen', ...p, { pressure: 0.5 });
    t.ev('pointerup', 4, 'pen', 22, 24, { pressure: 0 });
    const key = new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, cancelable: true });
    window.dispatchEvent(key);
    out.shortcut = [c.stroke_count(), JSON.parse(c.images_json()).length, key.defaultPrevented];
    // Drawing a new loop elsewhere lets go of the copy.
    t.ev('pointerdown', 5, 'pen', 980, 30, { pressure: 0.5 });
    t.ev('pointermove', 5, 'pen', 1000, 30, { pressure: 0.5 });
    t.ev('pointerup', 5, 'pen', 1000, 30, { pressure: 0 });
    out.letGo = JSON.parse(c.selection_json()).bounds;
    return out;
  }, makePicture);
  assert.equal(r.tool, 'true', 'a new picture is selected with the lasso');
  assert.deepEqual(r.selected, [1, 1]);
  assert.ok(r.duplicateShown, 'the selection menu offers Duplicate');
  assert.ok(r.menuClosed);
  assert.deepEqual(r.counts, [2, 2]);
  assert.deepEqual(r.copySelected, [1, 1], 'the copy is the selection');
  assert.ok(r.newIds);
  assert.deepEqual(r.offset, [24, 24], 'a little down and to the right');
  assert.equal(r.dragged, 150, 'the copy drags right away');
  assert.ok(r.originalStays);
  assert.equal(r.oneFile, 1, 'the copied picture shares its file');
  assert.deepEqual(r.undone, [1, 1]);
  assert.deepEqual(r.shortcut, [2, 2, true]);
  assert.equal(r.letGo, null);
  assert.deepEqual(errors, []);
  await context.close();
});

test('paste works as the system does: a picture pastes a picture, text pastes a text box; text fields keep their paste', async () => {
  const { page, ctx } = await openApp(env);
  const r = await page.evaluate(async (make) => {
    const paste = (fill, target = document.body) => {
      const dt = new DataTransfer();
      fill(dt);
      const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const pic = await eval(make)(60, 40, '#2e7d32');
    const a = paste((dt) => dt.items.add(pic));
    for (let i = 0; i < 20 && !JSON.parse(bedrock.canvas.images_json()).length; i++) await t.frame();
    const b = paste((dt) => dt.setData('text/plain', 'Shopping list\r\nmilk\teggs\n\n'));
    // In the title field the system's own paste is left alone.
    const c = paste((dt) => dt.setData('text/plain', 'title'), document.getElementById('title'));
    for (let i = 0; i < 20 && bedrock.canvas.missing_images().length; i++) await t.frame();
    const note = JSON.parse(bedrock.canvas.export_json());
    const box = note.texts?.[0];
    const [ox, oy, zoom] = bedrock.canvas.camera();
    // Some dark text pixels inside the box.
    let dark = 0;
    for (let x = box.x; x < box.x + box.w; x += 2) {
      const [r] = bedrock.canvas.pixel_at((x - ox) * zoom, (box.y + box.h * 0.35 - oy) * zoom);
      if (r < 120) dark++;
    }
    return { a, b, c, images: note.images?.length, text: box?.text, dark, selected: JSON.parse(bedrock.canvas.selection_json()).images.length };
  }, makePicture);
  assert.deepEqual({ a: r.a, b: r.b, c: r.c }, { a: true, b: true, c: false });
  assert.equal(r.images, 1);
  assert.equal(r.text, 'Shopping list\nmilk    eggs');
  assert.ok(r.dark > 3, `the text is drawn (${r.dark} dark samples)`);
  assert.equal(r.selected, 1, 'the pasted text box is selected');
  await ctx.close();
});

// Smoothness: a frame while the pen is writing is only the stroke under it.
// The underlines, the minimap and the selection used to be redrawn on every
// frame, also when only the live stroke had changed.
test('while the pen is down, frames draw the ink and nothing else', async () => {
  const { page, ctx, errors } = await openApp(env);
  const r = await page.evaluate(async () => {
    const hw = bedrock.handwriting;
    let draws = 0;
    const draw = hw.draw.bind(hw);
    hw.draw = () => { draws++; return draw(); };
    let maps = 0;
    const update = bedrock.minimap.update.bind(bedrock.minimap);
    bedrock.minimap.update = () => { maps++; return update(); };
    await t.frame();
    const before = { ...bedrock.frameStats };
    draws = 0; maps = 0;
    t.ev('pointerdown', 1, 'pen', 200, 300, { pressure: 0.5 });
    for (let i = 1; i <= 40; i++) {
      t.ev('pointermove', 1, 'pen', 200 + i * 6, 300 + Math.sin(i / 4) * 40, { pressure: 0.5 });
      await new Promise((res) => requestAnimationFrame(res));
    }
    await t.frame();
    const during = { draws, maps, inkOnly: bedrock.frameStats.inkOnly - before.inkOnly, full: bedrock.frameStats.full - before.full };
    t.ev('pointerup', 1, 'pen', 440, 300, { pressure: 0 });
    await t.frame();
    return { during, afterDraws: draws, afterMaps: maps, strokes: bedrock.canvas.stroke_count() };
  });
  assert.ok(r.during.inkOnly >= 20, `ink-only frames while writing: ${JSON.stringify(r.during)}`);
  assert.equal(r.during.full, 0, 'no full frame while writing');
  assert.equal(r.during.draws, 0, 'the underlines are not redrawn mid-stroke');
  assert.equal(r.during.maps, 0, 'the minimap is not redrawn mid-stroke');
  assert.ok(r.afterDraws > 0 && r.afterMaps > 0, 'everything is redrawn once the stroke is on the page');
  assert.equal(r.strokes, 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a scribble fades the ink it will erase before the pen lifts', async () => {
  const { page, ctx, errors } = await openApp(env);
  const r = await page.evaluate(async () => {
    bedrock.handwriting.enabled = false;
    const c = bedrock.canvas;
    for (let k = 0; k < 3; k++) {
      const x = 300 + k * 22;
      t.ev('pointerdown', 1, 'pen', x, 300, { pressure: 0.6 });
      for (let j = 1; j <= 8; j++) t.ev('pointermove', 1, 'pen', x + j * 2, 300 - (j % 2) * 26, { pressure: 0.6 });
      t.ev('pointerup', 1, 'pen', x + 16, 300, { pressure: 0 });
    }
    await t.frame();
    const out = { early: -1, late: -1 };
    t.ev('pointerdown', 2, 'pen', 290, 272, { pressure: 0.6 });
    for (let i = 1; i <= 90; i++) {
      const pass = Math.floor(i / 6);
      const f = (i % 6) / 6;
      t.ev('pointermove', 2, 'pen', pass % 2 === 0 ? 290 + 80 * f : 370 - 80 * f, 272 + i * 0.4, { pressure: 0.6 });
      if (i === 8) out.early = c.scribble_preview();
    }
    await t.frame();
    out.late = c.scribble_preview();
    out.stillThere = c.stroke_count();
    t.ev('pointerup', 2, 'pen', 290, 308, { pressure: 0 });
    await t.frame();
    out.after = c.stroke_count();
    out.cleared = c.scribble_preview();
    return out;
  });
  assert.equal(r.early, 0, 'one pass is not a scribble');
  assert.equal(r.late, 3, 'the three strokes of the word are marked');
  assert.equal(r.stillThere, 3, 'nothing is erased while the pen is down');
  assert.equal(r.after, 0);
  assert.equal(r.cleared, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('“Show latency” reports the frame rate, and a pen trace can be recorded', async () => {
  const { page, ctx, errors } = await openApp(env);
  const r = await page.evaluate(async () => {
    document.getElementById('show-latency').click();
    const input = bedrock.input;
    input.startTrace();
    t.ev('pointerdown', 1, 'pen', 200, 300, { pressure: 0.5 });
    for (let i = 1; i <= 30; i++) {
      t.ev('pointermove', 1, 'pen', 200 + i * 6, 300, { pressure: 0.5 });
      await new Promise((res) => requestAnimationFrame(res));
    }
    t.ev('pointerup', 1, 'pen', 380, 300, { pressure: 0 });
    await t.frame();
    const trace = input.stopTrace();
    return { hud: document.getElementById('hud').textContent, trace, again: input.stopTrace(), button: document.getElementById('record-trace').textContent };
  });
  assert.match(r.hud, /frames \d+\/s \(every [\d.]+ ms, slowest [\d.]+\) {2}drawing [\d.]+ ms/);
  const types = r.trace.events.map((e) => e.type);
  assert.equal(types[0], 'down');
  assert.equal(types.at(-1), 'up');
  assert.equal(types.filter((x) => x === 'move').length, 30);
  assert.ok(r.trace.events.every((e) => e.kind === 'pen' && e.id === 1 && [e.x, e.y, e.pressure, e.altitude, e.azimuth, e.time].every(Number.isFinite)));
  assert.equal(r.trace.pen_samples, 30);
  assert.deepEqual(r.trace.viewport, [1024, 768]);
  assert.equal(r.again, null);
  assert.equal(r.button, 'Record a pen trace');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the main menu fits a short screen and scrolls', async () => {
  const { page, ctx, errors } = await openApp(env, { viewport: { width: 1024, height: 420 } });
  const r = await page.evaluate(async () => {
    const out = {};
    document.getElementById('btn-menu').click();
    await t.frame();
    const menu = document.getElementById('menu');
    out.menuOpen = !menu.hidden;
    out.bottom = menu.getBoundingClientRect().bottom;
    out.vh = innerHeight;
    out.overflows = menu.scrollHeight > menu.clientHeight + 20;
    menu.scrollTop = menu.scrollHeight;
    out.scrolled = menu.scrollTop > 0;
    const items = [...menu.querySelectorAll('button, a')].filter((b) => b.offsetParent);
    out.lastVisible = items[items.length - 1].getBoundingClientRect().bottom <= menu.getBoundingClientRect().bottom + 1;
    return out;
  });
  assert.ok(r.menuOpen);
  assert.ok(r.bottom <= r.vh, `menu ends on screen: ${r.bottom} <= ${r.vh}`);
  assert.ok(r.overflows, 'menu content is taller than the short screen, so it scrolls');
  assert.ok(r.scrolled && r.lastVisible, 'the last item can be scrolled into view');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('holding a stroke lifts it: it grows around its middle and casts a shadow; its menu just appears', async () => {
  const { page, ctx, errors } = await openApp(env);
  const r = await page.evaluate(async () => {
    const c = bedrock.canvas;
    bedrock.minimap.visible = false;
    // A horizontal bar from x 300 to 500 at y 300: its middle is x 400.
    t.ev('pointerdown', 1, 'pen', 300, 300, { pressure: 0.6 });
    for (let j = 1; j <= 20; j++) t.ev('pointermove', 1, 'pen', 300 + j * 10, 300, { pressure: 0.6 });
    t.ev('pointerup', 1, 'pen', 500, 300, { pressure: 0 });
    await t.frame();
    // Where the ink ends along the bar's row, on the paper layer and on the ink layer.
    const extent = (read) => {
      let lo = -1, hi = -1;
      for (let x = 250; x <= 550; x += 1) {
        const p = read(x);
        if (p) { if (lo < 0) lo = x; hi = x; }
      }
      return [lo, hi];
    };
    const onPaper = (x) => c.pixel_at(x, 300)[0] < 128;
    const onInk = (x) => { const p = c.overlay_pixel_at(x, 300); return p[3] > 128; };
    const out = { before: extent(onPaper) };
    const wm = document.getElementById('word-menu');
    const sid = JSON.parse(c.words_json()).flatMap((w) => w.strokes)[0];
    out.hasId = !!sid;
    bedrock.wordMenu.open({ id: null, bounds: [300, 290, 500, 310], kind: 'text', text: null, link: null, strokes: [sid] });
    out.menuAnims = wm.getAnimations().length;
    out.menuShadow = getComputedStyle(wm).boxShadow;
    await new Promise((res) => setTimeout(res, 300));
    out.after = extent(onInk);
    out.offPaper = !onPaper(400);
    out.filter = getComputedStyle(document.getElementById('overlay')).filter;
    out.paperFilter = getComputedStyle(document.getElementById('base')).filter;
    bedrock.wordMenu.close();
    await t.frame();
    out.back = extent(onPaper);
    out.inkBack = onPaper(400) && !onInk(400);
    out.filterBack = document.getElementById('overlay').classList.contains('lifted');
    out.paperBack = document.getElementById('base').classList.contains('behind-lift');
    return out;
  });
  assert.ok(r.hasId && r.before[0] > 0, `the stroke is on the paper: ${r.before}`);
  assert.equal(r.menuAnims, 0, 'the menu itself does not animate');
  assert.doesNotMatch(r.menuShadow, /18px 40px/, 'the menu keeps its normal shadow');
  assert.ok(r.offPaper, 'while held, the stroke is drawn on the ink layer, not the paper');
  const grow = (r.after[1] - r.after[0]) - (r.before[1] - r.before[0]);
  assert.ok(grow > 6, `it grows: ${r.before} -> ${r.after}`);
  const mid = (a) => (a[0] + a[1]) / 2;
  assert.ok(Math.abs(mid(r.after) - mid(r.before)) < 1.5, `around its middle: ${mid(r.before)} vs ${mid(r.after)}`);
  assert.match(r.filter, /drop-shadow/, 'it casts a drop shadow');
  assert.equal(r.paperFilter, 'blur(2px)', 'the rest of the page is blurred a little');
  assert.ok(!r.paperBack, 'and sharp again once the menu closes');
  assert.ok(r.inkBack && !r.filterBack, 'closing the menu puts it back');
  assert.ok(Math.abs((r.back[1] - r.back[0]) - (r.before[1] - r.before[0])) < 1, `back at its own size: ${r.back}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});
