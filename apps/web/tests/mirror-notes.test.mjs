// Note mirrors (mirror-notes.js): what is sent when the writer writes,
// erases, moves strokes and deletes notes, and that notes already in the
// library are sent in full. A pretend backend applies the uploads the way
// the real one does (collect-core/src/api.rs in Bedrock-Backend), so each
// test can check the cloud copy ends exactly as the note is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NoteMirrors, plan, fitRequest, MAX_ERASE, MAX_ADD_STROKES } from '../src/mirror-notes.js';

const CHANNELS = ['x', 'y', 'pressure', 'altitude', 'azimuth', 't'];
const T0 = 1_800_000_000_000;
let n = 0;
const uuid = () => `019a3b5c-7d2e-7abc-8def-${(++n).toString(16).padStart(12, '0')}`;
const sid = (i) => i.toString(16).padStart(16, '0');
const stroke = (i, size = 2) => ({ id: sid(i), start: T0 + i, points: Array.from({ length: size * 6 }, (_, k) => (k % 6 === 5 ? k : 1 + i)) });

/** A pretend note: its strokes, and its ink as `note_ink_json` gives it. */
function note(...ids) {
  const strokes = new Map(ids.map((i) => [sid(i), stroke(i)]));
  return {
    strokes,
    write(...more) { for (const i of more) strokes.set(sid(i), stroke(i)); },
    erase(...gone) { for (const i of gone) strokes.delete(sid(i)); },
    ink: () => ({ channels: CHANNELS, strokes: [...strokes.values()] }),
    // The open canvas: ids, and one stroke's ink when asked.
    canvas() { const asked = []; return { asked, ink: { channels: CHANNELS, ids: [...strokes.keys()], stroke: (id) => { asked.push(id); return strokes.get(id); } } }; },
  };
}

/** The backend's rules for uploads, in memory. */
function backend() {
  const mirrors = new Map(); // mirror id -> { strokes: Map, erased: Set }
  const requests = [];
  return {
    mirrors,
    requests,
    send: async (uploads) => {
      requests.push(uploads);
      assert.ok(uploads.length <= 5);
      assert.ok(uploads.reduce((a, u) => a + u.erase.length, 0) <= MAX_ERASE);
      for (const u of uploads) {
        assert.equal(u.format, 'bedrock-note-mirror');
        assert.ok(!('title' in u) && !('texts' in u), 'ink only');
        if (u.deleted) { mirrors.delete(u.note); continue; }
        const m = mirrors.get(u.note) || { strokes: new Map(), erased: new Set() };
        mirrors.set(u.note, m);
        for (const s of u.add) if (!m.erased.has(s.id) && !u.erase.includes(s.id)) m.strokes.set(s.id, s);
        for (const id of u.erase) { m.strokes.delete(id); m.erased.add(id); }
      }
      return { done: uploads.map((u) => u.id) };
    },
  };
}

function memory() {
  const notes = new Map();
  const q = new Map();
  return {
    notes,
    q,
    store: {
      get: async (k) => notes.get(k),
      put: async (r) => { notes.set(r.note, structuredClone(r)); },
      remove: async (k) => { notes.delete(k); },
      all: async () => [...notes.values()],
      clear: async () => notes.clear(),
    },
    queue: {
      put: async (us) => { for (const u of us) q.set(u.id, u); },
      first: async (k) => [...q.values()].slice(0, k),
      remove: async (ids) => { for (const id of ids) q.delete(id); },
      clear: async () => q.clear(),
      count: async () => q.size,
    },
  };
}

function setup({ enabled = true } = {}) {
  const mem = memory();
  const server = backend();
  const on = { value: enabled };
  const m = new NoteMirrors({ store: mem.store, queue: mem.queue, enabled: () => on.value, send: server.send, now: () => T0 + 1_000_000, uuid });
  m.sendSoon = () => {}; // the tests send when they choose
  const cloud = (local) => {
    const mirror = mem.notes.get(local)?.mirror;
    return [...(server.mirrors.get(mirror)?.strokes.values() || [])].map((s) => s.id).sort();
  };
  return { m, mem, server, on, cloud };
}

const ids = (...is) => is.map(sid).sort();

test('writing is sent once, and the cloud copy holds exactly the note', async () => {
  const { m, mem, server, cloud } = setup();
  const a = note(1, 2, 3);
  assert.equal(await m.sync('a', a.ink()), 1);
  await m.flush();
  assert.deepEqual(cloud('a'), ids(1, 2, 3));
  const up = server.requests[0][0];
  assert.deepEqual(up.channels, CHANNELS);
  assert.deepEqual(up.add[0], stroke(1), 'every raw sample, as the note holds it');
  assert.equal(await m.sync('a', a.ink()), 0, 'nothing changed: nothing sent');
  a.write(4, 5);
  assert.equal(await m.sync('a', a.ink()), 1);
  await m.flush();
  assert.deepEqual(server.requests[1][0].add.map((s) => s.id), [sid(4), sid(5)], 'only what is new');
  assert.deepEqual(cloud('a'), ids(1, 2, 3, 4, 5));
  assert.equal(mem.q.size, 0);
});

test('erasing is sent, and the cloud copy loses the erased ink', async () => {
  const { m, server, cloud } = setup();
  const a = note(1, 2, 3, 4);
  await m.sync('a', a.ink());
  await m.flush();
  a.erase(2, 4);
  await m.sync('a', a.ink());
  await m.flush();
  const up = server.requests.at(-1)[0];
  assert.deepEqual([up.add, up.erase.sort()], [[], ids(2, 4)]);
  assert.deepEqual(cloud('a'), ids(1, 3));
});

// Bug: undoing an erase brings the stroke back with the same id, and the
// backend never stores an erased stroke id again, so the cloud copy missed
// the stroke the note had.
test('bug: undoing an erase writes the stroke back in the cloud copy', async () => {
  for (const open of [false, true]) {
    const { m, server, mem } = setup();
    const a = note(1, 2);
    const sync = () => m.sync('a', open ? a.canvas().ink : a.ink());
    const cloudInk = () => [...server.mirrors.get(mem.notes.get('a').mirror).strokes.values()].map((s) => s.points).sort();
    await sync();
    await m.flush();
    a.erase(2);
    await sync();
    await m.flush();
    assert.deepEqual(cloudInk(), [stroke(1).points]);
    a.write(2); // undo: the same stroke, the same id
    await sync();
    await m.flush();
    assert.deepEqual(cloudInk(), [stroke(1).points, stroke(2).points].sort(), `the stroke is back (open: ${open})`);
    const back = server.requests.at(-1)[0].add[0];
    assert.match(back.id, /^[0-9a-f]{16}$/, 'a stroke id the backend takes');
    assert.notEqual(back.id, sid(2), 'sent under a new id, as the erased one is never stored again');
    assert.equal(await sync(), 0, 'and sent once');
    // Erased again (and undone again), the cloud copy follows each time.
    a.erase(2);
    await sync();
    await m.flush();
    assert.deepEqual(cloudInk(), [stroke(1).points]);
    a.write(2);
    await sync();
    await m.flush();
    assert.deepEqual(cloudInk(), [stroke(1).points, stroke(2).points].sort());
  }
});

test('partly erasing a stroke sends its pieces and erases the original', async () => {
  // The partial eraser cuts a stroke into new strokes with new ids.
  const { m, cloud } = setup();
  const a = note(1, 2);
  await m.sync('a', a.ink());
  a.erase(2);
  a.write(20, 21);
  await m.sync('a', a.ink());
  await m.flush();
  assert.deepEqual(cloud('a'), ids(1, 20, 21));
});

test('moving strokes sends them as erased and written again', async () => {
  // Moved strokes get new ids in the note format.
  const { m, cloud } = setup();
  const a = note(1, 2, 3);
  await m.sync('a', a.ink());
  await m.flush();
  a.erase(2, 3);
  a.write(7, 8);
  await m.sync('a', a.ink());
  await m.flush();
  assert.deepEqual(cloud('a'), ids(1, 7, 8));
});

test('writing and erasing before anything is sent ends the same', async () => {
  const { m, cloud, server } = setup();
  const a = note(1, 2);
  await m.sync('a', a.ink());
  a.erase(1);
  a.write(3);
  await m.sync('a', a.ink());
  a.erase(3);
  await m.sync('a', a.ink());
  await m.flush();
  assert.deepEqual(cloud('a'), ids(2));
  // Even if the uploads arrive in another order.
  const all = server.requests.flat();
  const other = backend();
  await other.send([...all].reverse().filter((u) => u.erase.length));
  await other.send(all.filter((u) => !u.erase.length));
  assert.deepEqual([...other.mirrors.values()][0].strokes.size, 1);
});

test('the open note reads only new strokes from the canvas', async () => {
  const { m, cloud } = setup();
  const a = note(1, 2);
  let c = a.canvas();
  await m.sync('a', c.ink);
  assert.deepEqual(c.asked, [sid(1), sid(2)]);
  a.write(3);
  a.erase(1);
  c = a.canvas();
  await m.sync('a', c.ink);
  assert.deepEqual(c.asked, [sid(3)], 'the rest is known by id');
  await m.flush();
  assert.deepEqual(cloud('a'), ids(2, 3));
});

test('a large note is sent in uploads the backend takes', async () => {
  const big = note(...Array.from({ length: 2000 }, (_, i) => i + 1));
  const ups = plan({ mirror: 'm', channels: CHANNELS, strokes: big.ink().strokes, sent: [], uuid });
  assert.ok(ups.every((u) => u.add.length <= MAX_ADD_STROKES));
  assert.equal(ups.reduce((a, u) => a + u.add.length, 0), 2000);
  const erased = plan({ mirror: 'm', channels: CHANNELS, strokes: [], sent: Array.from({ length: 40 }, (_, i) => sid(i)), uuid });
  assert.deepEqual(erased.map((u) => u.erase.length), [16, 16, 8]);
  // A request holds at most 16 erased strokes and 5 uploads.
  assert.equal(fitRequest(erased).length, 1);
  assert.equal(fitRequest(Array.from({ length: 9 }, () => ({ add: [], erase: [] }))).length, 5);
  const { m, cloud } = setup();
  await m.sync('big', big.ink());
  await m.flush();
  assert.equal(cloud('big').length, 2000);
});

test('notes already in the library are sent in full, once, and changed ones again', async () => {
  const { m, cloud } = setup();
  const lib = { a: note(1, 2), b: note(3), c: note(4, 5, 6) };
  const reads = [];
  const inkOf = async (id) => { reads.push(id); return lib[id].ink(); };
  const list = (mod = {}) => Object.keys(lib).map((id) => ({ id, modified: mod[id] || 1 }));
  // The open note (c) is synced from the canvas, not from its file.
  assert.equal(await m.library(list(), inkOf, 'c'), 2);
  await m.flush();
  assert.deepEqual([cloud('a'), cloud('b'), cloud('c')], [ids(1, 2), ids(3), []]);
  // Unchanged notes are not read again.
  reads.length = 0;
  assert.equal(await m.library(list(), inkOf), 1, 'only c, not mirrored yet');
  assert.deepEqual(reads, ['c']);
  // A note changed elsewhere (another device, iCloud) is read again.
  lib.b.write(9);
  lib.b.erase(3);
  assert.equal(await m.library(list({ b: 2 }), inkOf), 1);
  await m.flush();
  assert.deepEqual(cloud('b'), ids(9));
});

test('a note deleted from the library deletes its mirror', async () => {
  const { m, mem, server, cloud } = setup();
  const lib = { a: note(1), b: note(2) };
  await m.library(Object.keys(lib).map((id) => ({ id, modified: 1 })), async (id) => lib[id].ink());
  await m.flush();
  const mirrorB = mem.notes.get('b').mirror;
  await m.library([{ id: 'a', modified: 1 }], async (id) => lib[id].ink());
  await m.flush();
  assert.ok(!server.mirrors.has(mirrorB));
  assert.ok(!mem.notes.has('b'));
  assert.deepEqual(cloud('a'), ids(1));
});

test('nothing is kept or sent while mirroring is off, and turning it on catches up', async () => {
  const { m, on, mem, server, cloud } = setup({ enabled: false });
  const a = note(1, 2);
  assert.equal(await m.sync('a', a.ink()), 0);
  assert.equal(await m.library([{ id: 'a', modified: 1 }], async () => a.ink()), 0);
  await m.flush();
  assert.equal(server.requests.length + mem.q.size + mem.notes.size, 0);
  on.value = true;
  a.erase(1);
  await m.library([{ id: 'a', modified: 1 }], async () => a.ink());
  await m.flush();
  assert.deepEqual(cloud('a'), ids(2));
});

test('uploads wait while offline and are sent later', async () => {
  const { m, mem, cloud } = setup();
  let online = false;
  const real = m.send;
  m.send = async (u) => { if (!online) throw { later: true }; return real(u); };
  m.retryTimer = null;
  await m.sync('a', note(1, 2).ink());
  await m.flush();
  clearTimeout(m.retryTimer);
  assert.equal(mem.q.size, 1, 'kept');
  online = true;
  await m.flush();
  assert.equal(mem.q.size, 0);
  assert.deepEqual(cloud('a'), ids(1, 2));
});

test('forgetting (after "Delete my contributions") starts afresh', async () => {
  const { m, mem } = setup();
  await m.sync('a', note(1).ink());
  await m.forget();
  assert.equal(mem.q.size + mem.notes.size, 0);
  assert.equal(await m.sync('a', note(1).ink()), 1, 'sent in full again');
});

test('the backend id of a note is random, not the note id in the app', async () => {
  const { m, mem, server } = setup();
  await m.sync('note-1795000000000-abc', note(1).ink());
  await m.flush();
  const up = server.requests[0][0];
  assert.match(up.note, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  assert.ok(!JSON.stringify(up).includes('note-1795000000000-abc'));
  assert.equal(mem.notes.get('note-1795000000000-abc').mirror, up.note);
});

test('the app sends what the rules of the backend take', () => {
  // The same shape as the backend's frozen example of an upload.
  const spec = readFileSync(new URL('../../../openspec/specs/note-mirrors/spec.md', import.meta.url), 'utf8');
  for (const field of ['"format": "bedrock-note-mirror"', '"add"', '"erase"', '"note"']) assert.ok(spec.includes(field), field);
  const [u] = plan({ mirror: uuid(), channels: CHANNELS, strokes: [stroke(1)], sent: [], uuid });
  assert.deepEqual(Object.keys(u).sort(), ['add', 'channels', 'erase', 'format', 'id', 'note', 'version', 'written']);
});
