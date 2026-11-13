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

// Holding the pen (or a finger, or the mouse) still this long on handwriting
// opens the word's menu instead of drawing.
export const LONG_PRESS_MS = 550;
const LONG_PRESS_SLOP_PX = 8;

// Predicted samples are only a latency trick: never draw more than this far
// ahead of the newest real sample, and never while the pen is lifting.
export const MAX_PREDICTION_MS = 12;
export const MAX_PREDICTED_POINTS = 2;

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
  // Pens report real pressure (0 while hovering). Mice report 0.5 while a
  // button is down; touches have no useful pressure.
  const pressure = e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0) : 0.5;
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
  constructor(stage, canvas, { onFrame, onCommit, onHover, onLongPress } = {}) {
    this.stage = stage;
    this.canvas = canvas;
    this.onFrame = onFrame || (() => {});
    this.onCommit = onCommit || (() => {});
    // Pencil hover (iPad with Apple Pencil Pro / 2): called with the tip's
    // stage position while it hovers above the glass, null when it leaves.
    this.onHover = onHover || (() => {});
    // Called with { x, y, pointerType } when a pointer is held still; return
    // true if it opened something, and the touch is then not drawn.
    this.onLongPress = onLongPress || null;
    this.presses = new Map(); // pointerId -> { x, y, timer }
    this.rect = stage.getBoundingClientRect();
    this.frameRequested = false;
    this.lastInputTime = 0;
    this.latency = { last: 0, avg: 0, samples: 0 };
    // Frame pacing while something is moving: the time between frames (so
    // 8.3 ms on a 120 Hz screen, 16.7 ms where the browser holds pages to
    // 60), the slowest recent frame, and Bedrock's own drawing time.
    this.frames = { interval: 0, worst: 0, work: 0, recent: [], lastTs: 0 };
    // Pen trace being recorded (see startTrace), or null.
    this.trace = null;
    this.active = new Map(); // pointerId -> kind
    this.lastPressure = new Map();
    this.prediction = true;
    this.samplesSeen = 0;
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
    requestAnimationFrame((ts) => {
      this.frameRequested = false;
      const began = performance.now();
      const drew = this.canvas.render();
      if (drew) this._pace(ts, performance.now() - began);
      let latency = 0;
      if (drew && this.lastInputTime) {
        const l = performance.now() - this.lastInputTime;
        latency = l;
        this.latency.last = l;
        this.latency.samples += 1;
        this.latency.avg += (l - this.latency.avg) / Math.min(this.latency.samples, 60);
        this.lastInputTime = 0;
      }
      this.onFrame(drew, latency);
      if (this.canvas.needs_render()) this.requestFrame();
    });
  }

  /** Frame statistics, from frames that follow each other directly. */
  _pace(ts, work) {
    const f = this.frames;
    const gap = ts - f.lastTs;
    f.lastTs = ts;
    f.work += (work - f.work) / 20;
    if (gap <= 0 || gap > 100) return; // the first frame after a rest
    f.recent.push(gap);
    if (f.recent.length > 120) f.recent.shift();
    const sorted = [...f.recent].sort((a, b) => a - b);
    f.interval = sorted[sorted.length >> 1];
    f.worst = sorted[sorted.length - 1];
  }

  /** Start recording what the pen, fingers and mouse do, exactly as it is
   *  passed to the engine. */
  startTrace() {
    const [x, y, zoom] = this.canvas.camera();
    this.trace = {
      description: `Recorded in Bedrock, ${new Date().toISOString()}. ${navigator.userAgent}`,
      viewport: [this.rect.width, this.rect.height],
      dpr: window.devicePixelRatio || 1,
      camera: [x, y, zoom],
      events: [],
    };
  }

  /** Stop recording. Returns the trace, in the shape of the engine's replay
   *  fixtures (crates/bedrock-core/tests/fixtures), or null. */
  stopTrace() {
    const t = this.trace;
    this.trace = null;
    if (!t) return null;
    const pen = t.events.filter((e) => e.kind === 'pen' && e.type === 'move');
    const span = pen.length > 1 ? pen[pen.length - 1].time - pen[0].time : 0;
    t.pen_samples = pen.length;
    t.duration_ms = span;
    return t;
  }

  _record(type, id, kind, s) {
    if (this.trace) this.trace.events.push({ type, kind, id, x: s.x, y: s.y, pressure: s.pressure, altitude: s.altitude, azimuth: s.azimuth, time: s.time });
  }

  /** End the active pointer. The up event's own position is not added for
   *  pens: it is reported after lift-off and would draw a tail. */
  _finish(e, cancelled) {
    this._endPress(e.pointerId);
    const kind = this.active.get(e.pointerId);
    if (!kind) return;
    this.active.delete(e.pointerId);
    this.lastPressure.delete(e.pointerId);
    if (cancelled) {
      this._record('cancel', e.pointerId, kind, sampleFrom(e, this.rect));
      this.canvas.pointer_cancel(e.pointerId, kind);
    } else {
      const s = sampleFrom(e, this.rect);
      if (kind === 'pen' || kind === 'eraser') s.pressure = 0;
      this._send('pointer_up', e.pointerId, kind, s);
      this.onCommit();
    }
    this.requestFrame();
  }

  _endPress(id) {
    const p = this.presses.get(id);
    if (p) { clearTimeout(p.timer); this.presses.delete(id); }
  }

  _longPress(id) {
    const p = this.presses.get(id);
    this.presses.delete(id);
    const kind = this.active.get(id);
    if (!p || !kind || this.active.size > 1) return;
    if (!this.onLongPress({ x: p.x, y: p.y, pointerType: p.pointerType })) return;
    // Opened a menu: this touch is not ink (or a pan) after all.
    this.active.delete(id);
    this.lastPressure.delete(id);
    this._record('cancel', id, kind, { x: p.x, y: p.y, pressure: 0, altitude: 0, azimuth: 0, time: performance.timeOrigin + performance.now() });
    this.canvas.pointer_cancel(id, kind);
    this.requestFrame();
  }

  /** Draw a short predicted tail, unless the pen is slowing down to lift. */
  _predict(e, kind, last) {
    const prev = this.lastPressure.get(e.pointerId) || 0;
    const isPen = kind === 'pen' || kind === 'eraser';
    let flat = new Float64Array(0);
    const lifting = isPen && last && (last.pressure < 0.08 || last.pressure < prev * 0.8);
    if (last) this.lastPressure.set(e.pointerId, last.pressure);
    if (this.prediction && last && !lifting && typeof e.getPredictedEvents === 'function') {
      const keep = [];
      for (const pe of e.getPredictedEvents()) {
        if (keep.length >= MAX_PREDICTED_POINTS) break;
        const s = sampleFrom(pe, this.rect);
        if (s.time - last.time > MAX_PREDICTION_MS) break;
        if (isPen && s.pressure === 0) s.pressure = last.pressure;
        keep.push(s);
      }
      flat = new Float64Array(keep.length * 6);
      keep.forEach((s, i) => flat.set([s.x, s.y, s.pressure, s.altitude, s.azimuth, s.time], i * 6));
    }
    // Always send, so an old tail is cleared when there is no new prediction.
    this.canvas.pointer_predicted(e.pointerId, flat);
  }

  _send(method, id, kind, s) {
    this._record(method.slice(8), id, kind, s);
    this.canvas[method](id, kind, s.x, s.y, s.pressure, s.altitude, s.azimuth, s.time);
  }

  _bind() {
    const st = this.stage;
    const opts = { passive: false };

    st.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.onHover(null);
      this.updateRect();
      if (e.pointerType === 'mouse' && e.button !== 0) {
        this.mousePan = { id: e.pointerId, x: e.clientX, y: e.clientY };
        st.setPointerCapture(e.pointerId);
        return;
      }
      try { st.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
      const kind = kindOf(e);
      this.active.set(e.pointerId, kind);
      this.lastPressure.set(e.pointerId, 0);
      this.lastInputTime = e.timeStamp;
      const s = sampleFrom(e, this.rect);
      // A few pens report 0 on the down event itself; it is a real contact.
      if (s.pressure === 0) s.pressure = 0.5;
      this._send('pointer_down', e.pointerId, kind, s);
      if (this.onLongPress && kind !== 'eraser') {
        if (this.active.size > 1) for (const id of [...this.presses.keys()]) this._endPress(id);
        else this.presses.set(e.pointerId, { x: s.x, y: s.y, pointerType: e.pointerType, timer: setTimeout(() => this._longPress(e.pointerId), LONG_PRESS_MS) });
      }
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
      const press = this.presses.get(e.pointerId);
      if (press && Math.hypot(e.clientX - this.rect.left - press.x, e.clientY - this.rect.top - press.y) > LONG_PRESS_SLOP_PX) {
        this._endPress(e.pointerId);
      }
      const kind = this.active.get(e.pointerId);
      if (!kind) {
        // A pen moving with no button down and not drawing is hovering.
        if (e.pointerType === 'pen' && e.buttons === 0 && this.enabled) {
          this.onHover({ x: e.clientX - this.rect.left, y: e.clientY - this.rect.top, eraser: kindOf(e) === 'eraser' });
        }
        return;
      }
      e.preventDefault();
      const isPen = kind === 'pen' || kind === 'eraser';
      // The pen left the glass but the browser has not sent pointerup yet
      // (Apple Pencil hover keeps sending moves): end the stroke right here,
      // so no line follows the tip after lifting.
      if (isPen && e.buttons === 0) {
        this._finish(e, false);
        return;
      }
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      const list = events.length ? events : [e];
      let last = null;
      for (const ce of list) {
        const s = sampleFrom(ce, this.rect);
        if (isPen && s.pressure === 0) continue; // hover / lift sample, not ink
        this._send('pointer_move', e.pointerId, kind, s);
        last = s;
      }
      this.samplesSeen += list.length;
      this._predict(e, kind, last);
      this.lastInputTime = e.timeStamp;
      this.requestFrame();
    }, opts);

    const end = (e) => {
      if (this.mousePan && e.pointerId === this.mousePan.id) {
        this.mousePan = null;
        return;
      }
      this._finish(e, e.type === 'pointercancel');
    };
    st.addEventListener('pointerup', end, opts);
    st.addEventListener('pointerleave', (e) => { if (e.pointerType === 'pen') this.onHover(null); });
    st.addEventListener('pointercancel', end, opts);
    st.addEventListener('lostpointercapture', (e) => {
      // Capture is released right after pointerup; treat it as a normal end.
      if (this.active.has(e.pointerId)) this._finish(e, false);
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
