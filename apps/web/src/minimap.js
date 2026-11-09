// Minimap: the whole note in a corner, with the camera's view as a box.
//
// The area shown is the drawing's bounding box, widened only as far as
// needed to keep the camera in sight (from the engine), and it eases between
// sizes so it doesn't jump. When you come back to the drawing it shrinks to
// fit the drawing again.
//
// The ink is drawn into a cached bitmap covering the drawing, rebuilt only
// when the strokes change; each frame scales that bitmap into the current
// area and draws the view box on top. Tap or drag on the minimap to move.
// Below it: the zoom level and a button that fits the whole drawing.

const W = 168;
const H = 112;
const INK_RES = 2; // ink bitmap resolution, relative to the minimap's size
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
    this.inkRect = null; // world rect the ink bitmap covers
    this.inkScale = 0; // minimap scale the bitmap was drawn for
    this.revision = -1;
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

  /** Another note was opened: rebuild, and jump instead of easing. */
  reset() {
    this.revision = -1;
    this.area = null;
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (dpr === this.dpr && this.view.width === Math.round(W * dpr)) return;
    this.dpr = dpr;
    this.view.width = Math.round(W * dpr);
    this.view.height = Math.round(H * dpr);
    this.revision = -1;
  }

  /** Call after every rendered frame. Cheap unless the ink changed. */
  update(force = false) {
    if (!this.visible) return;
    this._resize();
    this._updateZoom();
    const target = this.canvas.minimap_region();
    let moving = false;
    if (!this.area) {
      this.area = Array.from(target);
    } else {
      moving = false;
      for (let i = 0; i < 4; i++) {
        const d = target[i] - this.area[i];
        const size = Math.max(target[2] - target[0], target[3] - target[1], 1e-9);
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

    // Rebuild the ink bitmap when the strokes changed, or when the area has
    // settled at a scale far from the one the bitmap was drawn at (scaled
    // bitmaps get faint lines when shrunk and blurry ones when enlarged).
    const rev = this.canvas.revision();
    const rescale = !moving && this.inkScale && Math.abs(Math.log(s / this.inkScale)) > Math.log(1.4);
    if (rescale) this.revision = -1;
    if (rev !== this.revision) {
      // While writing, the strokes change every frame: rebuild at most a few
      // times a second, and once more when the pen rests.
      const now = performance.now();
      if (force || this.revision < 0 || now - this.lastBuild >= REBUILD_WHILE_DRAWING_MS) {
        this._buildInk();
        this.revision = rev;
        this.lastBuild = now;
      } else if (!this.pending) {
        this.pending = setTimeout(() => { this.pending = null; this.update(true); }, REBUILD_WHILE_DRAWING_MS);
      }
    }
    this._draw();
  }

  _updateZoom() {
    if (!this.zoomLabel) return;
    const zoom = this.canvas.camera()[2];
    const text = `${Math.round(zoom * 100)}%`;
    if (this.zoomLabel.textContent !== text) this.zoomLabel.textContent = text;
  }

  /** Draw all strokes into a bitmap covering the drawing's bounds. */
  _buildInk() {
    const b = this.canvas.ink_bounds();
    const g = this.ink.getContext('2d');
    if (b.length !== 4) {
      this.inkRect = null;
      return;
    }
    const m = Math.max(b[2] - b[0], b[3] - b[1], 1) * 0.02;
    const r = [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
    // Drawn at the minimap's current scale (times INK_RES for sharpness).
    // The drawing always fits inside the area, so the bitmap is never
    // larger than INK_RES times the minimap.
    this.inkScale = this.map.s;
    const s = this.map.s * INK_RES * this.dpr;
    this.ink.width = Math.max(1, Math.ceil((r[2] - r[0]) * s));
    this.ink.height = Math.max(1, Math.ceil((r[3] - r[1]) * s));
    this.inkRect = r;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.ink.width, this.ink.height);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Skip detail finer than half a bitmap pixel.
    const data = this.canvas.minimap_strokes(0.5 / s);
    const minWidth = 1.2 * INK_RES * this.dpr;
    let i = 0;
    while (i < data.length) {
      const n = data[i];
      const c = data[i + 1] >>> 0;
      const w = data[i + 2];
      i += 3;
      g.strokeStyle = `rgba(${c >>> 24},${(c >>> 16) & 255},${(c >>> 8) & 255},${(c & 255) / 255})`;
      g.lineWidth = Math.max(w * s, minWidth); // thin ink stays visible
      g.beginPath();
      for (let k = 0; k < n; k++) {
        const x = (data[i + 2 * k] - r[0]) * s;
        const y = (data[i + 2 * k + 1] - r[1]) * s;
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      if (n === 1) g.lineTo((data[i] - r[0]) * s + 0.01, (data[i + 1] - r[1]) * s);
      g.stroke();
      i += 2 * n;
    }
  }

  _draw() {
    const g = this.view.getContext('2d');
    const dpr = this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.view.width, this.view.height);
    const { x0, y0, s, ox, oy } = this.map;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.inkRect) {
      const r = this.inkRect;
      g.imageSmoothingQuality = 'high';
      g.drawImage(this.ink, ox + (r[0] - x0) * s, oy + (r[1] - y0) * s, (r[2] - r[0]) * s, (r[3] - r[1]) * s);
    }
    const [vx0, vy0, vx1, vy1] = this.canvas.view_rect();
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
