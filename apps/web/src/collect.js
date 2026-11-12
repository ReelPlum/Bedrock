// Sending handwriting samples to Bedrock's training data backend.
//
// Nothing leaves the device unless the person has agreed (the consent screen
// on /train) and entered an invite code. Samples wait in a queue in
// IndexedDB and are sent a few at a time; a sample is only removed from the
// queue when the server says it has it, or says it will never take it. So
// writing offline works, and a lost connection loses nothing.
//
// The wire format is `bedrock-training` version 2; the backend's checks are
// the reference (collect-core/src/sample.rs in the backend repository).

export const CONSENT_VERSION = 1;
/** The backend's address. Empty until the backend is deployed; it can also
 *  be set on the /train page. */
export const DEFAULT_API = '';
const STATE_KEY = 'bedrock.collect.v1';
const DB_NAME = 'bedrock-collect';
const STORE = 'queue';
/** Small batches keep each request well inside the server's time limit. */
export const BATCH = 5;
/** And at most about this much JSON per request: the server takes 512 KB,
 *  and a written paragraph can be a few hundred KB on its own. */
export const BATCH_BYTES = 400_000;

/** The first samples of `queued` that fit in one request (always one). */
export function fitBatch(queued, maxBytes = BATCH_BYTES) {
  let bytes = 0;
  const out = [];
  for (const s of queued) {
    bytes += JSON.stringify(s).length;
    if (out.length && bytes > maxBytes) break;
    out.push(s);
  }
  return out;
}
/** Waiting samples are sent at most this often, so the device's radio and
 *  the server are woken once a minute, not for every word. They are also
 *  sent at once when the page is hidden or closed (an iPad may freeze a
 *  hidden page before the minute is up), and when a page opens. */
export const SEND_EVERY_MS = 60_000;
const RETRY_MS = [15_000, 60_000, 300_000, 900_000];

// ---- State ---------------------------------------------------------------

/** `{ api, code, contributor, consent, handedness, sent, problem }`. */
export function loadState(storage = globalThis.localStorage) {
  let s = {};
  try { s = JSON.parse(storage.getItem(STATE_KEY) || '{}') || {}; } catch (_) { /* private mode */ }
  return {
    api: typeof s.api === 'string' ? s.api : DEFAULT_API,
    code: typeof s.code === 'string' ? s.code : '',
    contributor: isUuid(s.contributor) ? s.contributor : '',
    consent: Number.isInteger(s.consent) ? s.consent : 0,
    handedness: s.handedness === 'left' || s.handedness === 'right' ? s.handedness : null,
    sent: Number.isInteger(s.sent) ? s.sent : 0,
    problem: typeof s.problem === 'string' ? s.problem : '',
  };
}

export function saveState(patch, storage = globalThis.localStorage) {
  const next = { ...loadState(storage), ...patch };
  try { storage.setItem(STATE_KEY, JSON.stringify(next)); } catch (_) { /* private mode */ }
  return next;
}

/** True when samples may be sent: agreed, has a code, knows the server. */
export function isReady(s = loadState()) {
  return s.consent === CONSENT_VERSION && !!s.code && isSafeApi(s.api) && isUuid(s.contributor);
}

/** The server must be https (or this computer, for development), so the
 *  code and the ink are never sent in the clear. */
export function isSafeApi(api) {
  return /^https:\/\/[^\s/]+/.test(api || '') || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(api || '');
}

/** Agree to the consent text and store the code. Makes the random
 *  contributor id the first time. */
export function agree({ code, api, handedness }, storage = globalThis.localStorage) {
  const s = loadState(storage);
  return saveState({
    code: String(code || '').trim(),
    api: String(api ?? s.api).trim().replace(/\/+$/, ''),
    handedness: handedness === 'left' || handedness === 'right' ? handedness : null,
    consent: CONSENT_VERSION,
    contributor: s.contributor || uuidv4(),
    problem: '',
  }, storage);
}

// ---- Ids -------------------------------------------------------------------

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const dashed = (h) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
}

/** A random id for a contributor: says nothing about the person or device. */
export function uuidv4(bytes = randomBytes(16)) {
  const b = Uint8Array.from(bytes);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return dashed(hex(b));
}

/** A time-ordered id for a sample (UUID version 7). */
export function uuidv7(now = Date.now(), bytes = randomBytes(10)) {
  const b = new Uint8Array(16);
  let t = Math.floor(now);
  for (let i = 5; i >= 0; i--) { b[i] = t % 256; t = Math.floor(t / 256); }
  b.set(bytes.slice(0, 10), 6);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  return dashed(hex(b));
}

// ---- Samples ---------------------------------------------------------------

/** A coarse device class. Deliberately not the full user agent. */
export function deviceClass(ua = globalThis.navigator?.userAgent || '', touchPoints = globalThis.navigator?.maxTouchPoints || 0) {
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ipad';
  if (/iPhone/.test(ua)) return 'iphone';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh/.test(ua)) return 'mac';
  if (/Linux|CrOS/.test(ua)) return 'linux';
  return 'other';
}

/** The pointer most strokes were made with. */
function pointerOf(strokes) {
  const n = { pen: 0, mouse: 0, touch: 0 };
  for (const s of strokes) if (s.device in n) n[s.device] += 1;
  return Object.keys(n).sort((a, b) => n[b] - n[a])[0];
}

const APP_VERSION = '0.1.0';

/** The backend takes short plain tags only (letters, digits, space . _ - / +). */
export function shortTag(text, max) {
  return String(text).normalize('NFKD').replace(/[^A-Za-z0-9 ._\-/+]/g, '-').slice(0, max) || 'unknown';
}

function sample({ source, kind, label, labelSource, language, strokes, channels, written, box, reading, engine, supersedes = [] }) {
  return {
    format: 'bedrock-training',
    version: 2,
    id: uuidv7(),
    source,
    kind,
    label: String(label).normalize('NFC').trim(),
    label_source: labelSource,
    ...(reading ? { model_reading: String(reading).normalize('NFC'), ...(engine ? { model_engine: shortTag(engine, 80) } : {}) } : {}),
    language,
    device: deviceClass(),
    pointer: pointerOf(strokes),
    written: Math.round(written ?? Date.now()),
    app_version: APP_VERSION,
    ...(box ? { box } : {}),
    // Earlier samples of the same ink that this one replaces.
    ...(supersedes.length ? { supersedes } : {}),
    channels,
    // Only what a recogniser needs: no brush, colour or stroke id.
    strokes: strokes.map((s) => ({ start: s.start, points: s.points })),
  };
}

/**
 * A sample from the training pages. `note` is the box's ink as note JSON
 * (`canvas.export_json()`), `prompt` is `{ kind: 'text'|'math'|'scribble', text, latex }`.
 */
export function fromTraining({ prompt, note, box, written }) {
  const maths = prompt.kind === 'math';
  return sample({
    source: 'train',
    kind: prompt.kind,
    // For a formula the label is its LaTeX; for a scribble, the word that
    // was scribbled out.
    label: maths ? prompt.latex : prompt.text,
    labelSource: 'prompt',
    language: maths ? 'zxx' : 'en',
    strokes: note.strokes,
    channels: note.channels,
    written,
    box,
  });
}

/**
 * A sample from a real note: one word, checked by the writer or not
 * (`labelSource`: unchecked | confirmed | corrected).
 * The ink is moved so its top left corner is at 0,0: where on the page it
 * was written says something about the note, and nobody needs to know.
 */
export function fromNote({ strokes, channels, label, labelSource, kind = 'text', language = 'en', reading, engine, supersedes }) {
  const n = channels.length;
  const ix = channels.indexOf('x');
  const iy = channels.indexOf('y');
  let minX = Infinity;
  let minY = Infinity;
  for (const s of strokes) {
    for (let i = 0; i < s.points.length; i += n) {
      minX = Math.min(minX, s.points[i + ix]);
      minY = Math.min(minY, s.points[i + iy]);
    }
  }
  const moved = strokes.map((s) => {
    const points = s.points.slice();
    for (let i = 0; i < points.length; i += n) {
      points[i + ix] = Math.round((points[i + ix] - minX) * 100) / 100;
      points[i + iy] = Math.round((points[i + iy] - minY) * 100) / 100;
    }
    return { ...s, points };
  });
  return sample({ source: 'note', kind, label, labelSource, language, strokes: moved, channels, reading, engine, supersedes, written: Math.max(...strokes.map((s) => s.start)) });
}

// ---- The queue (IndexedDB) -------------------------------------------------

let dbPromise = null;
function db() {
  dbPromise ||= new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: 'id' });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return dbPromise;
}

async function tx(mode, run) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const queue = {
  put: (s) => tx('readwrite', (st) => st.put(s)),
  first: (n) => tx('readonly', (st) => st.getAll(null, n)),
  remove: (ids) => tx('readwrite', (st) => { for (const id of ids) st.delete(id); }),
  count: () => tx('readonly', (st) => st.count()),
  clear: () => tx('readwrite', (st) => st.clear()),
};

// ---- Sending ---------------------------------------------------------------

let flushing = null;
let retryTimer = null;
let retries = 0;
const listeners = new Set();

/** Calls `fn({ waiting, sent, problem })` whenever the queue changes. */
export function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function status() {
  const s = loadState();
  let waiting = 0;
  try { waiting = await queue.count(); } catch (_) { /* no IndexedDB */ }
  return { waiting, sent: s.sent, problem: s.problem, ready: isReady(s) };
}

async function announce() {
  const st = await status();
  for (const fn of listeners) fn(st);
}

function headers(s, json = true) {
  return { Authorization: `Bearer ${s.code}`, 'X-Contributor': s.contributor, ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

function contributor(s) {
  const locale = globalThis.navigator?.language;
  return {
    id: s.contributor,
    consent_version: s.consent,
    ...(s.handedness ? { handedness: s.handedness } : {}),
    ...(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale || '') ? { locale } : {}),
  };
}

/** Sends one batch. Returns the ids to take off the queue, or throws
 *  `{ later: true }` when it should be tried again later. */
async function send(s, batch) {
  let res;
  try {
    res = await fetch(`${s.api}/v1/samples`, { method: 'POST', headers: headers(s), body: JSON.stringify({ contributor: contributor(s), samples: batch }) });
  } catch (_) {
    throw { later: true, problem: 'offline' };
  }
  if (res.status === 401) throw { later: true, problem: 'code', stop: true };
  if (res.status === 400 || res.status === 413) {
    // The request as a whole was refused. One sample at a time finds the
    // one at fault; a single sample that is refused is dropped.
    if (batch.length === 1) return { done: [batch[0].id], stored: 0 };
    let done = [];
    let stored = 0;
    for (const one of batch) {
      const r = await send(s, [one]);
      done = done.concat(r.done);
      stored += r.stored;
    }
    return { done, stored };
  }
  if (!res.ok) throw { later: true, problem: res.status === 429 ? 'limit' : 'server' };
  const v = await res.json();
  const accepted = Array.isArray(v.accepted) ? v.accepted : [];
  // Refused for good (it will never pass the checks): drop it. Refused
  // because storage failed: keep it and try again.
  const dropped = (Array.isArray(v.refused) ? v.refused : []).filter((r) => r.code !== 'storage' && r.id).map((r) => r.id);
  return { done: accepted.concat(dropped), stored: accepted.length };
}

/** Sends what is waiting. Safe to call at any time; only one runs at once. */
export function flush() {
  flushing ||= (async () => {
    try {
      for (;;) {
        const s = loadState();
        if (!isReady(s)) return;
        const batch = fitBatch(await queue.first(BATCH));
        if (!batch.length) break;
        const { done, stored } = await send(s, batch);
        await queue.remove(done);
        saveState({ sent: loadState().sent + stored, problem: '' });
        retries = 0;
        if (!done.length) throw { later: true, problem: 'server' };
        await announce();
      }
    } catch (e) {
      if (!e?.later) throw e;
      saveState({ problem: e.problem });
      if (!e.stop) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(flush, RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)]);
      }
    } finally {
      flushing = null;
      await announce();
    }
  })();
  return flushing;
}

let sendEvery = SEND_EVERY_MS;
let sendTimer = null;

/** How often waiting samples are sent (tests make it short). */
export function setSendInterval(ms) {
  sendEvery = ms;
}

function sendSoon() {
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    flush().catch(() => {});
  }, sendEvery);
}

/** Keeps a sample; it is sent with the next batch, within a minute.
 *  Resolves when it is safely queued. */
export async function enqueue(s) {
  await queue.put(s);
  await announce();
  sendSoon();
}

/** Deletes everything this contributor sent, and what is still waiting. */
export async function deleteMine() {
  const s = loadState();
  await queue.clear();
  let deleted = 0;
  // Works after "Stop saving" too: deleting never needs consent.
  if (s.code && isSafeApi(s.api) && isUuid(s.contributor)) {
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${s.api}/v1/contributors/me`, { method: 'DELETE', headers: headers(s, false) });
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      const v = await res.json();
      deleted += (v.deleted?.samples || 0) + (v.deleted?.paragraphs || 0);
      if (!v.more) break;
    }
  }
  saveState({ sent: 0, problem: '' });
  // Which note words were sent (share-words.js): nothing is left to replace.
  try { globalThis.localStorage?.removeItem('bedrock.sharedWords.v1'); } catch (_) { /* private mode */ }
  await announce();
  return deleted;
}

/** The server's totals and this contributor's own count, or null. */
export async function serverStats() {
  const s = loadState();
  if (!isReady(s)) return null;
  try {
    const res = await fetch(`${s.api}/v1/stats`, { headers: headers(s, false) });
    return res.ok ? await res.json() : null;
  } catch (_) {
    return null;
  }
}

/** The training prompts set from the backend (`{ words, sentences,
 *  paragraphs }`), or null when saving is off or the server cannot be
 *  reached. */
export async function serverPrompts() {
  const s = loadState();
  if (!isReady(s)) return null;
  try {
    const res = await fetch(`${s.api}/v1/prompts`, { headers: headers(s, false) });
    return res.ok ? await res.json() : null;
  } catch (_) {
    return null;
  }
}

/** What to tell the person about a problem, in plain words. */
export function problemText(problem) {
  return {
    offline: 'No connection. Your samples are kept here and sent later.',
    code: 'The invite code was not accepted. Check it on the Train page.',
    limit: 'The server has had enough for today. Your samples are kept here and sent tomorrow.',
    server: 'The server could not take samples just now. They are kept here and sent later.',
  }[problem] || '';
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { retries = 0; flush().catch(() => {}); });
  // Hidden or closed: send now, before the page may be frozen.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush().catch(() => {}); });
  window.addEventListener('pagehide', () => { flush().catch(() => {}); });
}
