// The "Saving your samples" card on /train: consent, invite code, and
// "Delete my contributions".
import * as collect from '../src/collect.js';

const $ = (id) => document.getElementById(id);

async function show() {
  const s = collect.loadState();
  const st = await collect.status();
  const on = st.ready;
  $('code').value = s.code;
  $('api').value = s.api;
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
  const api = $('api').value.trim().replace(/\/+$/, '');
  if (!$('agree').checked) return fail('Tick the box to agree, or leave saving off.');
  if (!code) return fail('Enter your invite code.');
  if (!collect.isSafeApi(api)) return fail('Enter the server address under "Server address". It starts with https://');
  fail('');
  collect.agree({ code, api, handedness: $('handedness').value });
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
