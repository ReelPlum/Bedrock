// Sending a note's handwriting line by line (training sample version 3),
// with a pretend canvas: which lines are sent, with which words, and which
// earlier samples each one replaces. The app-level tests in
// collect.test.mjs cover the same through the real page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WordSharer } from '../src/share-words.js';
import { fromLine } from '../src/collect.js';
import { readFileSync } from 'node:fs';

const CHANNELS = ['x', 'y', 'pressure', 't'];
const T0 = 1_800_000_000_000;

/** A pretend note: `strokes` id -> [x, y] where it starts; `words` as
 *  `words_json` gives them. */
function canvas() {
  const c = {
    strokes: new Map(),
    words: [],
    add(id, x, y, start = T0 + c.strokes.size * 100) {
      c.strokes.set(String(id), { start, points: [x, y, 0.5, 0, x + 8, y + 20, 0.5, 8] });
    },
    words_json: () => JSON.stringify(c.words),
    stroke_json: (id) => (c.strokes.has(String(id)) ? JSON.stringify(c.strokes.get(String(id))) : null),
    meta_json: () => JSON.stringify({ channels: CHANNELS }),
  };
  return c;
}

const word = (id, strokes, line, text = null, more = {}) => ({ id, strokes: strokes.map(String), line, kind: 'text', text, engine: text == null ? null : 'test-reader', alternatives: [], ...more });

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

function sharer(c, { storage = memoryStorage(), since = 0, reading = true } = {}) {
  const sent = [];
  let clock = T0 + 60_000;
  const s = new WordSharer({
    canvas: c,
    noteId: () => 'note-1',
    enabled: () => true,
    since: () => since,
    reading: () => reading,
    enqueue: async (samples) => { sent.push(...samples); },
    now: () => clock,
    storage,
  });
  s.settleMs = 0;
  return { s, sent, storage, tick: (ms) => { clock += ms; } };
}

test('a line is sent whole, with where it was cut into words', async () => {
  const c = canvas();
  for (const [id, x] of [[1, 0], [2, 20], [3, 80], [4, 100], [5, 0]]) c.add(id, x, id === 5 ? 300 : 0);
  c.words = [word('a', [1, 2], 0, 'to'), word('b', [3, 4], 0, 'gether'), word('c', [5], 1, 'next')];
  const { s, sent } = sharer(c);
  assert.equal(await s.scan(), 2, 'one sample per line');
  const line = sent.find((x) => x.words.length === 2);
  assert.equal(line.version, 3);
  assert.deepEqual([line.source, line.kind, line.label, line.label_source], ['note', 'text', 'to gether', 'unchecked']);
  assert.deepEqual(line.words.map((w) => [w.strokes, w.label, w.label_source, w.model_reading]), [[[0, 1], 'to', 'unchecked', 'to'], [[2, 3], 'gether', 'unchecked', 'gether']]);
  assert.equal(line.strokes.length, 4);
  assert.equal(line.model_engine, 'test-reader');
  assert.equal(line.supersedes, undefined);
  assert.equal(await s.scan(), 0, 'sent once');
});

test('a line is sent again when its words are regrouped, replacing the earlier sample', async () => {
  const c = canvas();
  for (const [id, x] of [[1, 0], [2, 20], [3, 80], [4, 100]]) c.add(id, x, 0);
  c.words = [word('a', [1, 2], 0, 'to'), word('b', [3, 4], 0, 'gether')];
  const { s, sent } = sharer(c);
  await s.scan();
  // The writer moves closer: the layout now sees one word.
  c.words = [word('ab', [1, 2, 3, 4], 0, 'together')];
  assert.equal(await s.scan(), 1);
  assert.deepEqual([sent[1].label, sent[1].words.length, sent[1].supersedes], ['together', 1, [sent[0].id]]);
  // And a word added to the line replaces it again.
  c.add(5, 200, 0);
  c.words.push(word('c', [5], 0, 'now'));
  assert.equal(await s.scan(), 1);
  assert.deepEqual([sent[2].label, sent[2].supersedes], ['together now', [sent[1].id]]);
  assert.equal(s.lines.size, 1, 'only the newest sample of the line is remembered');
});

test('checking a word sends its line at once; an unchecked reading waits until it settles', async () => {
  const c = canvas();
  for (const [id, x] of [[1, 0], [2, 80]]) c.add(id, x, 0);
  c.words = [word('a', [1], 0, 'helo'), word('b', [2], 0, 'world')];
  const { s, sent, tick } = sharer(c);
  s.settleMs = 20_000;
  assert.equal(await s.scan(), 0, 'still settling');
  tick(20_000);
  assert.equal(await s.scan(), 1);
  // The writer corrects the first word.
  c.words[0] = word('a', [1], 0, 'hello', { engine: 'user', alternatives: ['helo'] });
  s.checks.set('note-1:a', { labelSource: 'corrected', reading: 'helo', engine: 'test-reader' });
  assert.equal(await s.scan(), 1, 'no waiting');
  assert.deepEqual([sent[1].label, sent[1].label_source, sent[1].supersedes], ['hello world', 'unchecked', [sent[0].id]]);
  assert.deepEqual(sent[1].words.map((w) => [w.label, w.label_source]), [['hello', 'corrected'], ['world', 'unchecked']]);
});

test('a checked word is never sent unchecked again', async () => {
  const c = canvas();
  c.add(1, 0, 0);
  c.add(2, 80, 0);
  c.words = [word('a', [1], 0, 'hi', { engine: 'user' })];
  const { s, sent } = sharer(c);
  await s.scan();
  assert.equal(sent[0].label_source, 'confirmed');
  // A new word on the line, and the first one somehow read again.
  c.words = [word('a', [1], 0, 'hl'), word('b', [2], 0, 'there')];
  await s.scan();
  assert.deepEqual(sent[1].words.map((w) => [w.label, w.label_source]), [['hi', 'confirmed'], ['there', 'unchecked']]);
});

test('a line waits for words not read yet, unless the app is being hidden', async () => {
  const c = canvas();
  c.add(1, 0, 0);
  c.add(2, 80, 0);
  c.words = [word('a', [1], 0, 'hi'), word('b', [2], 0, null)];
  const { s, sent } = sharer(c);
  assert.equal(await s.scan(), 0);
  assert.equal(await s.scan({ force: true }), 1);
  assert.deepEqual(sent[0].words.map((w) => w.label), ['hi'], 'only the words read so far');
});

test('words written before the setting was on stay out of the line', async () => {
  const c = canvas();
  c.add(1, 0, 0, T0);
  c.add(2, 80, 0, T0 + 10_000);
  c.words = [word('a', [1], 0, 'old'), word('b', [2], 0, 'new')];
  const { s, sent } = sharer(c, { since: T0 + 5_000 });
  await s.scan();
  assert.deepEqual([sent[0].label, sent[0].strokes.length], ['new', 1]);
});

test('words sent alone by an earlier version are replaced by their line', async () => {
  // What the app kept in localStorage before lines were sent, frozen.
  const v1 = readFileSync(new URL('../../../crates/bedrock-core/tests/fixtures/old-formats/shared-words-v1.json', import.meta.url), 'utf8');
  const c = canvas();
  c.add(1, 0, 0);
  c.add(2, 80, 0);
  c.words = [word('a', [1], 0, 'hl'), word('b', [2], 0, 'there')];
  const storage = memoryStorage({ 'bedrock.sharedWords.v1': v1 });
  const { s, sent } = sharer(c, { storage });
  await s.scan();
  assert.deepEqual(sent[0].supersedes, ['019a3b5c-7d2e-7abc-8def-000000000001', '019a3b5c-7d2e-7abc-8def-000000000002']);
  assert.deepEqual(sent[0].words.map((w) => [w.label, w.label_source]), [['hi', 'confirmed'], ['there', 'unchecked']], 'the word checked before keeps its text');
  assert.deepEqual(JSON.parse(storage.getItem('bedrock.sharedWords.v1')).map(([k]) => k), ['note-2:c'], 'the replaced records are gone, the rest kept');
  assert.equal(JSON.parse(storage.getItem('bedrock.sharedLines.v1')).length, 1);
  s.forget();
  assert.deepEqual(JSON.parse(storage.getItem('bedrock.sharedLines.v1')), []);
  assert.equal(storage.getItem('bedrock.sharedWords.v1'), null);
});

test('a line too long for one sample is sent in pieces of whole words', async () => {
  const c = canvas();
  const words = [];
  let id = 0;
  for (let k = 0; k < 9; k++) {
    const ids = [];
    for (let i = 0; i < 100; i++) { c.add(++id, k * 1000 + i, 0); ids.push(id); }
    words.push(word(`w${k}`, ids, 0, `w${k}`));
  }
  c.words = words;
  const { s, sent } = sharer(c);
  assert.equal(await s.scan(), 2);
  assert.deepEqual(sent.map((x) => x.strokes.length), [800, 100]);
});

test('a line of only a drawing has no text', () => {
  const ink = [{ start: T0, points: [5, 5, 0.5, 0, 9, 9, 0.5, 8] }];
  const s = fromLine({ words: [{ strokes: ink, kind: 'drawing', label: 'x', labelSource: 'corrected' }], channels: CHANNELS });
  assert.deepEqual([s.version, s.kind, s.label, s.label_source], [3, 'text', '', 'corrected']);
  assert.deepEqual(s.words, [{ strokes: [0], kind: 'drawing', label: '', label_source: 'corrected' }]);
  assert.deepEqual(s.strokes[0].points.slice(0, 2), [0, 0], 'moved to 0,0');
});
