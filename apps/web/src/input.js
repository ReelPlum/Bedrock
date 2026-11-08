// Pointer event pipeline: forwards every pen sample to the Rust engine.
//
// Latency matters most here (research target: ink under ~40 ms):
//  * getCoalescedEvents() recovers every Apple Pencil sample (up to 240 Hz)
//    that the browser merged into one event per frame,
//  * getPredictedEvents() draws a short disposable tail ahead of the pen,
//  * the live stroke is drawn on a separate overlay layer, so a frame during
//    writing never redraws the whole page,
//  * frames are only requested when something changed (no idle redraw loop).

const HALF_PI = Math.PI / 2;

/** Pointer Events tiltX/tiltY (degrees) -> [altitude, azimuth] radians. */
export function tiltToAltitudeAzimuth(tiltX, tiltY) {
  if (!tiltX && !tiltY) return [HALF_PI, 0];
  const tx = (tiltX * Math.PI) / 180;
  const ty = (tiltY * Math.PI) / 180;
  let azimuth = Math.atan2(Math.tan(ty), Math.tan(tx));
  if (azimuth < 0) azimuth += 2 * Math.PI;
  const altitude = Math.abs(tiltX) >= 90 || Math.abs(tiltY) >= 90
    ? 0
    : Math.atan(1 / Math.hypot(Math.tan(tx), Math.tan(ty)));
  return [altitude, azimuth];
}

/** Normalised sample from a PointerEvent. */
export function sampleFrom(e, rect) {
  let altitude, azimuth;
  if (typeof e.altitudeAngle === 'number' && typeof e.azimuthAngle === 'number' && e.pointerType === 'pen') {
    altitude = e.altitudeAngle;
    azimuth = e.azimuthAngle;
  } else {
    [altitude, azimuth] = tiltToAltitudeAzimuth(e.tiltX || 0, e.tiltY || 0);
  }
  let pressure = e.pressure;
  if (e.pointerType !== 'pen') pressure = 0.5;
  else if (!(pressure > 0)) pressure = 0.5; // some pens report 0 on down
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
    pressure,
    altitude,
    azimuth,
    // Unix epoch ms, precise to sub-milliseconds.
    time: performance.timeOrigin + e.timeStamp,
  };
}

function kindOf(e) {
  if (e.pointerType === 'pen') return e.buttons & 32 || e.button === 5 ? 'eraser' : 'pen';
  if (e.pointerType === 'touch') return 'touch';
  return 'mouse';
}

export class InputController {
  constructor(stage, canvas, { onFrame, onCommit } = {}) {
    this.stage = stage;
    this.canvas = canvas;
    this.onFrame = onFrame || (() => {});
    this.onCommit = onCommit || (() => {});
    this.rect = stage.getBoundingClientRect();
    this.frameRequested = false;
    this.lastInputTime = 0;
    this.latency = { last: 0, avg: 0, samples: 0 };
    this.active = new Map(); // pointerId -> kind
    this.mousePan = null;
    this.enabled = true;
    this._bind();
  }

  updateRect() {
    this.rect = this.stage.getBoundingClientRect();
  }

  requestFrame() {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      const drew = this.canvas.render();
      if (drew && this.lastInputTime) {
        const l = performance.now() - this.lastInputTime;
        this.latency.last = l;
        this.latency.samples += 1;
        this.latency.avg += (l - this.latency.avg) / Math.min(this.latency.samples, 60);
        this.lastInputTime = 0;
      }
      this.onFrame(drew);
      if (this.canvas.needs_render()) this.requestFrame();
    });
  }

  _send(method, id, kind, s) {
    this.canvas[method](id, kind, s.x, s.y, s.pressure, s.altitude, s.azimuth, s.time);
  }

  _bind() {
    const st = this.stage;
    const opts = { passive: false };

    st.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.updateRect();
      if (e.pointerType === 'mouse' && e.button !== 0) {
        this.mousePan = { id: e.pointerId, x: e.clientX, y: e.clientY };
        st.setPointerCapture(e.pointerId);
        return;
      }
      try { st.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
      const kind = kindOf(e);
      this.active.set(e.pointerId, kind);
      this.lastInputTime = e.timeStamp;
      this._send('pointer_down', e.pointerId, kind, sampleFrom(e, this.rect));
      this.requestFrame();
    }, opts);

    st.addEventListener('pointermove', (e) => {
      if (this.mousePan && e.pointerId === this.mousePan.id) {
        this.canvas.pan(e.clientX - this.mousePan.x, e.clientY - this.mousePan.y);
        this.mousePan.x = e.clientX;
        this.mousePan.y = e.clientY;
        this.requestFrame();
        return;
      }
      const kind = this.active.get(e.pointerId);
      if (!kind) return;
      e.preventDefault();
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      const list = events.length ? events : [e];
      for (const ce of list) this._send('pointer_move', e.pointerId, kind, sampleFrom(ce, this.rect));
      if (typeof e.getPredictedEvents === 'function') {
        const predicted = e.getPredictedEvents();
        if (predicted.length) {
          const flat = new Float64Array(predicted.length * 6);
          predicted.forEach((pe, i) => {
            const s = sampleFrom(pe, this.rect);
            flat.set([s.x, s.y, s.pressure, s.altitude, s.azimuth, s.time], i * 6);
          });
          this.canvas.pointer_predicted(e.pointerId, flat);
        }
      }
      this.lastInputTime = e.timeStamp;
      this.requestFrame();
    }, opts);

    const end = (e) => {
      if (this.mousePan && e.pointerId === this.mousePan.id) {
        this.mousePan = null;
        return;
      }
      const kind = this.active.get(e.pointerId);
      if (!kind) return;
      this.active.delete(e.pointerId);
      if (e.type === 'pointercancel') {
        this.canvas.pointer_cancel(e.pointerId, kind);
      } else {
        this._send('pointer_up', e.pointerId, kind, sampleFrom(e, this.rect));
        this.onCommit();
      }
      this.requestFrame();
    };
    st.addEventListener('pointerup', end, opts);
    st.addEventListener('pointercancel', end, opts);
    st.addEventListener('lostpointercapture', (e) => {
      if (this.active.has(e.pointerId)) end(new PointerEvent('pointercancel', e));
    });

    // iOS Safari: stop the magnifier, text selection, page scroll and
    // double-tap zoom from stealing Apple Pencil / finger gestures.
    for (const t of ['touchstart', 'touchmove', 'touchend']) {
      st.addEventListener(t, (e) => { if (e.cancelable) e.preventDefault(); }, opts);
    }
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(t, (e) => e.preventDefault(), opts);
    }
    st.addEventListener('contextmenu', (e) => e.preventDefault());

    st.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.updateRect();
      const scale = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) {
        // Trackpad pinch (and ctrl+wheel) zooms around the cursor.
        this.canvas.zoom_at(e.clientX - this.rect.left, e.clientY - this.rect.top, Math.exp(-e.deltaY * scale * 0.01));
      } else {
        this.canvas.pan(-e.deltaX * scale, -e.deltaY * scale);
      }
      this.requestFrame();
    }, opts);
  }
}
