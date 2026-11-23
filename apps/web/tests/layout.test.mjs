// Where the toolbar and the minimap sit (src/layout.js): pure functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayout, loadLayouts, mapRect, orientationOf, placeAlong, snapDock, snapMap, stepAside } from '../src/layout.js';

test('the toolbar starts on the edge away from the writing hand', () => {
  assert.equal(defaultLayout('right').dock, 'left');
  assert.equal(defaultLayout('left').dock, 'right');
  assert.equal(defaultLayout(null).dock, 'left', 'most people write with the right hand');
  assert.deepEqual(loadLayouts({}, 'left').portrait, { dock: 'right', dockAt: 0.5, map: null });
});

test('settings saved before layouts existed keep their toolbar edge', () => {
  // Settings as written by Bedrock before this change: only `dock`.
  const old = JSON.parse('{"brush":"pen","dock":"bottom","showMinimap":true}');
  const l = loadLayouts(old, 'left');
  assert.deepEqual(l.landscape, { dock: 'bottom', dockAt: 0.5, map: null });
  assert.deepEqual(l.portrait, { dock: 'bottom', dockAt: 0.5, map: null });
});

test('layouts are kept per orientation and broken values are ignored', () => {
  const l = loadLayouts({ dock: 'left', layouts: {
    landscape: { dock: 'right', dockAt: 0.8, map: [1, 0] },
    portrait: { dock: 'nowhere', dockAt: 7, map: [0.5] },
  } }, null);
  assert.deepEqual(l.landscape, { dock: 'right', dockAt: 0.8, map: [1, 0] });
  assert.deepEqual(l.portrait, { dock: 'left', dockAt: 0.5, map: null });
  assert.equal(orientationOf(1180, 820), 'landscape');
  assert.equal(orientationOf(820, 1180), 'portrait');
});

test('a dropped toolbar lands on the nearest edge, where it was let go', () => {
  assert.deepEqual(snapDock(10, 600, 1000, 800), { dock: 'left', dockAt: 0.75 });
  assert.deepEqual(snapDock(990, 200, 1000, 800), { dock: 'right', dockAt: 0.25 });
  assert.deepEqual(snapDock(800, 790, 1000, 800), { dock: 'bottom', dockAt: 0.8 });
  assert.deepEqual(snapDock(300, 5, 1000, 800), { dock: 'top', dockAt: 0.3 });
  // Kept on screen at the ends.
  assert.equal(placeAlong(0.95, 800, 400, 10), 390);
  assert.equal(placeAlong(0.02, 800, 400, 10), 10);
  assert.equal(placeAlong(0.5, 800, 400, 10), 200);
});

test('a dropped minimap settles against the nearest edge, or into a corner', () => {
  const W = 1000, H = 800, m = 10, w = 168, h = 142;
  // Near the left edge, halfway down: on the left edge, where it was.
  const [fx, fy] = snapMap({ x: 40, y: 330, w, h }, W, H, m);
  assert.equal(fx, 0);
  assert.ok(fy > 0.4 && fy < 0.6, `${fy}`);
  // Near the bottom-right corner: in the corner.
  assert.deepEqual(snapMap({ x: 800, y: 630, w, h }, W, H, m), [1, 1]);
  assert.deepEqual(mapRect([1, 1], W, H, w, h, m), { x: W - m - w, y: H - m - h, w, h });
});

test('the minimap steps aside instead of covering the toolbar', () => {
  const W = 1000, H = 800, m = 10;
  const toolbar = { x: 10, y: 100, w: 60, h: 600 };
  const map = { x: 10, y: 300, w: 168, h: 142 };
  const r = stepAside(map, [toolbar], W, H, m);
  assert.ok(r.x >= toolbar.x + toolbar.w, `moved right of the toolbar: ${JSON.stringify(r)}`);
  assert.equal(r.y, 300);
  const clear = { x: 400, y: 300, w: 168, h: 142 };
  assert.deepEqual(stepAside(clear, [toolbar], W, H, m), clear);
});
