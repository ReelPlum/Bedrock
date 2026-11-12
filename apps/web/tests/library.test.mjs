// Folders and the exported library: the parts without a browser
// (library.js, sidecar.js, zip-read.js), run in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { cleanName, folderAndBelow, folderContents, folderNameProblem, folderPaths, libraryFiles } from '../src/library.js';
import { noteOfIndex, sidecarMarkdown } from '../src/sidecar.js';

/** A small .bedrock archive, entries deflated as zip.rs writes them. */
export function bedrock({ words = [], links = [] } = {}) {
  const enc = new TextEncoder();
  const entries = {
    'note.json': JSON.stringify({ format: 'bedrock-note', version: 1, strokes: [] }),
    'recognized.json': JSON.stringify({ format: 'bedrock-recognition', version: 1, items: words.map((text, i) => ({ id: `r${i}`, text, strokes: [`${i}`.padStart(16, 'a')] })) }),
    'links.md': `# Links in this note\n\n${links.map((l) => `- ${l}\n`).join('')}`,
  };
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const body = deflateRawSync(enc.encode(content));
    const n = enc.encode(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(8, 8); h.writeUInt32LE(body.length, 18); h.writeUInt16LE(n.length, 26);
    local.push(h, n, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(body.length, 20); c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, end]));
}

const folders = [
  { id: 'f1', name: 'School', parent: null },
  { id: 'f2', name: 'Physics', parent: 'f1' },
  { id: 'f3', name: 'Empty', parent: null },
  { id: 'f4', name: 'Lost', parent: 'gone' }, // its parent was deleted elsewhere
];

test('folder names are kept to what every file system and Obsidian accept', () => {
  assert.equal(cleanName('  Maths / Physics: 2026?  '), 'Maths Physics 2026');
  assert.equal(cleanName('.hidden'), 'hidden', 'Obsidian hides names starting with a dot');
  assert.equal(cleanName('Trailing. '), 'Trailing', 'Windows drops trailing dots');
  assert.equal(cleanName('///', 'Folder'), 'Folder');
  assert.equal(cleanName('x'.repeat(200)).length, 80);
});

test('a folder name must be new among its siblings, ignoring case', () => {
  const siblings = [{ name: 'School' }];
  assert.equal(folderNameProblem('Home', siblings), null);
  assert.match(folderNameProblem('school', siblings), /already a folder called “school”/);
  assert.match(folderNameProblem(' ', siblings), /needs a name/);
  assert.match(folderNameProblem('//', siblings), /no letters/);
});

test('folders nest: paths, contents and everything below a folder', () => {
  const paths = folderPaths(folders);
  assert.equal(paths.get('f2'), 'School/Physics');
  assert.equal(paths.get('f4'), 'Lost', 'a folder whose parent is gone is at the top');
  const notes = [
    { id: 'a', folder: null, modified: 1 },
    { id: 'b', folder: 'f2', modified: 2 },
    { id: 'c', folder: 'f2', modified: 3 },
    { id: 'd', folder: 'deleted', modified: 4 }, // shown at the top, not lost
  ];
  const top = folderContents(folders, notes, null);
  assert.deepEqual(top.folders.map((f) => f.name), ['Empty', 'Lost', 'School']);
  assert.deepEqual(top.notes.map((n) => n.id), ['d', 'a']);
  const physics = folderContents(folders, notes, 'f2');
  assert.deepEqual(physics.notes.map((n) => n.id), ['c', 'b'], 'newest first');
  assert.deepEqual([...folderAndBelow(folders, 'f1')].sort(), ['f1', 'f2']);
});

test('an exported library is a folder tree with a Markdown sidecar beside every note', async () => {
  const notes = [
    { id: '1111222233334444', title: 'Forces', folder: 'f2', data: bedrock({ words: ['Newton'], links: ['[[Ideas]]'] }) },
    { id: '5555666677778888', title: 'Forces', folder: 'f2', data: bedrock() },
    { id: '9999aaaabbbbcccc', title: '', folder: null, data: bedrock() },
    { id: 'ddddeeeeffff0000', title: 'Shopping', folder: 'nowhere', data: bedrock() },
  ];
  const files = await libraryFiles(folders, notes, { titleOf: (n) => n.title || 'From file' });
  assert.deepEqual(files.map(([p]) => p), [
    'Empty/', 'Lost/', 'School/', 'School/Physics/',
    'School/Physics/Forces.bedrock', 'School/Physics/Forces.bedrock.md',
    'School/Physics/Forces 5555.bedrock', 'School/Physics/Forces 5555.bedrock.md',
    'From file.bedrock', 'From file.bedrock.md',
    'Shopping.bedrock', 'Shopping.bedrock.md',
  ]);
  const map = new Map(files);
  assert.equal(map.get('School/Physics/Forces.bedrock'), notes[0].data, 'the note file is saved as it is');
  const md = new TextDecoder().decode(map.get('School/Physics/Forces.bedrock.md'));
  assert.equal(noteOfIndex(md), 'School/Physics/Forces.bedrock');
  assert.match(md, /\[\[School\/Physics\/Forces\.bedrock\|Forces\]\]/);
  assert.match(md, /## Text\n\nNewton\n/);
  assert.match(md, /## Links\n\n- \[\[Ideas\]\]\n/);
  assert.equal(md, await sidecarMarkdown('School/Physics/Forces.bedrock', notes[0].data), 'the same bytes the plugin writes');
});

test('a note with a damaged file still gets a sidecar', async () => {
  const files = await libraryFiles([], [{ id: '1', title: 'Broken', data: new Uint8Array([1, 2, 3]) }]);
  const md = new TextDecoder().decode(new Map(files).get('Broken.bedrock.md'));
  assert.match(md, /_Nothing read yet\._/);
});
