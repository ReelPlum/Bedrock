// Tag suggestions (tag-suggest.js): the parts without a browser, run in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libraryTags, mergeTags, readNoteTags, suggestTags, tagQuery, tallyTags } from '../src/tag-suggest.js';

/** A .bedrock archive holding only `note.json`, stored (not deflated). */
function noteFile(noteJson) {
  const enc = new TextEncoder();
  const name = enc.encode('note.json');
  const data = enc.encode(JSON.stringify(noteJson));
  const local = new Uint8Array(30 + name.length + data.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, name.length, true);
  local.set(name, 30);
  local.set(data, 30 + name.length);
  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, name.length, true);
  cv.setUint32(42, 0, true);
  central.set(name, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);
  const out = new Uint8Array(local.length + central.length + end.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(end, local.length + central.length);
  return out;
}

test('tags in use are counted per note, case-insensitively, in the spelling used most, without bedrock', () => {
  const known = tallyTags([
    ['Biology', 'physics/forces', 'Biology'],
    ['#biology', 'Exam-prep', 'bedrock'],
    ['Biology', '12', 'not a tag', null],
    'damaged',
  ]);
  assert.deepEqual(known, [
    { tag: 'Biology', count: 3 },
    { tag: 'physics/forces', count: 1 },
    { tag: 'Exam-prep', count: 1 },
  ]);
  assert.deepEqual(mergeTags([{ tag: 'Math', count: 2 }], [{ tag: 'math', count: 1 }, { tag: '#x', count: 1 }]), [{ tag: 'Math', count: 3 }]);
});

test('suggestions match the start of the tag, then a part of it, then inside it; the most used first; not the tags the note has', () => {
  const known = [
    { tag: 'physics/forces', count: 2 },
    { tag: 'forces', count: 1 },
    { tag: 'workforce', count: 5 },
    { tag: 'Exam-prep', count: 4 },
    { tag: 'exams', count: 1 },
    { tag: 'Biology', count: 9 },
  ];
  assert.deepEqual(suggestTags('forc', known).map((k) => k.tag), ['forces', 'physics/forces', 'workforce']);
  assert.deepEqual(suggestTags('#EXAM', known).map((k) => k.tag), ['Exam-prep', 'exams']);
  assert.deepEqual(suggestTags('prep', known).map((k) => k.tag), ['Exam-prep'], 'after a -');
  assert.deepEqual(suggestTags('exam prep', known).map((k) => k.tag), ['Exam-prep'], 'spaces are typed as -');
  assert.deepEqual(suggestTags('', known, ['biology']).map((k) => k.tag), ['workforce', 'Exam-prep', 'physics/forces', 'exams', 'forces'], 'nothing typed: the most used, not the note\'s own');
  assert.deepEqual(suggestTags('', known, [], 2).length, 2);
  assert.deepEqual(suggestTags('zzz', known), []);
  assert.deepEqual(suggestTags('a', null), []);
  assert.equal(tagQuery('  #Exam  prep '), 'exam-prep');
});

test('the tags of the library are read from the note.json of each note once, leaving out the open note', async () => {
  const files = new Map([
    ['a', noteFile({ format: 'bedrock-note', version: 1, strokes: [], tags: ['Biology', 'bedrock'] })],
    ['b', noteFile({ format: 'bedrock-note', version: 1, strokes: [], tags: ['biology', 'Lab'] })],
    ['c', noteFile({ format: 'bedrock-note', version: 1, strokes: [] })],
    ['open', noteFile({ format: 'bedrock-note', version: 1, tags: ['mine'] })],
    ['broken', new Uint8Array([1, 2, 3])],
  ]);
  const reads = [];
  const store = {
    list: async () => [...files.keys()].map((id) => ({ id, modified: 1 })),
    get: async (id) => { reads.push(id); return { id, data: files.get(id) }; },
  };
  assert.deepEqual(await readNoteTags(files.get('a')), ['Biology'], 'without bedrock');
  const cache = new Map();
  const known = await libraryTags(store, { except: 'open', cache });
  assert.deepEqual(known, [{ tag: 'Biology', count: 2 }, { tag: 'Lab', count: 1 }]);
  assert.ok(!reads.includes('open'));
  reads.length = 0;
  await libraryTags(store, { except: 'open', cache });
  assert.deepEqual(reads, [], 'notes that did not change are not read again');
});
