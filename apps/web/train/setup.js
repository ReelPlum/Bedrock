// The "Saving your samples" card on /train: consent, invite code, and
// "Delete my contributions".
import * as collect from '../src/collect.js';
import { CONSENT_HTML, accept } from '../src/consent.js';

const $ = (id) => document.getElementById(id);
$('consent-text').innerHTML = CONSENT_HTML;

async function show() {
  const s = collect.loadState();
  const st = await collect.status();
  const on = st.ready;
  // No server built into the app yet: nothing can be saved.
  const missing = !collect.isSafeApi(s.api);
  $('save').disabled = missing;
  if (missing) {
    $('state').className = 'state';
    $('state').textContent = 'Saving is not available yet: the server is still being set up. The pages work for practice.';
    $('stop').hidden = true;
    $('delete').hidden = true;
    return;
  }
  $('code').value = s.code;
  $('handedness').value = s.handedness || '';
  $('agree').checked = on;
  $('stop').hidden = !on;
  $('delete').hidden = !s.contributor;
  $('save').textContent = on ? 'Save changes' : 'Agree and start saving';
  const state = $('state');
  state.className = `state ${on ? (st.problem ? 'warn' : 'on') : ''}`;
  if (!on) state.textContent = 'Off. Until you agree below, the pages are practice only and nothing is saved.';
  else state.textContent = collect.problemText(st.problem) || `On. ${st.sent} sent${st.waiting ? `, ${st.waiting} waiting to send` : ''}.`;
}

function fail(text) {
  $('setup-error').textContent = text;
  $('setup-error').hidden = !text;
}

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('code').value.trim();
  if (!collect.isSafeApi(collect.loadState().api)) return;
  if (!$('agree').checked) return fail('Tick the box to agree, or leave saving off.');
  if (!code) return fail('Enter your invite code.');
  fail('');
  accept({ code, handedness: $('handedness').value });
  await collect.flush().catch(() => {});
  await show();
});

$('stop').addEventListener('click', async () => {
  // Withdraws consent on this device. What was sent stays until deleted.
  collect.saveState({ consent: 0 });
  await show();
});

$('delete').addEventListener('click', async () => {
  if (!confirm('Delete everything you have sent, and everything waiting to be sent? This cannot be undone.')) return;
  try {
    const n = await collect.deleteMine();
    collect.saveState({ consent: 0 });
    fail('');
    await show();
    $('state').textContent = `Deleted ${n} samples. Saving is off.`;
  } catch (err) {
    fail(`Could not delete: ${err.message} Try again when you are online.`);
  }
});

collect.onStatus(show);
show();
collect.flush().catch(() => {});
window.setup = { ready: true };
