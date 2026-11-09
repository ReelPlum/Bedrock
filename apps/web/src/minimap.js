// Minimap: the whole note in a corner, with the camera's view as a box.
//
// The area shown is the drawing's bounding box, widened only as far as
// needed to keep the camera in sight (from the engine), and it eases between
// sizes so it doesn't jump. When you come back to the drawing it shrinks to
// fit the drawing again.
//
// Ink is always drawn at the minimap's own resolution with a fixed line
// width (never a scaled bitmap), so strokes keep the same thickness while
// you zoom and move. The ink layer is cached and redrawn only when the
// strokes or the area change; the view box is drawn on top each frame.
// Tap or drag on the minimap to move. Below it: the zoom level and a button
// that fits the whole drawing.

const W = 168;
const H = 112;
const INK_PX = 1.25; // line width of ink on the minimap, CSS px
const HIGHLIGHT_PX = 4;
const REBUILD_WHILE_DRAWING_MS = 400;
const EASE = 0.3; // share of the way to the target area per frame

export class Minimap {
  constructor(el, canvas, { onMove, onFit } = {}) {
    this.el = el;
    this.canvas = canvas;
    this.onMove = onMove || (() => {});
    this.view = el.querySelector('canvas');
    this.zoomLabel = el.querySelector('.minimap-zoom');
    this.fitButton = el.querySelector('.minimap-fit');
    this.ink = document.createElement('canvas');
    this.inkKey = ''; // area + revision the ink layer was drawn for
    this.data = null; // stroke polylines (Uint16Array), cached per revision and detail
    this.frame = []; // [x0, y0, span] the 16-bit coordinates are measured in
    this.dataRev = -1;
    this.dataTol = 0;
    this.revision = -1; // revision the minimap currently shows
    this.lastBuild = 0;
    this.pending = null;
    this.area = null; // eased world rect being shown
    this.map = null; // { x0, y0, s, ox, oy }: world -> minimap px
    this.dpr = 1;
    this.easing = false;
    if (this.fitButton && onFit) this.fitButton.addEventListener('click', onFit);
    this._bind();
  }

  get visible() {
    return !this.el.hidden;
  }

  set visible(v) {
    this.el.hidden = !v;
    if (v) this.update(true);
  }

  /** Another note was opened: redraw, and jump instead of easing. */
  reset() {
    this.revision = -1;
    this.dataRev = -1;
    this.area = null;
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (dpr === this.dpr && this.view.width === Math.round(W * dpr)) return;
    this.dpr = dpr;
    for (const c of [this.view, this.ink]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    this.inkKey = '';
  }

  /** Call after every rendered frame. Cheap unless the ink or area changed. */
  update(force = false) {
    if (!this.visible) return;
    this._resize();
    this._updateZoom();
    const target = this.canvas.minimap_region();
    if (!this.area) {
      this.area = Array.from(target);
    } else {
      let moving = false;
      const size = Math.max(target[2] - target[0], target[3] - target[1], 1e-9);
      for (let i = 0; i < 4; i++) {
        const d = target[i] - this.area[i];
        if (Math.abs(d) > size * 0.002) {
          this.area[i] += d * EASE;
          moving = true;
        } else {
          this.area[i] = target[i];
        }
      }
      if (moving && !this.easing) {
        this.easing = true;
        requestAnimationFrame(() => { this.easing = false; this.update(); });
      }
    }
    const [x0, y0, x1, y1] = this.area;
    const pad = 6;
    const s = Math.min((W - 2 * pad) / Math.max(x1 - x0, 1e-9), (H - 2 * pad) / Math.max(y1 - y0, 1e-9));
    this.map = { x0, y0, s, ox: (W - (x1 - x0) * s) / 2, oy: (H - (y1 - y0) * s) / 2 };

    // While writing, the strokes change every frame: pick them up at most a
    // few times a second, and once more when the pen rests.
    const rev = this.canvas.revision();
    if (rev !== this.revision) {
      const now = performance.now();
      if (force || this.revision < 0 || now - this.lastBuild >= REBUILD_WHILE_DRAWING_MS) {
        this.revision = rev;
        this.lastBuild = now;
      } else if (!this.pending) {
        this.pending = setTimeout(() => { this.pending = null; this.update(true); }, REBUILD_WHILE_DRAWING_MS);
      }
    }
    const key = `${this.revision}|${x0}|${y0}|${x1}|${y1}|${this.dpr}`;
    if (key !== this.inkKey) {
      this._drawInk();
      this.inkKey = key;
    }
    this._draw();
  }

  _updateZoom() {
    if (!this.zoomLabel) return;
    const zoom = this.canvas.camera()[2];
    const text = `${Math.round(zoom * 100)}%`;
    if (this.zoomLabel.textContent !== text) this.zoomLabel.textContent = text;
  }

  /** Stroke polylines (16-bit integers) simplified to about half a minimap
   *  pixel. Fetched again only when the strokes change or the detail needed
   *  changes a lot. */
  _strokes(s) {
    const tol = 0.5 / (s * this.dpr);
    const stale = this.dataRev !== this.revision || !this.data
      || tol < this.dataTol / 1.5 || tol > this.dataTol * 3;
    if (stale) {
      this.data = this.canvas.minimap_strokes(tol);
      this.frame = this.canvas.minimap_frame();
      this.dataRev = this.revision;
      this.dataTol = tol;
    }
    return this.data;
  }

  _drawInk() {
    const g = this.ink.getContext('2d');
    const dpr = this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.ink.width, this.ink.height);
    const { x0, y0, s, ox, oy } = this.map;
    const data = this._strokes(s);
    if (!data.length || this.frame.length !== 3) return;
    // q (0..65535) -> minimap px: x = ox + (fx + q / 65535 * span - x0) * s
    const [fx, fy, span] = this.frame;
    const k = (span / 65535) * s;
    const bx = ox + (fx - x0) * s;
    const by = oy + (fy - y0) * s;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    let i = 0;
    while (i < data.length) {
      const n = data[i] | (data[i + 1] << 16);
      const rg = data[i + 2];
      const ba = data[i + 3];
      const alpha = (ba & 255) / 255;
      i += 4;
      g.strokeStyle = `rgba(${rg >> 8},${rg & 255},${ba >> 8},${alpha})`;
      // Fixed widths, so nothing changes thickness as the area changes.
      g.lineWidth = alpha < 0.5 ? HIGHLIGHT_PX : INK_PX;
      g.beginPath();
      for (let j = 0; j < n; j++) {
        const x = bx + data[i + 2 * j] * k;
        const y = by + data[i + 2 * j + 1] * k;
        if (j === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      if (n === 1) g.lineTo(bx + data[i] * k + 0.01, by + data[i + 1] * k);
      g.stroke();
      i += 2 * n;
    }
  }

  _draw() {
    const g = this.view.getContext('2d');
    const dpr = this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.view.width, this.view.height);
    g.drawImage(this.ink, 0, 0);
    const { x0, y0, s, ox, oy } = this.map;
    const [vx0, vy0, vx1, vy1] = this.canvas.view_rect();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const x = ox + (vx0 - x0) * s;
    const y = oy + (vy0 - y0) * s;
    const w = Math.max((vx1 - vx0) * s, 3);
    const h = Math.max((vy1 - vy0) * s, 3);
    const accent = getComputedStyle(this.el).getPropertyValue('--accent').trim() || '#2f6bff';
    g.fillStyle = accent;
    g.globalAlpha = 0.1;
    g.fillRect(x, y, w, h);
    g.globalAlpha = 1;
    g.strokeStyle = accent;
    g.lineWidth = 1.5;
    g.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
  }

  /** Minimap px -> world point. */
  _toWorld(e) {
    const r = this.view.getBoundingClientRect();
    const { x0, y0, s, ox, oy } = this.map;
    return [x0 + (e.clientX - r.left - ox) / s, y0 + (e.clientY - r.top - oy) / s];
  }

  _bind() {
    let dragging = null;
    this.view.addEventListener('pointerdown', (e) => {
      if (!this.map) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = e.pointerId;
      try { this.view.setPointerCapture(e.pointerId); } catch (_) { /* synthetic or already gone */ }
      this.canvas.center_on(...this._toWorld(e));
      this.onMove();
    });
    this.view.addEventListener('pointermove', (e) => {
      if (dragging !== e.pointerId) return;
      e.preventDefault();
      this.canvas.center_on(...this._toWorld(e));
      this.onMove();
    });
    const end = (e) => { if (dragging === e.pointerId) dragging = null; };
    this.view.addEventListener('pointerup', end);
    this.view.addEventListener('pointercancel', end);
  }
}
