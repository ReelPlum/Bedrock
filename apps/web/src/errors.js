// Catching errors, so a problem on someone's iPad can reach the Bedrock team.
//
// Loaded as a plain script before everything else on every page, so it
// catches startup failures too (the page module failing to load or to run).
// It keeps a short log of what went wrong (`window.bedrockErrors`) and:
//
//   * before the page is ready: shows what went wrong, with Reload and
//     "Share with the Bedrock team", instead of leaving an empty page (most
//     often the browser mixed files from two versions just after an update);
//   * after that: a quiet "Something went wrong" notice with Details, at
//     most once a minute, that never covers the canvas;
//   * Share opens `report-panel.js`, which shows the exact report and sends
//     it only when the person presses Send.
//
// No note content is collected on purpose: only error messages and stacks,
// with every folder and address cut down to the file name. The log lives in
// local storage (`bedrock.errors.v1`), so a failure that ends in a reload
// can still be reported afterwards. The spec is
// openspec/specs/error-reporting/spec.md.
(function () {
  const KEY = 'bedrock.errors.v1';
  const MAX_ENTRIES = 50;
  const MAX_MESSAGE = 500;
  const MAX_STACK = 4000;
  const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
  const NOTICE_EVERY_MS = 60_000;
  const KINDS = ['error', 'rejection', 'panic', 'worker', 'shown'];
  const here = document.currentScript?.src || location.href;
  const ready = () => !!(window.bedrock?.ready || window.trainer?.ready || window.setup?.ready);

  /** Folders, addresses and query strings out of a message or stack: only
   *  file names stay, so a vault, user or folder name never leaves. */
  function scrub(text, max) {
    let s = String(text ?? '');
    s = s.replace(/\b(?:blob:)?[a-z][a-z0-9+.-]*:\/\/[^\s()'"<>]*/gi, (url) => {
      // Keep a stack's line and column (main.js?v=3:10:5 → main.js:10:5).
      const where = url.match(/:\d+(?::\d+)?$/)?.[0] || '';
      const path = url.slice(0, url.length - where.length).replace(/[?#].*$/, '');
      const name = path.slice(path.lastIndexOf('/') + 1);
      return (name || '…') + where;
    });
    // Absolute paths: /Users/me/vault/x.js, C:\Users\me\x.js, ~/x.
    s = s.replace(/(?:[A-Za-z]:)?(?:~|(?<![\w.]))(?:[\\/][^\\/\s()'"<>:]+)+[\\/]/g, '');
    s = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
    if (s.length > max) s = `${s.slice(0, max - 1)}…`;
    return s;
  }

  function scrubStack(stack) {
    if (!stack) return undefined;
    const lines = scrub(stack, Infinity).split('\n').map((l) => l.trim()).filter(Boolean);
    let out = '';
    for (const l of lines) {
      const next = out ? `${out}\n${l}` : l;
      if (next.length > MAX_STACK) break;
      out = next;
    }
    return out || undefined;
  }

  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || '{}');
      const cutoff = Date.now() - KEEP_MS;
      return Array.isArray(v.entries)
        ? v.entries.filter((e) => e && KINDS.includes(e.kind) && typeof e.message === 'string' && e.at > cutoff).slice(-MAX_ENTRIES)
        : [];
    } catch (_) { return []; }
  }

  const entries = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ entries })); } catch (_) { /* private mode or full */ }
  }

  let lastNotice = 0;

  function messageOf(err) {
    if (err == null) return 'unknown error';
    if (typeof err === 'string') return err;
    if (err.message) return err.name && err.name !== 'Error' && !err.message.startsWith(err.name) ? `${err.name}: ${err.message}` : err.message;
    try { return String(err); } catch (_) { return 'unknown error'; }
  }

  /** Adds to the log. `kind` is one of KINDS. Returns the entry. */
  function record(kind, err, { stack } = {}) {
    const message = scrub(messageOf(err), MAX_MESSAGE) || 'unknown error';
    const entry = { kind: KINDS.includes(kind) ? kind : 'error', message, at: Date.now(), count: 1 };
    const s = scrubStack(stack ?? err?.stack);
    if (s) entry.stack = s;
    const last = entries[entries.length - 1];
    if (last && last.kind === entry.kind && last.message === entry.message && last.stack === entry.stack) {
      last.count += 1;
    } else {
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    }
    save();
    try { window.dispatchEvent(new CustomEvent('bedrock-error', { detail: entry })); } catch (_) { /* old browser */ }
    return entry;
  }

  function style() {
    if (document.getElementById('bx-style')) return;
    const s = document.createElement('style');
    s.id = 'bx-style';
    s.textContent = `
.bx-notice { position: fixed; z-index: 50; left: 50%; bottom: max(16px, env(safe-area-inset-bottom)); transform: translateX(-50%);
  display: flex; gap: 10px; align-items: center; padding: 8px 10px 8px 14px; border-radius: 12px;
  background: #1c1c1e; color: #fff; font: 14px/1.3 -apple-system, system-ui, sans-serif; box-shadow: 0 4px 18px rgba(0,0,0,.18); max-width: calc(100vw - 32px); }
.bx-notice button { font: inherit; border: 0; border-radius: 8px; padding: 6px 10px; background: rgba(255,255,255,.16); color: #fff; cursor: pointer; }
.bx-notice button.bx-x { background: none; padding: 6px; opacity: .7; }
.bx-fatal-actions { display: inline-flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.bx-fatal-actions button { font: inherit; }`;
    document.head.append(s);
  }

  /** Opens the panel that shows the report and sends it. */
  async function open(opts = {}) {
    try {
      const m = await import(new URL('report-panel.js', here).href);
      return m.open({ stage: ready() ? 'running' : 'startup', ...opts });
    } catch (e) {
      // A page from two versions may not load the panel either: still let
      // the person copy the log.
      record('error', e);
      const text = JSON.stringify(entries, null, 2);
      try { await navigator.clipboard.writeText(text); alert('The error log was copied. Please paste it into an email to the Bedrock team.'); } catch (_) { alert(text); }
      return null;
    }
  }

  function shareButton() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bx-share';
    b.textContent = 'Share with the Bedrock team';
    b.addEventListener('click', () => open());
    return b;
  }

  /** Shows a failure that stops the page, with Reload and Share. Keeps
   *  what the page already said (if anything) when `msg` is not given. */
  function fatal(msg, err) {
    // A message with its error is logged here; a message alone was logged
    // by whoever caught the error.
    if (err != null) record('shown', msg || err, { stack: err?.stack });
    let box = document.getElementById('fatal');
    if (!box) {
      box = document.createElement('div');
      box.id = 'fatal';
      box.className = 'fatal';
      document.body.append(box);
    }
    style();
    if (msg) box.textContent = msg;
    box.querySelector('.bx-fatal-actions')?.remove();
    const actions = document.createElement('span');
    actions.className = 'bx-fatal-actions';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Reload';
    reload.addEventListener('click', () => location.reload());
    actions.append(reload, shareButton());
    box.append(' ', actions);
    box.hidden = false;
    document.querySelector('.bx-notice')?.remove();
    return box;
  }

  /** A quiet note that something went wrong, at most once a minute. */
  function notice() {
    const now = Date.now();
    if (now - lastNotice < NOTICE_EVERY_MS || document.querySelector('.bx-notice')) return;
    lastNotice = now;
    style();
    const n = document.createElement('div');
    n.className = 'bx-notice';
    n.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = 'Something went wrong.';
    const details = document.createElement('button');
    details.type = 'button';
    details.textContent = 'Details';
    details.addEventListener('click', () => { n.remove(); open(); });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'bx-x';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '✕';
    close.addEventListener('click', () => n.remove());
    n.append(text, details, close);
    document.body.append(n);
    setTimeout(() => n.remove(), 12_000);
  }

  function caught(kind, err, stack) {
    record(kind, err, { stack });
    if (ready()) {
      notice();
      return;
    }
    const box = document.getElementById('fatal');
    if (box && !box.hidden) {
      // The page already said what went wrong: add the buttons if missing.
      if (!box.querySelector('.bx-share')) fatal(null);
      return;
    }
    fatal(`Bedrock could not start. If it was just updated, part of the old version may still be loaded: reload the page. (${scrub(messageOf(err), MAX_MESSAGE)})`);
  }

  window.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
      // A file of the page did not load (offline, or an update in between).
      caught('error', `could not load ${scrub(t.src || t.href, 200)}`);
      return;
    }
    if (t && t !== window) return; // a picture in a note, not our business
    caught('error', e.error ?? e.message, e.error?.stack);
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    caught('rejection', e.reason, e.reason?.stack);
  });

  window.bedrockErrors = {
    /** A copy of the log, oldest first. */
    entries: () => entries.map((e) => ({ ...e })),
    record,
    /** An error the app caught and told the person about itself: logged,
     *  no extra notice. */
    shown: (message, err) => record('shown', message, { stack: err?.stack }),
    /** From the Rust panic hook (`bedrock-web`). */
    panic: (message) => record('panic', message, { stack: '' }),
    /** A worker that failed. */
    worker: (name, e) => caught('worker', `${name}: ${messageOf(e?.error ?? e?.message ?? e)}`, e?.error?.stack),
    fatal,
    open,
    clear() { entries.length = 0; save(); },
    scrub: (text) => scrub(text, Infinity),
  };
})();
