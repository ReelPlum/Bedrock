// Lasso tool: draws the loop while it is being drawn and a dashed box around
// the selection (following it while it is dragged). The core decides what
// is selected and moves it; this only shows it. A lone picture gets a
// round handle on its corner for resizing.

export class SelectionView {
  constructor(marks, canvas) {
    this.marks = marks;
    this.canvas = canvas;
  }

  /** Call every frame, after the marks layer was cleared and drawn. */
  draw() {
    const m = this.marks;
    const loop = this.canvas.lasso_points();
    const sel = loop.length ? null : JSON.parse(this.canvas.selection_json());
    if (!loop.length && !sel?.bounds) return;
    const dpr = m.width / Math.max(m.clientWidth, 1);
    const [ox, oy, zoom] = this.canvas.camera();
    const g = m.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ink = getComputedStyle(m).getPropertyValue('--selection').trim() || '#2f6bff';
    g.strokeStyle = ink;
    g.lineWidth = 1.5;
    g.setLineDash([5, 4]);
    if (loop.length) {
      g.beginPath();
      for (let i = 0; i < loop.length; i += 2) {
        const x = (loop[i] - ox) * zoom;
        const y = (loop[i + 1] - oy) * zoom;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    } else {
      const [dx, dy] = this.canvas.drag_offset();
      const pad = 6;
      const [x0, y0, x1, y1] = sel.bounds;
      const x = (x0 + (dx || 0) - ox) * zoom - pad;
      const y = (y0 + (dy || 0) - oy) * zoom - pad;
      const w = (x1 - x0) * zoom + 2 * pad;
      const h = (y1 - y0) * zoom + 2 * pad;
      g.fillStyle = ink;
      g.globalAlpha = 0.06;
      g.fillRect(x, y, w, h);
      g.globalAlpha = 1;
      g.strokeRect(x, y, w, h);
      if (sel.handle) {
        // A lone picture: drag this corner to resize it.
        g.setLineDash([]);
        g.beginPath();
        g.arc((sel.handle[0] + (dx || 0) - ox) * zoom + pad / 2, (sel.handle[1] + (dy || 0) - oy) * zoom + pad / 2, 8, 0, Math.PI * 2);
        g.fillStyle = '#fff';
        g.fill();
        g.lineWidth = 2;
        g.stroke();
      }
    }
    g.setLineDash([]);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
}
