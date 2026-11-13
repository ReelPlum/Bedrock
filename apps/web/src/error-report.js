// The error report (`bedrock-error-report` version 1), built from the error
// log. Pure: no page, host or Obsidian objects, so the web app's panel
// (report-panel.js), the Obsidian plugin and the tests share it. The
// backend's checks are the reference (collect-core/src/report.rs in the
// backend repository); the spec is openspec/specs/error-reporting/spec.md.

import { APP_VERSION, deviceClass, uuidv7 } from './collect.js';

export const FORMAT = 'bedrock-error-report';
export const VERSION = 1;
export const MAX_COMMENT = 2000;
const MAX_ERRORS = 50;

/** Browser engine and major version only, never the user agent. */
export function browserTag(ua = globalThis.navigator?.userAgent || '') {
  const m = (re) => ua.match(re)?.[1];
  let v;
  if ((v = m(/Obsidian\/(\d+)/))) return `obsidian ${v}`;
  if ((v = m(/Edg\/(\d+)/))) return `edge ${v}`;
  if ((v = m(/Firefox\/(\d+)/) || m(/FxiOS\/(\d+)/))) return `firefox ${v}`;
  if ((v = m(/CriOS\/(\d+)/) || m(/Chrome\/(\d+)/))) return `chrome ${v}`;
  if ((v = m(/Version\/(\d+)[.\d]* (?:Mobile\/\w+ )?Safari/))) return `safari ${v}`;
  if (/AppleWebKit/.test(ua)) return 'webkit';
  return undefined;
}

/** A few yes/no facts that often explain a failure. */
export function context(win = globalThis) {
  const facts = {};
  try { facts.webgl2 = !!win.document.createElement('canvas').getContext('webgl2'); } catch (_) { facts.webgl2 = false; }
  facts.webassembly = typeof win.WebAssembly === 'object';
  facts.indexeddb = !!win.indexedDB;
  facts.service_worker = !!win.navigator?.serviceWorker?.controller;
  facts.offline = win.navigator?.onLine === false;
  if (win.bedrock) facts.background_saving = !!win.bedrock.backgroundSaving;
  return facts;
}

/** The report as it is sent. Pure, so it can be tested and reused. */
export function buildReport(entries, {
  stage = 'running', comment = '', app = 'web', appVersion = APP_VERSION,
  device = deviceClass(), browser = browserTag(), facts = {}, now = Date.now(), id = uuidv7(now),
} = {}) {
  const r = {
    format: FORMAT,
    version: VERSION,
    id,
    app,
    app_version: appVersion,
    device,
    stage: stage === 'startup' ? 'startup' : 'running',
    created: Math.floor(now),
    errors: entries.slice(-MAX_ERRORS).map((e) => {
      const out = { kind: e.kind, message: e.message, at: Math.floor(e.at) };
      if (e.stack) out.stack = e.stack;
      if (e.count > 1) out.count = e.count;
      return out;
    }),
    context: facts,
  };
  if (browser) r.browser = browser;
  const c = String(comment || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, MAX_COMMENT);
  if (c) r.comment = c;
  return r;
}

/** Folders, addresses and query strings out of a message or stack: only
 *  file names (with a stack's line and column) stay. The same rules as
 *  errors.js, which cannot import this module because it must load first. */
export function scrub(text, max = Infinity) {
  let s = String(text ?? '');
  s = s.replace(/\b(?:blob:)?[a-z][a-z0-9+.-]*:\/\/[^\s()'"<>]*/gi, (url) => {
    const where = url.match(/:\d+(?::\d+)?$/)?.[0] || '';
    const path = url.slice(0, url.length - where.length).replace(/[?#].*$/, '');
    const name = path.slice(path.lastIndexOf('/') + 1);
    return (name || '…') + where;
  });
  s = s.replace(/(?:[A-Za-z]:)?(?:~|(?<![\w.]))(?:[\\/][^\\/\s()'"<>:]+)+[\\/]/g, '');
  s = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/** POSTs a report with `post(url, body)` → `{ status, json }`. Resolves to
 *  its id; throws with a message for people. */
export async function postReport(report, url, post) {
  if (!url) throw new Error('Sending is not switched on in this version yet.');
  let res;
  try {
    res = await post(url, JSON.stringify(report));
  } catch (_) {
    throw new Error('Could not reach the Bedrock team. Check the connection and try again.');
  }
  if (res.status !== 200) {
    throw new Error(res.status === 429 ? 'Too many reports just now. Try again in a minute.' : `The report was refused (${res.json?.detail || `HTTP ${res.status}`}).`);
  }
  return res.json?.id || report.id;
}
