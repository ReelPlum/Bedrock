// Where the toolbar (dock) and the minimap sit. Device preferences, kept in
// the settings in local storage, one layout per orientation, since a
// comfortable spot changes when the iPad turns.
//
// A layout is { dock, dockAt, map }:
//   dock    the edge the toolbar lies along: 'left' | 'right' | 'top' | 'bottom'
//   dockAt  where along that edge its middle is, 0 (start) .. 1 (end)
//   map     where the minimap is, [fx, fy] as shares of the free space
//           (0 = left/top, 1 = right/bottom), or null for the default spot
//
// Pure functions only, so they can be tested without a browser.

export const DOCKS = ['bottom', 'top', 'left', 'right'];
export const ORIENTATIONS = ['landscape', 'portrait'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isShare = (v) => Number.isFinite(v) && v >= 0 && v <= 1;

export function orientationOf(width, height) {
  return width >= height ? 'landscape' : 'portrait';
}

/** The first layout: the toolbar on the edge away from the writing hand,
 *  where the other hand holds the iPad. Most people write with their right
 *  hand, so an unknown hand gets the left edge. */
export function defaultLayout(handedness) {
  return { dock: handedness === 'left' ? 'right' : 'left', dockAt: 0.5, map: null };
}

function cleanLayout(l, fallback) {
  if (!l || typeof l !== 'object') return { ...fallback };
  return {
    dock: DOCKS.includes(l.dock) ? l.dock : fallback.dock,
    dockAt: isShare(l.dockAt) ? l.dockAt : 0.5,
    map: Array.isArray(l.map) && l.map.length === 2 && l.map.every(isShare) ? [l.map[0], l.map[1]] : null,
  };
}

/** Layouts from stored settings. Settings saved before layouts existed only
 *  have `dock`: that edge is kept, centred, for both orientations. */
export function loadLayouts(stored, handedness) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const base = DOCKS.includes(s.dock) ? { dock: s.dock, dockAt: 0.5, map: null } : defaultLayout(handedness);
  const saved = s.layouts && typeof s.layouts === 'object' ? s.layouts : {};
  return Object.fromEntries(ORIENTATIONS.map((o) => [o, cleanLayout(saved[o], base)]));
}

/** Where a dragged toolbar lands when let go at (x, y) on a w x h screen:
 *  the nearest edge, at the point along it where it was let go. */
export function snapDock(x, y, w, h) {
  const d = { left: x / w, right: 1 - x / w, top: y / h, bottom: 1 - y / h };
  const dock = Object.entries(d).sort((a, b) => a[1] - b[1])[0][0];
  const along = dock === 'left' || dock === 'right' ? y / h : x / w;
  return { dock, dockAt: clamp(along, 0, 1) };
}

/** The start (left or top, px) of something `size` long whose middle is at
 *  share `at` of `length`, kept `margin` inside both ends. */
export function placeAlong(at, length, size, margin) {
  const hi = Math.max(margin, length - margin - size);
  return clamp(at * length - size / 2, margin, hi);
}

/** Where a dragged minimap settles: snapped against the nearest edge, and
 *  into the corner when it is close to one. `r` is its rect when let go. */
export function snapMap(r, W, H, margin, corner = 0.15) {
  const freeX = Math.max(1, W - r.w - 2 * margin);
  const freeY = Math.max(1, H - r.h - 2 * margin);
  let fx = clamp((r.x - margin) / freeX, 0, 1);
  let fy = clamp((r.y - margin) / freeY, 0, 1);
  const d = { left: fx * freeX, right: (1 - fx) * freeX, top: fy * freeY, bottom: (1 - fy) * freeY };
  const edge = Object.entries(d).sort((a, b) => a[1] - b[1])[0][0];
  if (edge === 'left') fx = 0;
  if (edge === 'right') fx = 1;
  if (edge === 'top') fy = 0;
  if (edge === 'bottom') fy = 1;
  if (edge === 'left' || edge === 'right') { if (fy < corner) fy = 0; else if (fy > 1 - corner) fy = 1; }
  if (edge === 'top' || edge === 'bottom') { if (fx < corner) fx = 0; else if (fx > 1 - corner) fx = 1; }
  return [fx, fy];
}

/** The minimap's rect for a stored [fx, fy]. */
export function mapRect([fx, fy], W, H, w, h, margin) {
  return {
    x: margin + fx * Math.max(0, W - w - 2 * margin),
    y: margin + fy * Math.max(0, H - h - 2 * margin),
    w, h,
  };
}

const overlaps = (a, b, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** Moves `r` the shortest way off any of the `obstacles` it would cover,
 *  staying on a W x H screen; unchanged when it covers none, or when no spot
 *  nearby is free. */
export function stepAside(r, obstacles, W, H, margin, gap = 8) {
  const hits = obstacles.filter((o) => o && overlaps(r, o, gap));
  if (!hits.length) return r;
  const fits = (c) => c.x >= margin - 0.5 && c.y >= margin - 0.5 && c.x + c.w <= W - margin + 0.5 && c.y + c.h <= H - margin + 0.5
    && !obstacles.some((o) => o && overlaps(c, o, gap - 0.5));
  const candidates = [];
  for (const o of hits) {
    candidates.push(
      { ...r, x: o.x - gap - r.w }, { ...r, x: o.x + o.w + gap },
      { ...r, y: o.y - gap - r.h }, { ...r, y: o.y + o.h + gap },
    );
  }
  const ok = candidates.filter(fits).sort((a, b) => Math.hypot(a.x - r.x, a.y - r.y) - Math.hypot(b.x - r.x, b.y - r.y));
  return ok[0] || r;
}
