// The plugin's own error log and sending reports, without Obsidian imports
// so tests can drive it. Errors inside the canvas (the web app in the
// iframe) are caught there by apps/web/src/errors.js and shown in its own
// panel; that panel sends through `send-report` here, because a request from
// the plugin has no CORS limits. The spec is
// openspec/specs/error-reporting/spec.md.

import { DEFAULT_API, isSafeApi } from '../../web/src/collect.js';
import { buildReport, postReport, scrub } from '../../web/src/error-report.js';

const MAX_ENTRIES = 50;

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

  entries() { return this.list.map((e) => ({ ...e })); }
  clear() { this.list.length = 0; }

  report({ comment = '', appVersion, now = Date.now() } = {}) {
    return buildReport(this.entries(), { stage: 'running', comment, app: 'obsidian', appVersion, facts: {}, now });
  }
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
