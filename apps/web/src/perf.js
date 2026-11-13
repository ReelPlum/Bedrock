// Watching for moments Bedrock is slow, and what was running then.
//
// The watcher notices four kinds of slow moment ("episodes"):
//
//   * latency:  the pen lagged: over a stroke, the time from the pen event
//               to the frame that drew it was, for the slowest 5% of
//               frames, over 3 frame intervals (so a frame was missed;
//               50 ms where the browser draws 60 frames a second, as
//               Safari does) and over 25 ms;
//   * stutter:  one frame came over 100 ms after the pen or finger moved;
//   * slow_tap: a tap or key took over 200 ms to answer (Event Timing:
//               Safari 26.2+, Chrome, Firefox);
//   * long_job: one of Bedrock's own jobs (save, open, recognise, …) took
//               far longer than usual.
//
// Each episode is logged with a snapshot of what was running: Bedrock's
// jobs at that moment (and those that ended just before), what the person
// was doing, the tool, a rough stroke count and zoom, how handwriting is
// read, and, where the browser has Long Animation Frames (Chromium, so
// Obsidian on desktop), the scripts that held the page. A script of
// Obsidian, of another plugin or of a browser extension is only labelled as
// such, never named. No note content, no words, no file names of notes.
//
// Episodes go to the error log (`bedrockErrors.slow` in errors.js), so the
// person sees them in "Share with the Bedrock team" and decides. Only when
// they switched on "Send performance reports automatically" does
// `AutoSender` send them by itself, at most 3 reports a day. The spec is
// openspec/specs/performance/spec.md.

import { scrub } from './error-report.js';

export const LIMITS = {
  // The pen lagged when the stroke's p95 latency is over both of these.
  // A browser's normal pipeline already takes up to 2 frames from the pen
  // event to the frame that draws it (iPad Safari: about 33 ms at 60
  // frames a second), so lag means at least one frame more than that.
  latencyP95: 25,
  latencyFrames: 3,
  // The frame interval assumed until one is known (60 frames a second).
  frameInterval: 1000 / 60,
  stutter: 100,
  tap: 200,
  // A stroke needs this many frames for its p95 to mean something.
  strokeFrames: 8,
};

/** A job slower than this (ms) is an episode. Jobs not listed are only
 *  shown in snapshots. */
export const JOB_LIMITS = {
  save: 2000,
  open: 3000,
  library: 2000,
  recognize: 8000,
  'import-pdf': 60000,
  // The Obsidian plugin's own jobs (apps/obsidian/src/session.js).
  read: 2000,
  write: 2000,
  index: 3000,
  unpack: 10000,
};

const MESSAGES = {
  latency: 'The pen lagged',
  stutter: 'Bedrock stuttered',
  slow_tap: 'A tap was slow to answer',
  long_job: 'A job took long',
};

/** Jobs that ended this recently (ms) still show in a snapshot. */
const RECENT_MS = 2000;
const MAX_JOBS = 10;
const MAX_SCRIPTS = 5;
const NAME = /^[a-z0-9_+-]{1,32}$/;

/** The stroke count, rounded into a class (never the number itself). */
export function strokesBucket(n) {
  if (!Number.isFinite(n)) return undefined;
  if (n < 100) return '0-100';
  if (n < 1000) return '100-1k';
  if (n < 5000) return '1k-5k';
  if (n < 20000) return '5k-20k';
  return '20k+';
}

/** The zoom, rounded into a class. */
export function zoomBucket(z) {
  if (!Number.isFinite(z) || z <= 0) return undefined;
  if (z < 0.5) return 'under-half';
  if (z < 1) return 'half-1';
  if (z < 2) return '1-2';
  if (z < 4) return '2-4';
  return '4+';
}

/** Where a script came from: a Bedrock file by its name, anything else by
 *  a label only. */
export function scriptSource(url, { appBase = '' } = {}) {
  const u = String(url || '');
  if (!u) return 'unknown';
  if (/^(?:chrome|moz|safari-web|safari)-extension:/i.test(u)) return 'extension';
  if (appBase && u.startsWith(appBase)) return scrub(u, 80) || 'bedrock';
  if (/^plugin:/i.test(u)) return 'another plugin';
  if (/^app:\/\/obsidian\.md\//i.test(u) || /^app:\/\/[^/]+\/(?:app|lib|enhance)\.js/i.test(u)) return 'obsidian';
  return 'other';
}

function p95(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

const name = (v) => (typeof v === 'string' && NAME.test(v) ? v : undefined);

export class PerfWatcher {
  constructor({
    record = (e) => globalThis.bedrockErrors?.slow?.(e),
    facts = () => ({}),
    now = () => performance.now(),
    appBase = '',
  } = {}) {
    this.record = record;
    this.facts = facts;
    this.now = now;
    this.appBase = appBase;
    this.running = new Set();
    this.finished = [];
    this.stroke = null;
    this.frames = [];
    this.interval = 0; // the usual time between frames, once known
    this.observers = [];
  }

  /** Changes how the watcher reads the app (main.js sets this up). */
  configure(opts) {
    for (const k of ['record', 'facts', 'now', 'appBase']) if (opts[k] !== undefined) this[k] = opts[k];
    return this;
  }

  /** Marks a job as started; call the returned function when it ends.
   *  Its `restart()` starts the clock again, for a job that first had to
   *  wait for something that is not its own work (a model download). */
  start(job) {
    const j = { job, start: this.now() };
    this.running.add(j);
    try { performance.mark?.(`bedrock:${job}`); } catch (_) { /* old browser */ }
    const end = () => this._end(j);
    end.restart = () => { j.start = this.now(); };
    return end;
  }

  /** Runs `fn` as the job `job`; works for plain and async functions. */
  job(job, fn) {
    const end = this.start(job);
    let out;
    try { out = fn(); } catch (e) { end(); throw e; }
    if (out && typeof out.then === 'function') return out.finally(end);
    end();
    return out;
  }

  _end(j) {
    if (!this.running.delete(j)) return;
    j.end = this.now();
    this.finished.push(j);
    this.finished = this.finished.filter((f) => j.end - f.end <= RECENT_MS).slice(-MAX_JOBS);
    const ms = j.end - j.start;
    try { performance.measure?.(`bedrock:${j.job}`, { start: j.start, end: j.end }); } catch (_) { /* old browser */ }
    const limit = JOB_LIMITS[j.job];
    if (limit && ms > limit) this.episode('long_job', ms, { message: `${MESSAGES.long_job}: ${j.job}`, from: j.start });
  }

  /** One drawn frame. `latency` is the time from the input event to this
   *  frame (0 when no input led to it); `interval` the usual time between
   *  frames (input.js measures it; 0 while unknown). */
  frame({ latency = 0, drawing = false, moving = false, interval = 0 } = {}) {
    if (interval > 0 && interval < 100) this.interval = interval;
    if (latency > LIMITS.stutter && (drawing || moving)) this.episode('stutter', latency, { from: this.now() - latency });
    if (drawing) {
      if (!this.stroke) this.stroke = { from: this.now(), latencies: [] };
      if (latency > 0) this.stroke.latencies.push(latency);
    } else if (this.stroke) {
      const { latencies, from } = this.stroke;
      this.stroke = null;
      if (latencies.length >= LIMITS.strokeFrames) {
        const p = p95(latencies);
        if (p > this.latencyLimit()) this.episode('latency', p, { from, doing: 'writing' });
      }
    }
  }

  /** The p95 latency (ms) over which a stroke lagged, at this screen's
   *  frame rate. */
  latencyLimit() {
    return Math.max(LIMITS.latencyP95, LIMITS.latencyFrames * (this.interval || LIMITS.frameInterval));
  }

  /** A tap or key that took `duration` ms to show its answer. */
  tap(duration, start = this.now() - duration) {
    if (duration > LIMITS.tap) this.episode('slow_tap', duration, { from: start });
  }

  /** A Long Animation Frame entry (Chromium). */
  longFrame(entry) {
    const scripts = (entry.scripts || []).map((s) => ({
      url: s.sourceURL || s.sourceLocation || '',
      fn: s.sourceFunctionName || '',
      ms: s.duration || 0,
    }));
    const end = entry.startTime + entry.duration;
    this.frames.push({ start: entry.startTime, end, scripts });
    this.frames = this.frames.filter((f) => end - f.end <= 10_000).slice(-50);
  }

  /** What was running between `from` and now. `doing` says what the
   *  person was doing when it is known better than now (a stroke's lag is
   *  noticed once the pen is lifted). */
  snapshot(from = this.now(), { doing } = {}) {
    const now = this.now();
    const jobs = [
      ...[...this.running].map((j) => ({ job: j.job, ms: Math.round(now - j.start), running: true })),
      ...this.finished.filter((j) => now - j.end <= RECENT_MS).map((j) => ({ job: j.job, ms: Math.round(j.end - j.start) })),
    ].filter((j) => name(j.job)).sort((a, b) => b.ms - a.ms).slice(0, MAX_JOBS);
    const snap = { running: jobs };
    let f = {};
    try { f = this.facts() || {}; } catch (_) { /* the page is half set up */ }
    const add = (k, v) => { if (name(v)) snap[k] = v; };
    add('doing', doing || f.doing);
    add('tool', f.tool);
    add('strokes_bucket', strokesBucket(f.strokes));
    add('zoom_bucket', zoomBucket(f.zoom));
    add('recognizer', f.recognizer);
    const scripts = this._scripts(from - 50, now);
    if (scripts.length) snap.scripts = scripts;
    return snap;
  }

  _scripts(from, to) {
    const sum = new Map();
    for (const fr of this.frames) {
      if (fr.end < from || fr.start > to) continue;
      for (const s of fr.scripts) {
        const source = scriptSource(s.url, { appBase: this.appBase });
        const ours = this.appBase && s.url.startsWith(this.appBase);
        // Only Bedrock's own function names: another plugin's could name it.
        const fn = ours && s.fn ? scrub(s.fn, 80) : undefined;
        const key = `${source}\n${fn || ''}`;
        const cur = sum.get(key) || { source, ms: 0 };
        if (fn) cur.function = fn;
        cur.ms += s.ms;
        sum.set(key, cur);
      }
    }
    return [...sum.values()].sort((a, b) => b.ms - a.ms).slice(0, MAX_SCRIPTS).map((s) => ({ ...s, ms: Math.round(s.ms) }));
  }

  episode(what, ms, { message = MESSAGES[what], from, doing } = {}) {
    try {
      this.record({ what, ms: Math.round(ms), message, snapshot: this.snapshot(from, { doing }) });
    } catch (_) { /* never break the app over this */ }
  }

  /** Starts the browser's own observers (Event Timing, Long Animation
   *  Frames) where they exist. */
  observe(win = globalThis) {
    const PO = win.PerformanceObserver;
    if (!PO) return this;
    const types = PO.supportedEntryTypes || [];
    if (types.includes('event')) {
      try {
        const o = new PO((list) => {
          for (const e of list.getEntries()) if (e.interactionId) this.tap(e.duration, e.startTime);
        });
        o.observe({ type: 'event', durationThreshold: LIMITS.tap, buffered: false });
        this.observers.push(o);
      } catch (_) { /* not supported after all */ }
    }
    if (types.includes('long-animation-frame')) {
      try {
        const o = new PO((list) => { for (const e of list.getEntries()) this.longFrame(e); });
        o.observe({ type: 'long-animation-frame', buffered: false });
        this.observers.push(o);
      } catch (_) { /* not supported after all */ }
    }
    return this;
  }
}

/** The watcher the app shares (main.js configures it; handwriting.js and
 *  others time their jobs with it). */
export const perf = new PerfWatcher();

export const PERF_KEY = 'bedrock.perf.v1';
export const AUTO_PER_DAY = 3;

/** Sends slow episodes by itself, only when the person switched it on:
 *  a minute after an episode (so a burst goes as one report), slow entries
 *  only, no comment, at most `AUTO_PER_DAY` reports a day. */
export class AutoSender {
  constructor({
    storage = globalThis.localStorage,
    entries = () => globalThis.bedrockErrors?.entries() || [],
    build,
    send,
    wall = () => Date.now(),
    delay = 60_000,
    perDay = AUTO_PER_DAY,
    timers = globalThis,
  } = {}) {
    Object.assign(this, { storage, entries, build, send, wall, delay, perDay, timers });
    this.timer = null;
  }

  _state() {
    try {
      const s = JSON.parse(this.storage.getItem(PERF_KEY) || '{}');
      return { auto: s.auto === true, day: String(s.day || ''), count: Number(s.count) || 0, last: Number(s.last) || 0 };
    } catch (_) { return { auto: false, day: '', count: 0, last: 0 }; }
  }

  _save(s) {
    try { this.storage.setItem(PERF_KEY, JSON.stringify(s)); } catch (_) { /* private mode */ }
  }

  get on() { return this._state().auto; }

  set on(v) {
    const s = this._state();
    s.auto = !!v;
    // Only what happens from now on is sent by itself.
    if (s.auto) s.last = Math.max(s.last, this.wall());
    this._save(s);
    if (!s.auto && this.timer) { this.timers.clearTimeout(this.timer); this.timer = null; }
  }

  /** Called on every slow episode. */
  episode() {
    if (!this.on || this.timer) return;
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.flush(); }, this.delay);
  }

  /** Sends what is new, if allowed. Resolves to what happened. */
  async flush() {
    const s = this._state();
    if (!s.auto) return 'off';
    const day = new Date(this.wall()).toISOString().slice(0, 10);
    if (s.day !== day) { s.day = day; s.count = 0; }
    if (s.count >= this.perDay) { this._save(s); return 'limit'; }
    const fresh = this.entries().filter((e) => e.kind === 'slow' && e.at > s.last);
    if (!fresh.length) return 'nothing';
    try {
      await this.send(this.build(fresh));
    } catch (_) {
      return 'failed'; // tried again after the next episode
    }
    const now = this._state(); // the person may have switched it off meanwhile
    now.day = day;
    now.count = s.count + 1;
    now.last = Math.max(...fresh.map((e) => e.at));
    this._save(now);
    return 'sent';
  }
}
