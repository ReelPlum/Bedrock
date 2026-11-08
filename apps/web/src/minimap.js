// Minimap: the whole note in a corner, with the camera's view as a box.
//
// The area shown comes from the engine (all ink plus the view; it only
// grows while a note is open). The ink is redrawn into a cached bitmap only
// when the strokes or the area change; each frame just copies it and draws
// the view box. Tap or drag on the minimap to move there.

const W = 168;
const H = 112;
const REBUILD_WHILE_DRAWING_MS = 400;

export class Minimap {
  constructor(el, canvas, { onMove } = {}) {
    this.el = el;
    this.canvas = canvas;
    this.onMove = onMove || (() => {});
    this.view = el.querySelector('canvas');
    this.ink = document.createElement('canvas');
    this.key = '';
    this.lastBuild = 0;
    this.pending = null;
    this.map = null; // { x0, y0, s, ox, oy }: world -> minimap px
    this.dpr = 1;
    this._bind();
  }

  get visible() {
    return !this.el.hidden;
  }

  set visible(v) {
    this.el.hidden = !v;
    if (v) this.update(true);
  }

  /** Forget the cached ink (another note was opened). */
  reset() {
    this.key = '';
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (dpr === this.dpr && this.view.width === Math.round(W * dpr)) return;
    this.dpr = dpr;
    for (const c of [this.view, this.ink]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    this.key = '';
  }

  /** Call after every rendered frame. Cheap unless the ink changed. */
  update(force = false) {
    if (!this.visible) return;
    this._resize();
    const [x0, y0, x1, y1] = this.canvas.minimap_region();
    const pad = 6;
    const s = Math.min((W - 2 * pad) / Math.max(x1 - x0, 1e-6), (H - 2 * pad) / Math.max(y1 - y0, 1e-6));
    const ox = (W - (x1 - x0) * s) / 2;
    const oy = (H - (y1 - y0) * s) / 2;
    this.map = { x0, y0, s, ox, oy };
    const key = `${this.canvas.revision()}|${x0}|${y0}|${x1}|${y1}|${this.dpr}`;
    if (key !== this.key) {
      // While writing, the strokes change every frame: rebuild at most a few
      // times a second, and once more when the pen rests.
      const now = performance.now();
      if (force || now - this.lastBuild >= REBUILD_WHILE_DRAWING_MS) {
        this._buildInk();
        this.key = key;
        this.lastBuild = now;
      } else if (!this.pending) {
        this.pending = setTimeout(() => { this.pending = null; this.update(true); }, REBUILD_WHILE_DRAWING_MS);
      }
    }
    this._draw();
  }

  _buildInk() {
    const { x0, y0, s, ox, oy } = this.map;
    const g = this.ink.getContext('2d');
    const dpr = this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.ink.width, this.ink.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Skip detail finer than half a minimap pixel.
    const data = this.canvas.minimap_strokes(0.5 / (s * dpr));
    const u32 = new Uint32Array(data.buffer, data.byteOffset, data.length);
    let i = 0;
    while (i < data.length) {
      const n = data[i];
      const c = u32[i + 1];
      const w = data[i + 2];
      i += 3;
      g.strokeStyle = `rgba(${c >>> 24},${(c >>> 16) & 255},${(c >>> 8) & 255},${(c & 255) / 255})`;
      // Keep thin ink visible at any scale.
      g.lineWidth = Math.max(w * s, 1.2);
      g.beginPath();
      for (let k = 0; k < n; k++) {
        const x = ox + (data[i + 2 * k] - x0) * s;
        const y = oy + (data[i + 2 * k + 1] - y0) * s;
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      if (n === 1) g.lineTo(ox + (data[i] - x0) * s + 0.01, oy + (data[i + 1] - y0) * s);
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
