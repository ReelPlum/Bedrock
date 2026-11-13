// "Share with the Bedrock team": shows the error report exactly as it will
// be sent, lets the person add a comment, and sends it only when they press
// Send. `errors.js` keeps the log and opens this panel; the report itself is
// built in error-report.js. The spec is openspec/specs/error-reporting/spec.md.

import { apiAddress, isSafeApi, uuidv7 } from './collect.js';
import { host } from './host.js';
import { MAX_COMMENT, buildReport, context, postReport } from './error-report.js';

export { browserTag, buildReport, context } from './error-report.js';

/** Where reports go, or '' when sending is not set up (no backend yet). */
export function reportsAddress() {
  const api = apiAddress(loadStoredApi());
  return isSafeApi(api) ? `${api}/v1/reports` : '';
}

function loadStoredApi() {
  try { return JSON.parse(localStorage.getItem('bedrock.collect.v1') || '{}').api; } catch (_) { return undefined; }
}

/** Sends a report: through the host app when inside one (it has no CORS
 *  limits), else straight to the backend. Resolves to its id. */
export async function sendReport(report, { fetchFn = globalThis.fetch } = {}) {
  if (host) {
    const r = await host.rpc.call('send-report', { report });
    return r?.id || report.id;
  }
  return postReport(report, reportsAddress(), async (url, body) => {
    const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    let json = null;
    try { json = await res.json(); } catch (_) { /* not JSON */ }
    return { status: res.status, json };
  });
}

const CSS = `
.bx-panel-back { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.28); display: grid; place-items: center; padding: max(16px, env(safe-area-inset-top)) 16px 16px; }
.bx-panel { box-sizing: border-box; width: min(640px, 100%); max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px); display: flex; flex-direction: column; gap: 10px;
  background: #fff; color: #1c1c1e; border-radius: 16px; padding: 18px; box-shadow: 0 12px 40px rgba(0,0,0,.22);
  font: 15px/1.4 -apple-system, system-ui, sans-serif; text-align: left; }
.bx-panel h2 { margin: 0; font-size: 18px; }
.bx-panel p { margin: 0; color: #48484a; }
.bx-panel textarea { font: inherit; min-height: 64px; resize: vertical; border: 1px solid #d1d1d6; border-radius: 10px; padding: 8px 10px; }
.bx-panel pre { margin: 0; flex: 1 1 auto; min-height: 80px; overflow: auto; background: #f4f4f6; border-radius: 10px; padding: 10px;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
.bx-panel .bx-row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; align-items: center; }
.bx-panel .bx-row .bx-status { margin-right: auto; color: #48484a; }
.bx-panel button { font: inherit; border: 0; border-radius: 10px; padding: 8px 14px; background: #e9e9ee; color: #1c1c1e; cursor: pointer; }
.bx-panel button.bx-send { background: #2f6bff; color: #fff; }
.bx-panel button:disabled { opacity: .5; cursor: default; }`;

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

/** Opens the panel. Resolves when it is closed, to the id of the report
 *  that was sent, or null. */
export function open({ stage = 'running', entries = globalThis.bedrockErrors?.entries() || [] } = {}) {
  document.querySelector('.bx-panel-back')?.remove();
  if (!document.getElementById('bx-panel-style')) document.head.append(el('style', { id: 'bx-panel-style', textContent: CSS }));
  const now = Date.now();
  const id = uuidv7(now);
  const facts = context();
  const canSend = !!host || !!reportsAddress();
  const report = () => buildReport(entries, { stage, comment: comment.value, app: host ? 'obsidian' : 'web', facts, now, id });

  const comment = el('textarea', { placeholder: 'What were you doing? (optional)', maxLength: MAX_COMMENT, ariaLabel: 'Comment' });
  const pre = el('pre', { tabIndex: 0, ariaLabel: 'The report' });
  const status = el('span', { className: 'bx-status', role: 'status' });
  const send = el('button', { type: 'button', className: 'bx-send', textContent: 'Send', disabled: !canSend });
  const copy = el('button', { type: 'button', textContent: 'Copy' });
  const close = el('button', { type: 'button', textContent: 'Close' });
  const intro = entries.length
    ? 'This is everything that will be sent: what went wrong, the app version and the kind of device. No notes, no file names, nothing about you. Nothing is sent until you press Send.'
    : 'Nothing has gone wrong that Bedrock noticed. Say what happened and it is sent with the app version and the kind of device. Nothing is sent until you press Send.';
  const panel = el('div', { className: 'bx-panel', role: 'dialog', ariaModal: 'true', ariaLabel: 'Share with the Bedrock team' },
    el('h2', { textContent: 'Share with the Bedrock team' }),
    el('p', { textContent: intro }),
    comment,
    pre,
    el('div', { className: 'bx-row' }, status, copy, close, send));
  const back = el('div', { className: 'bx-panel-back' }, panel);

  const render = () => {
    const r = report();
    pre.textContent = JSON.stringify(r, null, 2);
    if (canSend) send.disabled = !r.errors.length && !r.comment;
  };
  render();
  if (!canSend) status.textContent = 'Sending is not switched on in this version yet: copy the report and email it to us.';
  comment.addEventListener('input', render);

  return new Promise((resolve) => {
    let sentId = null;
    const done = () => { back.remove(); resolve(sentId); };
    close.addEventListener('click', done);
    back.addEventListener('click', (e) => { if (e.target === back) done(); });
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(); });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(pre.textContent); status.textContent = 'Copied.'; } catch (_) {
        getSelection()?.selectAllChildren(pre);
        status.textContent = 'Select the text and copy it.';
      }
    });
    send.addEventListener('click', async () => {
      send.disabled = true;
      comment.disabled = true;
      status.textContent = 'Sending…';
      try {
        sentId = await sendReport(report());
        status.textContent = `Sent, thank you. Report ${sentId}`;
        globalThis.bedrockErrors?.clear();
        send.remove();
        close.textContent = 'Done';
      } catch (e) {
        status.textContent = e.message;
        send.disabled = false;
        comment.disabled = false;
      }
    });
    document.body.append(back);
    comment.focus();
  });
}
