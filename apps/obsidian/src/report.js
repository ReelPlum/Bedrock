// The plugin's own error log and sending reports, without Obsidian imports
// so tests can drive it. Errors inside the canvas (the web app in the
// iframe) are caught there by apps/web/src/errors.js and shown in its own
// panel; that panel sends through `send-report` here, because a request from
// the plugin has no CORS limits. The spec is
// openspec/specs/error-reporting/spec.md.

import { DEFAULT_API, isSafeApi } from '../../web/src/collect.js';
import { buildReport, postReport, scrub } from '../../web/src/error-report.js';
import { PerfWatcher } from '../../web/src/perf.js';

const MAX_ENTRIES = 50;
const SLOW_WHATS = ['latency', 'stutter', 'slow_tap', 'long_job'];
const SLOW_MERGE_MS = 30_000;

export class ErrorLog {
  constructor() { this.list = []; }

  /** Logs a problem the plugin told the person about (kind `shown`), or one
   *  it caught quietly (`error`). Folders are cut down to file names. */
  record(message, err, kind = 'shown') {
    const entry = { kind, message: scrub(message, 500) || 'unknown error', at: Date.now(), count: 1 };
    const stack = err?.stack ? scrub(err.stack).split('\n').map((l) => l.trim()).filter(Boolean).join('\n').slice(0, 4000) : '';
    if (stack) entry.stack = stack;
    const last = this.list[this.list.length - 1];
    if (last && last.kind === entry.kind && last.message === entry.message) last.count += 1;
    else this.list.push(entry);
    if (this.list.length > MAX_ENTRIES) this.list.splice(0, this.list.length - MAX_ENTRIES);
    return entry;
  }

  /** Logs a moment the plugin was slow (from its PerfWatcher), as the web
   *  app's errors.js does: the same kind within 30 s adds to one entry. */
  slow({ what, ms, message, snapshot } = {}, now = Date.now()) {
    if (!SLOW_WHATS.includes(what) || !Number.isFinite(ms)) return null;
    const msg = scrub(`Plugin: ${message || what}`, 500);
    const ms0 = Math.max(0, Math.round(ms));
    let entry = null;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (now - e.at >= SLOW_MERGE_MS) break;
      if (e.kind === 'slow' && e.what === what && e.message === msg) { entry = e; break; }
    }
    if (entry) {
      entry.count += 1;
      if (ms0 > entry.ms) { entry.ms = ms0; if (snapshot) entry.snapshot = snapshot; }
    } else {
      entry = { kind: 'slow', message: msg, what, ms: ms0, at: now, count: 1 };
      if (snapshot) entry.snapshot = snapshot;
      this.list.push(entry);
      if (this.list.length > MAX_ENTRIES) this.list.splice(0, this.list.length - MAX_ENTRIES);
    }
    return entry;
  }

  entries() { return this.list.map((e) => ({ ...e })); }
  clear() { this.list.length = 0; }

  report({ comment = '', appVersion, now = Date.now() } = {}) {
    return buildReport(this.entries(), { stage: 'running', comment, app: 'obsidian', appVersion, facts: {}, now });
  }
}

/** Times the plugin's own jobs (read, write, index, unpack); a job far
 *  over its usual time is logged in `log` as a slow moment. */
export function pluginWatcher(log, { mobile = false } = {}) {
  return new PerfWatcher({ record: (e) => log.slow(e), facts: () => ({ doing: mobile ? 'mobile' : 'desktop' }) });
}

/** An automatic performance report from the canvas, with the plugin's own
 *  slow moments since the last one added, and whether this is Obsidian on
 *  a phone or tablet. A report the person sent themselves goes as they saw
 *  it. Returns the report to send and the time of the newest entry added. */
export function withPluginSlow(report, log, { since = 0, mobile = false } = {}) {
  if (report?.sent !== 'auto') return { report, last: since };
  const mine = log.entries().filter((e) => e.kind === 'slow' && e.at > since);
  const errors = [...(report.errors || []), ...mine.map((e) => {
    const out = { kind: 'slow', message: e.message, at: Math.floor(e.at), what: e.what, ms: e.ms };
    if (e.count > 1) out.count = e.count;
    if (e.snapshot) out.snapshot = e.snapshot;
    return out;
  })].sort((a, b) => a.at - b.at).slice(-MAX_ENTRIES);
  const last = mine.length ? Math.max(...mine.map((e) => e.at)) : since;
  return { report: { ...report, errors, context: { ...(report.context || {}), mobile: !!mobile } }, last };
}

/** Where reports go, or '' while the backend has no address. */
export function reportsAddress(api = DEFAULT_API) {
  return isSafeApi(api) ? `${api}/v1/reports` : '';
}

/** Sends a report with Obsidian's `requestUrl`. Resolves to its id. */
export function sendReport(report, requestUrl, url = reportsAddress()) {
  return postReport(report, url, async (u, body) => {
    const res = await requestUrl({ url: u, method: 'POST', contentType: 'application/json', body, throw: false });
    let json = null;
    try { json = res.json; } catch (_) { /* not JSON */ }
    return { status: res.status, json };
  });
}
