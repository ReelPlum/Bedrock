// Consent to send handwriting to Bedrock's training data backend, and the
// launch gate: while Bedrock is invite-only
// (`collect.LAUNCH_GATE`), the app and the Obsidian plugin ask for the
// invite code and this consent as soon as they start, and cannot be used
// until both are given. What is sent, and why, is on the website's /terms
// page (terms/index.html); the gate and /train link to it.
//
// Agreeing stores the code and consent version (collect.js) and turns on
// "Send every word I write in notes" (settings `shareWords`), because the
// text says every word is sent.

import * as collect from './collect.js';

const SETTINGS_KEY = 'bedrock.settings.v1';

/** Where the terms (what is sent, and why) are read: the website's
 *  /terms page. Inside a host (the Obsidian plugin) the link opens the
 *  public website, since the app's own files there are not a web page. */
export const SITE = 'https://reelplum.github.io/Bedrock/';
export function termsUrl(loc = globalThis.location) {
  const inHost = new URLSearchParams(loc?.search || '').has('host');
  return inHost ? `${SITE}terms/` : new URL('../terms/', import.meta.url).href;
}

/** The line by the tick box, here and on /train. Agreeing to it is
 *  consent version 3 (`collect.CONSENT_VERSION`). */
export function agreeHtml() {
  return `I agree to the <a href="${termsUrl()}" target="_blank" rel="noopener">Terms of Service</a>`;
}

/** Turns on "Send every word I write in notes" in the stored settings,
 *  from now on. Returns `{ shareWords, shareWordsSince }`. */
export function turnOnSharing(storage = globalThis.localStorage, now = Date.now()) {
  let s = {};
  try { s = JSON.parse(storage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (_) { /* private mode or damaged */ }
  const on = { shareWords: true, shareWordsSince: s.shareWords === true && Number.isFinite(s.shareWordsSince) ? s.shareWordsSince : now };
  try { storage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, ...on })); } catch (_) { /* private mode */ }
  return on;
}

/** Agree to the consent text with this code: stores both, and turns on
 *  sending every word when the launch gate is on. */
export function accept({ code, handedness }, storage = globalThis.localStorage) {
  // The setting first: other windows act on the consent being stored, and
  // read the setting then.
  const sharing = collect.gateRequired(collect.loadState(storage)) ? turnOnSharing(storage) : null;
  const state = collect.agree({ code, handedness }, storage);
  return { state, sharing };
}

const gateHtml = () => `
<form class="gate-card" method="dialog" novalidate>
  <h2 id="gate-title">Welcome to Bedrock</h2>
  <p class="gate-lead">Bedrock is invite-only for now. Enter your invite code, and agree that your handwriting is sent to Bedrock to train its recognition.</p>
  <label class="gate-field">Invite code
    <input id="gate-code" autofocus autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="bedrock-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx">
  </label>
  <label class="gate-field">Writing hand (optional)
    <select id="gate-hand">
      <option value="">Rather not say</option>
      <option value="right">Right</option>
      <option value="left">Left</option>
    </select>
  </label>
  <label class="gate-agree"><input type="checkbox" id="gate-agree"> <span>${agreeHtml()}</span></label>
  <p class="gate-error" id="gate-error" role="alert" hidden></p>
  <button type="submit" class="gate-go" id="gate-go">Agree and start</button>
</form>`;

/**
 * Shows the launch gate as a modal dialog over everything in `doc`, unless
 * it is not needed. Resolves when the person has agreed (or another page
 * on this device agreed), with what `accept` returned, or null.
 * `onAccepted` is called first, so the app can update its settings.
 */
export function showGate({ doc = document, onAccepted = () => {}, check = collect.checkCode } = {}) {
  if (!collect.gateNeeded()) return null;
  const existing = doc.getElementById('launch-gate');
  if (existing) return existing.done;
  const dialog = doc.createElement('dialog');
  dialog.id = 'launch-gate';
  dialog.className = 'launch-gate';
  dialog.setAttribute('aria-labelledby', 'gate-title');
  dialog.innerHTML = gateHtml();
  doc.body.append(dialog);
  const $ = (id) => dialog.querySelector(`#${id}`);
  const s = collect.loadState();
  $('gate-code').value = s.code;
  $('gate-hand').value = s.handedness || '';
  const fail = (text) => { $('gate-error').textContent = text; $('gate-error').hidden = !text; };
  if (s.problem === 'code' && s.code) fail('Your invite code was not accepted. Check it and try again.');

  let finish;
  dialog.done = new Promise((r) => { finish = r; });
  const close = (result) => {
    win.removeEventListener('storage', onStorage);
    dialog.close();
    dialog.remove();
    finish(result);
  };
  // It cannot be closed without agreeing.
  dialog.addEventListener('cancel', (e) => e.preventDefault());
  const win = doc.defaultView;
  // Agreed in another window of this app (another Obsidian note, a tab).
  const onStorage = (e) => {
    if (e.key !== null && e.key !== 'bedrock.collect.v1') return;
    if (collect.gateNeeded()) return;
    onAccepted(null);
    close(null);
  };
  win.addEventListener('storage', onStorage);

  dialog.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('gate-code').value.trim();
    if (!$('gate-agree').checked) return fail('Tick the box to agree to the Terms of Service. Bedrock cannot be used without it for now.');
    if (!code) return fail('Enter your invite code.');
    fail('');
    $('gate-go').disabled = true;
    $('gate-go').textContent = 'Checking the code…';
    const answer = await check(code);
    $('gate-go').disabled = false;
    $('gate-go').textContent = 'Agree and start';
    if (answer === 'wrong') return fail('That invite code was not accepted. Check it and try again.');
    if (answer === 'server') return fail('The server could not check your code just now. Try again in a moment.');
    // `offline`: kept, and checked when samples are next sent; a code the
    // server turns down then brings the gate back.
    const result = accept({ code, handedness: $('gate-hand').value });
    if (answer === 'offline') collect.saveState({ problem: 'offline' });
    onAccepted(result);
    close(result);
    collect.flush().catch(() => {});
  });

  dialog.showModal();
  return dialog.done;
}

/** Styles for the gate, added once per page. Kept here so the app, the
 *  Obsidian welcome page and /train share them. */
export function gateStyles(doc = document) {
  if (doc.getElementById('launch-gate-style')) return;
  const style = doc.createElement('style');
  style.id = 'launch-gate-style';
  style.textContent = `
.launch-gate { border: 0; padding: 0; border-radius: 14px; max-width: min(560px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); background: #fbfaf6; color: #1c1c1e; box-shadow: 0 12px 48px rgba(0,0,0,.25); font: 15px/1.45 system-ui, -apple-system, sans-serif; }
.launch-gate::backdrop { background: rgba(28,28,30,.55); }
.gate-card { display: flex; flex-direction: column; gap: 12px; padding: 20px; }
.gate-card h2 { margin: 0; font-size: 20px; }
.gate-lead { margin: 0; }
.gate-agree a { color: #2f6bff; }
.gate-field { display: flex; flex-direction: column; gap: 4px; font-weight: 600; }
.gate-field input, .gate-field select { font: inherit; font-weight: 400; padding: 8px 10px; border: 1px solid #cfc9bb; border-radius: 8px; background: #fff; color: inherit; }
.gate-agree { display: flex; gap: 8px; align-items: flex-start; }
.gate-error { margin: 0; color: #b3261e; }
.gate-go { font: inherit; font-weight: 600; padding: 10px 14px; border: 0; border-radius: 10px; background: #2f6bff; color: #fff; }
.gate-go:disabled { opacity: .6; }
@media (prefers-color-scheme: dark) {
  .launch-gate { background: #1f1f22; color: #eee; }
  .gate-field input, .gate-field select { background: #2a2a2e; border-color: #444; color: #eee; }
  .gate-error { color: #ff8a80; }
}`;
  doc.head.append(style);
}
