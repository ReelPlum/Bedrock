// Unit tests of the plugin's Obsidian-free parts, with an in-memory vault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { FakeVault } from './fake-vault.mjs';
import { readZip, text } from '../src/zip.js';
import { DEFAULT_INDEX_FOLDER, Indexer, indexLayout, indexMarkdown, indexPath, isIndexPath, noteForIndex, noteOfIndex, offsetOf, readNoteText, strokesAt, strokesForIndexPlace } from '../src/index-note.js';
import { libraryFiles } from '../../web/src/library.js';
import { VIEW_ONLY, createSession, fileNameFor, linkToStroke, strokesOfState } from '../src/session.js';
import { HostBridge } from '../src/bridge.js';
import { InlineApp, GLOBALS_MARK, MODULE_MARK } from '../src/inline-app.js';
import { obsidianTheme, tellTheme } from '../src/theme.js';
import { notePicture, readPointsBin } from '../../web/src/link-picker.js';
import { packWebApp } from '../build.mjs';
import { GRAPH_FILTER, copyGraphFilter } from '../src/graph.js';
import { BulkImport, PdfReader } from '../src/bulk-import.js';
import { droppedFiles } from '../src/pdf-drop.js';
import { ErrorLog, pluginWatcher, reportsAddress, sendReport, withPluginSlow } from '../src/report.js';

/** A ZIP like zip.rs writes: each entry deflated if that is smaller. */
function zip(entries) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const deflated = deflateRawSync(data);
    const [method, body] = deflated.length < data.length ? [8, deflated] : [0, data];
    const n = enc.encode(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(method, 8);
    h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    local.push(h, n, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...local, cd, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

const recognized = (...words) => JSON.stringify({ format: 'bedrock-recognition', version: 1, items: words.map((text, i) => ({ id: `r${i}`, text, strokes: [] })) });
const note = (words, links = []) => zip({
  'note.json': JSON.stringify({ format: 'bedrock-note', version: 1, strokes: [], padding: 'x'.repeat(500) }),
  'recognized.json': recognized(...words),
  'links.md': `# Links in this note\n\n${links.map((l) => `- ${l}\n`).join('')}`,
  'README.txt': 'short',
});

test('reads stored and deflated entries from a .bedrock archive', async () => {
  const files = await readZip(note(['Newton'], ['[[Ideas]]']));
  assert.deepEqual([...files.keys()].sort(), ['README.txt', 'links.md', 'note.json', 'recognized.json']);
  assert.equal(text(files.get('README.txt')), 'short');
  assert.match(text(files.get('note.json')), /bedrock-note/);
  const some = await readZip(note(['a']), ['links.md']);
  assert.deepEqual([...some.keys()], ['links.md']);
});

test('a damaged or empty file gives no entries instead of throwing', async () => {
  assert.equal((await readZip(new ArrayBuffer(0))).size, 0);
  assert.equal((await readZip(new TextEncoder().encode('not a zip at all, just text').buffer)).size, 0);
  const bytes = new Uint8Array(note(['Newton']));
  bytes.fill(0, 40, 120); // break the first entry's data
  const files = await readZip(bytes);
  assert.ok(files.has('links.md'), 'later entries still read');
});

test('index note holds the handwriting text and the links', async () => {
  const t = await readNoteText(note(['Newton', ' second ', 'law', ''], ['[[Ideas]]', '[site](<https://example.com>)']));
  assert.deepEqual(t.words, ['Newton', 'second', 'law']);
  const md = indexMarkdown('Physics/Forces.bedrock', t);
  assert.match(md, /^---\nbedrock: "Physics\/Forces.bedrock"\n/);
  assert.match(md, /\[\[Physics\/Forces\.bedrock\|Forces\]\]/, 'links back to the handwriting');
  assert.match(md, /## Text\n\nNewton second law\n/);
  assert.match(md, /## Links\n\n- \[\[Ideas\]\]\n- \[site\]\(<https:\/\/example.com>\)/);
  assert.equal(noteOfIndex(md), 'Physics/Forces.bedrock');
});

test("the index note carries the note's tags and the links of the whole note", async () => {
  const bytes = zip({
    // A text box holding `"tags":[` is escaped in JSON, so only the note's own list counts.
    'note.json': JSON.stringify({ format: 'bedrock-note', version: 1, strokes: [], texts: [{ text: '"tags":["no"]' }], noteLinks: [{ target: 'Lectures/Week 3.pdf#page=4', type: 'note', text: 'Week 3, page 4' }], tags: ['physics/forces', 'Exam-prep', 'bedrock', 'not a tag', '2026', 'true', 'physics/forces'] }),
    'recognized.json': recognized('Newton'),
    'links.md': '# Links in this note\n\n- [[Lectures/Week 3.pdf#page=4|Week 3, page 4]]\n- [[Ideas]]\n',
  });
  const t = await readNoteText(bytes);
  assert.deepEqual(t.tags, ['physics/forces', 'Exam-prep', 'true'], 'only real tags, once, and bedrock is already there');
  const md = indexMarkdown('Physics/Forces.bedrock', t);
  assert.match(md, /^---\nbedrock: "Physics\/Forces.bedrock"\ntags: \[bedrock, physics\/forces, Exam-prep, "true"\]\n---\n/);
  assert.match(md, /## Links\n\n- \[\[Lectures\/Week 3\.pdf#page=4\|Week 3, page 4\]\]\n- \[\[Ideas\]\]\n/, 'the note link first, then the words\' links');
  assert.equal(noteOfIndex(md), 'Physics/Forces.bedrock');
  // A damaged list costs the tags, nothing else.
  const damaged = await readNoteText(zip({ 'note.json': '{"format":"bedrock-note","tags":[1,', 'recognized.json': recognized('Newton') }));
  assert.deepEqual([damaged.tags, damaged.words], [[], ['Newton']]);
});

test('index notes from before tags: an untagged note indexes the same, and old index notes still open their note', async () => {
  const { readFileSync } = await import('node:fs');
  const old = readFileSync(new URL('./fixtures/index-before-tags.md', import.meta.url), 'utf8');
  const noteBytes = readFileSync(new URL('../../../crates/bedrock-core/tests/fixtures/old-formats/v1-before-note-links.bedrock', import.meta.url));
  assert.equal(noteOfIndex(old), 'School/Before note links.bedrock');
  assert.equal(indexMarkdown('School/Before note links.bedrock', await readNoteText(new Uint8Array(noteBytes))), old,
    'a note without tags or note links gets the very same index note as before');
});

test('the graph filter hides .bedrock files and the #bedrock tag node, and keeps index notes, sidecars and PDFs', async () => {
  assert.equal(GRAPH_FILTER, '-file:/\\.bedrock$/ -(#bedrock)');
  // `-file:/\.bedrock$/`: the regular expression Obsidian runs on file names.
  const hidden = (name) => /\.bedrock$/.test(name);
  assert.ok(hidden('Forces.bedrock'));
  for (const kept of ['Forces.bedrock.md', 'Forces.md', 'Week 3.pdf', 'Ideas.md']) assert.ok(!hidden(kept), `${kept} stays in the graph`);
  // `-(#bedrock)` keeps every index note: none says `#bedrock` in its
  // text (the tag is only in the front matter), and the edge to a PDF page
  // stays, since it starts at the index note.
  const bytes = zip({
    'note.json': JSON.stringify({ format: 'bedrock-note', version: 1, strokes: [], noteLinks: [{ target: 'Lectures/Week 3.pdf#page=4', type: 'note', text: 'Week 3, page 4' }], tags: ['physics'] }),
    'recognized.json': recognized('Newton'),
    'links.md': '# Links in this note\n\n- [[Lectures/Week 3.pdf#page=4|Week 3, page 4]]\n',
  });
  const md = indexMarkdown('Physics/Forces.bedrock', await readNoteText(bytes));
  assert.doesNotMatch(md, /#bedrock/i);
  assert.match(md, /^tags: \[bedrock, physics\]$/m, 'the tag the filter hides');
  assert.match(md, /\[\[Lectures\/Week 3\.pdf#page=4\|/);
});

test('the graph filter goes on the clipboard, or is shown where the clipboard is refused', async () => {
  const said = [];
  let copied = null;
  assert.equal(await copyGraphFilter({ writeText: async (t) => { copied = t; } }, (m) => said.push(m)), true);
  assert.equal(copied, GRAPH_FILTER);
  assert.match(said[0], /copied.*Attachments.*Search files/);
  assert.equal(await copyGraphFilter({ writeText: async () => { throw new Error('denied'); } }, (m) => said.push(m)), false);
  assert.ok(said[1].includes(GRAPH_FILTER), 'the filter is shown to copy by hand');
  assert.equal(await copyGraphFilter(undefined, (m) => said.push(m)), false, 'no clipboard at all');
});

test('handwriting that looks like Markdown links does not become a link', () => {
  const md = indexMarkdown('a.bedrock', { words: ['[[Secret]]'], links: [] });
  assert.match(md, /\\\[\\\[Secret\\\]\\\]/);
  assert.doesNotMatch(md, /## Links/);
});

/** A note whose words each have their own strokes: [text, [stroke ids]]. */
const inkNote = (...items) => zip({
  'note.json': JSON.stringify({ format: 'bedrock-note', version: 1, strokes: [], padding: 'x'.repeat(500) }),
  'recognized.json': JSON.stringify({ format: 'bedrock-recognition', version: 1, items: items.map(([text, strokes], i) => ({ id: `r${i}`, text, strokes })) }),
  'links.md': '# Links in this note\n\n- [[Ideas]]\n',
});
const LAW = [['Newton', ['a1', 'a2']], ['[second]', ['b1']], ['law', ['c1', 'c2']]];

test('every word of the index note knows the strokes it was read from', async () => {
  const t = await readNoteText(inkNote(...LAW));
  const { markdown, spans } = indexLayout('Forces.bedrock', t);
  assert.equal(markdown, indexMarkdown('Forces.bedrock', t));
  // The spans are the words as they stand in the note, escapes included.
  assert.deepEqual(spans.map((s) => markdown.slice(s.start, s.end)), ['Newton', '\\[second\\]', 'law']);
  assert.deepEqual(spans.map((s) => s.strokes), [['a1', 'a2'], ['b1'], ['c1', 'c2']]);
  const at = (word) => markdown.indexOf(word);
  // A hit inside a word, a hit across two words, and a caret.
  assert.deepEqual(strokesAt(spans, at('wton'), at('wton') + 4), ['a1', 'a2']);
  assert.deepEqual(strokesAt(spans, at('second'), at('law') + 3), ['b1', 'c1', 'c2']);
  assert.deepEqual(strokesAt(spans, at('law') + 1), ['c1', 'c2']);
  assert.deepEqual(strokesAt(spans, at('law') + 3, at('law')), ['c1', 'c2'], 'a backwards selection');
  // Outside the text (the title, the links): nothing to show.
  assert.deepEqual(strokesAt(spans, 0, 10), []);
  assert.deepEqual(strokesAt(spans, at('Ideas'), at('Ideas') + 5), []);
  // Older index notes were built from words alone and still work.
  assert.deepEqual(indexLayout('a.bedrock', { words: ['x'], links: [] }).spans.map((s) => s.strokes), [[]]);
});

test('a search hit in the index note names the ink it was read from', async () => {
  const bytes = inkNote(...LAW);
  const md = indexMarkdown('Forces.bedrock', await readNoteText(bytes));
  const place = (eState, markdown = md) => strokesForIndexPlace('Forces.bedrock', bytes, markdown, eState);
  const i = md.indexOf('law');
  // What Obsidian's search hands the file it opens.
  assert.deepEqual(await place({ match: { content: md, matches: [[i, i + 3]] } }), ['c1', 'c2']);
  assert.deepEqual(await place({ match: { content: md, matches: [[md.indexOf('Newton'), i + 3]] } }), ['a1', 'a2', 'b1', 'c1', 'c2'], 'a phrase');
  // A line and column (the editor's cursor), and a line alone.
  const line = md.slice(0, i).split('\n').length - 1;
  assert.equal(offsetOf(md, line, 0), md.indexOf('Newton'));
  assert.deepEqual(await place({ line, ch: i - md.indexOf('Newton') }), ['c1', 'c2']);
  assert.deepEqual(await place({ line }), ['a1', 'a2', 'b1', 'c1', 'c2']);
  // No place, a place off the text, or nonsense: the note just opens.
  assert.deepEqual(await place(undefined), []);
  assert.deepEqual(await place({}), []);
  assert.deepEqual(await place({ line: 0 }), []);
  assert.deepEqual(await place({ match: { matches: [['x', null]] } }), []);
  assert.deepEqual(await place({ line: 9999, ch: 3 }), []);
  // The index is older than the note (a word was added on another device
  // and it has not been re-indexed yet): the hit is found by its text.
  const older = indexMarkdown('Forces.bedrock', await readNoteText(inkNote(LAW[0], LAW[2])));
  const j = older.indexOf('law');
  assert.deepEqual(await place({ match: { matches: [[j, j + 3]] } }, older), ['c1', 'c2']);
  // A damaged note file: no place, no error.
  assert.deepEqual(await strokesForIndexPlace('Forces.bedrock', new ArrayBuffer(0), md, { line, ch: 2 }), []);
});

test('a view is told which ink to show by a redirected search hit or a link to a word', () => {
  assert.deepEqual(strokesOfState({ bedrock: { strokes: ['9f2c4e1a7b3d5f60', 'not an id', 7] } }), ['9f2c4e1a7b3d5f60']);
  assert.deepEqual(strokesOfState({ subpath: '#^9F2C4E1A7B3D5F60' }), ['9f2c4e1a7b3d5f60']);
  assert.deepEqual(strokesOfState({ subpath: '#Heading' }), []);
  assert.deepEqual(strokesOfState({ subpath: '#^' }), []);
  assert.deepEqual(strokesOfState({}), []);
  assert.deepEqual(strokesOfState(null), []);
  assert.equal(linkToStroke('Physics/Forces.bedrock', '9f2c4e1a7b3d5f60'), '[[Physics/Forces.bedrock#^9f2c4e1a7b3d5f60]]');
  // The link and the state it opens with agree.
  assert.deepEqual(strokesOfState({ subpath: linkToStroke('x', 'ab12').slice(3, -2) }), ['ab12']);
});

test('index note paths, with and without an index folder', () => {
  assert.equal(indexPath('Physics/Forces.bedrock'), `${DEFAULT_INDEX_FOLDER}/Physics/Forces.md`);
  assert.equal(indexPath('Forces.bedrock', '/Index/'), 'Index/Forces.md');
  assert.equal(indexPath('Physics/Forces.bedrock', ''), 'Physics/Forces.bedrock.md');
  assert.ok(isIndexPath(`${DEFAULT_INDEX_FOLDER}/Forces.md`));
  assert.ok(!isIndexPath('Forces.md'));
  assert.ok(isIndexPath('Physics/Forces.bedrock.md', ''));
  assert.ok(!isIndexPath('Physics/Forces.md', ''));
  assert.equal(noteOfIndex(indexMarkdown('Odd "name".bedrock', { words: [], links: [] })), 'Odd "name".bedrock');
  assert.equal(noteOfIndex('# just a note'), null);
});

test('indexer creates, updates only on change, follows renames and deletes', async () => {
  const vault = new FakeVault();
  const ix = new Indexer(vault);
  assert.equal(await ix.update('Physics/Forces.bedrock', note(['Newton'])), true);
  const path = `${DEFAULT_INDEX_FOLDER}/Physics/Forces.md`;
  assert.ok(vault.folders.has(DEFAULT_INDEX_FOLDER) && vault.folders.has(`${DEFAULT_INDEX_FOLDER}/Physics`));
  assert.match(vault.files.get(path).data, /Newton/);
  assert.equal(await ix.update('Physics/Forces.bedrock', note(['Newton'])), false, 'unchanged text is not rewritten');
  assert.equal(await ix.update('Physics/Forces.bedrock', note(['Newtons'])), true);
  assert.match(vault.files.get(path).data, /Newtons/);
  await ix.rename('Physics/Forces.bedrock', 'Forces.bedrock', note(['Newtons']));
  assert.ok(!vault.files.has(path));
  assert.equal(noteOfIndex(vault.files.get(`${DEFAULT_INDEX_FOLDER}/Forces.md`).data), 'Forces.bedrock');
  await ix.remove('Forces.bedrock');
  assert.ok(!vault.files.has(`${DEFAULT_INDEX_FOLDER}/Forces.md`));
});

test('indexer sync indexes notes written elsewhere and skips up-to-date ones', async () => {
  const vault = new FakeVault();
  await vault.createBinary('A.bedrock', note(['alpha']));
  await vault.createBinary('B.bedrock', note(['beta']));
  await vault.createBinary('New.bedrock', new ArrayBuffer(0)); // a new, empty note
  const ix = new Indexer(vault);
  assert.equal(await ix.sync(), 2);
  assert.equal(await ix.sync(), 0);
  vault.outsideChange('B.bedrock', note(['beta', 'gamma']));
  assert.equal(await ix.sync(), 1);
  assert.match(vault.files.get(`${DEFAULT_INDEX_FOLDER}/B.md`).data, /beta gamma/);
});

/** Put an exported web library into a vault under `under` (a folder
 *  path, or '' for the vault's root), as dragging the unzipped folder in does. */
async function dropLibrary(vault, files, under = '') {
  for (const [path, bytes] of files) {
    const at = under ? `${under}/${path}` : path;
    if (at.endsWith('/')) { vault.folders.add(at.slice(0, -1)); continue; }
    if (at.endsWith('.md')) await vault.create(at, new TextDecoder().decode(bytes));
    else await vault.createBinary(at, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
}

const webLibrary = () => libraryFiles(
  [{ id: 'f1', name: 'School', parent: null }],
  [{ id: '1111222233334444', title: 'Forces', folder: 'f1', data: new Uint8Array(note(['Newton'], ['[[Ideas]]'])) }],
);

test('a library exported by the website drops into the vault root and is already indexed', async () => {
  const vault = new FakeVault();
  await dropLibrary(vault, await webLibrary());
  const before = vault.files.get('School/Forces.bedrock.md').data;
  const ix = new Indexer(vault);
  vault.log.length = 0;
  assert.equal(await ix.sync(), 0, 'its sidecars are what the plugin would write');
  assert.deepEqual(vault.log, [], 'nothing is written, and nothing in the index folder');
  assert.ok(isIndexPath('School/Forces.bedrock.md'), 'a sidecar counts as an index note with the default folder setting');
  assert.equal(noteForIndex('School/Forces.bedrock.md', before, (p) => vault.files.has(p)), 'School/Forces.bedrock');
  // Later saves update the sidecar, not a new note in the index folder.
  vault.outsideChange('School/Forces.bedrock', note(['Newton', 'Hooke']));
  assert.equal(await ix.sync(), 1);
  assert.match(vault.files.get('School/Forces.bedrock.md').data, /Newton Hooke/);
  assert.ok(![...vault.files.keys()].some((p) => p.startsWith(DEFAULT_INDEX_FOLDER)));
});

/** "Newton Hooke" (strokes s1, s2) with these links. */
const inkLinked = (links) => zip({
  'note.json': JSON.stringify({ format: 'bedrock-note', version: 1, strokes: [] }),
  'recognized.json': JSON.stringify({ format: 'bedrock-recognition', version: 1, items: [{ id: 'r0', text: 'Newton', strokes: ['s1'] }, { id: 'r1', text: 'Hooke', strokes: ['s2'] }] }),
  'links.md': `# Links in this note\n\n${links.map((l) => `- ${l}\n`).join('')}`,
});

test('an index note links the index notes of the handwritten notes its note links, so the graph shows the edge', async () => {
  const vault = new FakeVault();
  const bin = (b) => (b.buffer ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b);
  await vault.createBinary('School/Gravity.bedrock', bin(note(['g'])));
  await vault.createBinary('Kept/Beside.bedrock', bin(note(['b'])));
  await vault.create('Kept/Beside.bedrock.md', 'a sidecar');
  await vault.createBinary('School/Forces.bedrock', bin(inkLinked([
    '[[School/Gravity.bedrock#^00000000000000aa|Hooke]]',
    '[[School/Gravity.bedrock]]',
    '[[Kept/Beside.bedrock]]',
    '[[School/Forces.bedrock#^00000000000000bb|Newton]]',
    '[[Gone.bedrock]]',
    '[[Lectures/Week 3.pdf#page=4|Week 3, page 4]]',
  ])));
  const ix = new Indexer(vault);
  await ix.sync();
  const md = vault.files.get(`${DEFAULT_INDEX_FOLDER}/School/Forces.md`).data;
  assert.match(md, /## Links\n\n(- .*\n){6}\n## Linked handwritten notes\n\n- \[\[Bedrock index\/School\/Gravity\.md\|Gravity\]\]\n- \[\[Kept\/Beside\.bedrock\.md\|Beside\]\]\n$/,
    'each linked note once, by its index note (in the index folder, or its sidecar); not the note itself, not a missing note');
  // The words are where they were: a search hit still finds their strokes.
  const bytes = vault.files.get('School/Forces.bedrock').data;
  const at = md.indexOf('Hooke');
  assert.deepEqual(await strokesForIndexPlace('School/Forces.bedrock', bytes, md, { match: { matches: [[at, at + 5]] } }), ['s2']);
  // Notes linking no handwritten note get no section.
  assert.doesNotMatch(vault.files.get(`${DEFAULT_INDEX_FOLDER}/School/Gravity.md`).data, /Linked handwritten notes/);
  // Obsidian's own resolver: a short link text finds the note.
  const short = new Indexer(vault, undefined, (link) => (link === 'Gravity.bedrock' ? 'School/Gravity.bedrock' : null));
  assert.match(indexMarkdown('School/Forces.bedrock', { words: [], links: ['- [[Gravity.bedrock#^00000000000000aa|x]]'] }, { indexOf: (l) => short.indexOfLink(l, 'School/Forces.bedrock') }),
    /- \[\[Bedrock index\/School\/Gravity\.md\|Gravity\]\]\n$/);
});

test('index notes from before linked notes: they still open their note, and are rewritten with the section', async () => {
  const { readFileSync } = await import('node:fs');
  const old = readFileSync(new URL('./fixtures/index-before-linked-notes.md', import.meta.url), 'utf8');
  assert.equal(noteOfIndex(old), 'School/Forces.bedrock');
  const vault = new FakeVault();
  const bin = (b) => (b.buffer ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b);
  await vault.createBinary('School/Gravity.bedrock', bin(note(['g'])));
  await vault.createBinary('School/Forces.bedrock', bin(inkLinked(['[[School/Gravity.bedrock#^00000000000000aa|Hooke]]', '[[Ideas]]'])));
  const ix = new Indexer(vault);
  await ix.sync();
  // The old index note is newer than its note, as it is after an update.
  await vault.modify(vault.files.get(`${DEFAULT_INDEX_FOLDER}/School/Forces.md`), old);
  assert.equal(noteForIndex(`${DEFAULT_INDEX_FOLDER}/School/Forces.md`, old, (p) => vault.files.has(p)), 'School/Forces.bedrock');
  // A search hit in the old index note still finds the words.
  const at = old.indexOf('Hooke');
  assert.deepEqual(await strokesForIndexPlace('School/Forces.bedrock', vault.files.get('School/Forces.bedrock').data, old, { match: { matches: [[at, at + 5]] } }), ['s2']);
  assert.equal(await ix.sync(), 1, 'rewritten once');
  assert.equal(vault.files.get(`${DEFAULT_INDEX_FOLDER}/School/Forces.md`).data, `${old}\n## Linked handwritten notes\n\n- [[Bedrock index/School/Gravity.md|Gravity]]\n`, 'the same, with the section added');
  assert.equal(await ix.sync(), 0);
});

test('a library dropped into a subfolder: sidecars open their note and are fixed to the new path', async () => {
  const vault = new FakeVault();
  await dropLibrary(vault, await webLibrary(), 'Imports/Bedrock notes');
  const path = 'Imports/Bedrock notes/School/Forces.bedrock';
  const md = vault.files.get(`${path}.md`).data;
  assert.equal(noteOfIndex(md), 'School/Forces.bedrock', 'written for the export root');
  assert.equal(noteForIndex(`${path}.md`, md, (p) => vault.files.has(p)), path, 'the sidecar opens the note beside it');
  const ix = new Indexer(vault);
  assert.equal(await ix.sync(), 1, 'the sidecar is rewritten for where it now is');
  assert.equal(noteOfIndex(vault.files.get(`${path}.md`).data), path);
  assert.ok(![...vault.files.keys()].some((p) => p.startsWith(DEFAULT_INDEX_FOLDER)));
  assert.equal(await ix.sync(), 0);
});

test('a sidecar moves with its note when the note is renamed, and goes when it is deleted', async () => {
  const vault = new FakeVault();
  await dropLibrary(vault, await webLibrary());
  const ix = new Indexer(vault);
  const bytes = await vault.readBinary(vault.files.get('School/Forces.bedrock'));
  await ix.rename('School/Forces.bedrock', 'School/Motion.bedrock', bytes);
  assert.ok(!vault.files.has('School/Forces.bedrock.md'));
  assert.equal(noteOfIndex(vault.files.get('School/Motion.bedrock.md').data), 'School/Motion.bedrock');
  await ix.remove('School/Motion.bedrock');
  assert.ok(!vault.files.has('School/Motion.bedrock.md'));
  assert.ok(![...vault.files.keys()].some((p) => p.startsWith(DEFAULT_INDEX_FOLDER)));
});

function session(vault, file, extra = {}) {
  const kvStore = new Map();
  const calls = [];
  const s = createSession({
    vault,
    file: () => file,
    indexer: new Indexer(vault),
    kv: { get: (k) => kvStore.get(k), set: async (k, v) => { kvStore.set(k, v); } },
    listFiles: async (source) => { calls.push(['list', source]); return [{ path: 'Ideas.md', link: 'Ideas' }]; },
    openLink: (target, source) => calls.push(['open', target, source]),
    ...extra,
  });
  return { s, calls, kvStore };
}

test('session reads and writes the open file and keeps its index current', async () => {
  const vault = new FakeVault();
  const file = await vault.createBinary('Forces.bedrock', new ArrayBuffer(0));
  const { s } = session(vault, file);
  const r = await s.handlers.read({});
  assert.equal(r.name, 'Forces');
  assert.equal(r.data.byteLength, 0, 'a new note is empty');
  // A correction to what was read reaches search with the next save.
  await s.handlers.write({ data: new Uint8Array(note(['Newtn'])) });
  await s.flushIndex();
  assert.match(vault.files.get(`${DEFAULT_INDEX_FOLDER}/Forces.md`).data, /Newtn/);
  await s.handlers.write({ data: new Uint8Array(note(['Newton'])) });
  await s.flushIndex();
  assert.match(vault.files.get(`${DEFAULT_INDEX_FOLDER}/Forces.md`).data, /Newton\n/);
  assert.equal((await s.handlers.read({})).data.byteLength, note(['Newton']).byteLength);
});

/** A .bedrock with ink: `strokes` ids, their samples in points.bin, and tags. */
const inked = ({ strokes = ['a1'], samples = [1, 2, 3], tags = [], images = [], words = ['Newton'], v1 = false } = {}) => zip({
  'note.json': JSON.stringify({
    format: 'bedrock-note', version: v1 ? 1 : 2, tags, images,
    strokes: strokes.map((id) => ({ id, brush: { kind: 'pen', color: '#000000ff', size: 2 }, ...(v1 ? { points: samples } : {}) })),
  }),
  ...(v1 ? {} : { 'points.bin': new Uint8Array(samples) }),
  'recognized.json': recognized(...words),
});

test('a view-only session never renames the file, and writes it only with its ink exactly as it was', async () => {
  const vault = new FakeVault();
  const file = await vault.createBinary('Forces.bedrock', inked());
  const renamed = [];
  const { s } = session(vault, file, { viewOnly: true, rename: async (n) => { renamed.push(n); return n; } });
  assert.equal((await s.handlers.read({})).name, 'Forces', 'it still reads');
  assert.deepEqual(await s.handlers.rename({ title: 'Gravity' }), { name: 'Forces' });
  assert.deepEqual(renamed, []);
  const bytes = () => new Uint8Array(vault.files.get('Forces.bedrock').data);
  const before = bytes().slice();
  // Ink added, removed, its samples or brush changed, a picture added: refused.
  for (const changed of [
    inked({ strokes: ['a1', 'b2'] }), inked({ strokes: [] }), inked({ samples: [1, 2, 4] }),
    inked({ images: [{ id: 'p1' }] }), new Uint8Array([1, 2, 3]),
  ]) {
    await assert.rejects(s.handlers.write({ data: new Uint8Array(changed) }), new RegExp(VIEW_ONLY));
  }
  assert.deepEqual(bytes(), before);
  // Tags and a corrected reading, with the ink as it was: saved.
  const fixed = new Uint8Array(inked({ tags: ['physics'], words: ['Newton!'] }));
  assert.equal(await s.handlers.write({ data: fixed.slice() }), true);
  assert.deepEqual(bytes(), fixed);
  await s.flushIndex();
  assert.match(vault.files.get(`${DEFAULT_INDEX_FOLDER}/Forces.md`).data, /Newton!/);
  // A note from before points.bin (samples in note.json) saved with them in points.bin.
  const old = await vault.createBinary('Old.bedrock', inked({ v1: true }));
  const { s: s3 } = session(vault, old, { viewOnly: true });
  assert.equal(await s3.handlers.write({ data: new Uint8Array(inked({ tags: ['x'] })) }), true);
  // Looking around is kept: the camera still works.
  await s.handlers['set-kv']({ key: 'camera:host', value: [1, 2, 1] });
  assert.deepEqual(await s.handlers['get-kv']({ key: 'camera:host' }), [1, 2, 1]);

  // A new (empty) note: its starting links and tags are saved, ink never.
  const fresh = await vault.createBinary('Lecture 3 notes.bedrock', new ArrayBuffer(0));
  const { s: s2 } = session(vault, fresh, { viewOnly: true });
  await assert.rejects(s2.handlers.write({ data: new Uint8Array(inked()) }), new RegExp(VIEW_ONLY));
  assert.equal(await s2.handlers.write({ data: new Uint8Array(note([])) }), true);
  assert.equal(vault.files.get('Lecture 3 notes.bedrock').data.byteLength, note([]).byteLength);
});

test('session tells its own saves from changes made elsewhere', async () => {
  const vault = new FakeVault();
  const file = await vault.createBinary('Forces.bedrock', new ArrayBuffer(0));
  const { s } = session(vault, file);
  await s.handlers.write({ data: new Uint8Array(note(['a'])) });
  assert.equal(s.isOutsideChange(file), false);
  vault.outsideChange('Forces.bedrock', note(['b']));
  assert.equal(s.isOutsideChange(file), true);
  assert.equal(s.isOutsideChange({ stat: { mtime: 0 } }), false, 'other files are not ours');
});

test('a save that is still being written is never taken for an outside change', async () => {
  const vault = new FakeVault();
  const file = await vault.createBinary('Forces.bedrock', new ArrayBuffer(0));
  let seen = null;
  const real = vault.modifyBinary.bind(vault);
  const { s } = session(vault, file);
  // Obsidian fires "modify" from inside modifyBinary, before it returns.
  vault.modifyBinary = async (f, d) => { await real(f, d); seen = s.isOutsideChange(f); };
  await s.handlers.write({ data: new Uint8Array(note(['a'])) });
  assert.equal(seen, false);
});

test('one failed save does not stop later saves', async () => {
  const vault = new FakeVault();
  const file = await vault.createBinary('Forces.bedrock', new ArrayBuffer(0));
  const { s } = session(vault, file);
  const real = vault.modifyBinary.bind(vault);
  vault.modifyBinary = async () => { throw new Error('disk full'); };
  await assert.rejects(s.handlers.write({ data: new Uint8Array(note(['a'])) }), /disk full/);
  vault.modifyBinary = real;
  await s.handlers.write({ data: new Uint8Array(note(['b'])) });
  await s.flushIndex();
  assert.match(vault.files.get(`${DEFAULT_INDEX_FOLDER}/Forces.md`).data, /\bb\b/);
});

// Writing was slower in Obsidian than on the website: every autosave (every
// 400 ms of writing) also rewrote the index note, and Obsidian re-indexed it
// on the main thread the canvas shares with it.
test('while the writer keeps writing, the index note waits for a pause and is written once', async () => {
  const vault = new FakeVault();
  const file = await vault.createBinary('Forces.bedrock', new ArrayBuffer(0));
  const { s } = session(vault, file, { indexDelayMs: 60 });
  let indexWrites = 0;
  for (const m of ['create', 'modify']) {
    const real = vault[m].bind(vault);
    vault[m] = async (...a) => { indexWrites++; return real(...a); };
  }
  for (const w of ['F', 'Fo', 'For', 'Forc', 'Force']) {
    await s.handlers.write({ data: new Uint8Array(note([w])) });
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(indexWrites, 0, 'no index note while writing');
  assert.equal(vault.files.get('Forces.bedrock').data.byteLength, note(['Force']).byteLength, 'every save still reaches the file at once');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(indexWrites, 1, 'one index note after the pause');
  assert.match(vault.files.get(`${DEFAULT_INDEX_FOLDER}/Forces.md`).data, /Force\n/);
  // Closing the view writes a pending index at once.
  await s.handlers.write({ data: new Uint8Array(note(['Forces'])) });
  await s.flushIndex();
  assert.equal(indexWrites, 2);
  assert.match(vault.files.get(`${DEFAULT_INDEX_FOLDER}/Forces.md`).data, /Forces\n/);
  await s.flushIndex();
  assert.equal(indexWrites, 2, 'nothing pending: nothing written');
});

test('the app can ask for a link to a word; only real stroke ids are accepted', async () => {
  const vault = new FakeVault();
  const file = await vault.createBinary('Physics/Forces.bedrock', new ArrayBuffer(0));
  const copied = [];
  const { s } = session(vault, file, { copyLink: async (stroke, source) => { copied.push([stroke, source]); } });
  assert.equal(await s.handlers['copy-link']({ stroke: '9f2c4e1a7b3d5f60' }), true);
  assert.equal(await s.handlers['copy-link']({ stroke: ']] [[Other' }), false);
  assert.equal(await s.handlers['copy-link']({}), false);
  assert.deepEqual(copied, [['9f2c4e1a7b3d5f60', 'Physics/Forces.bedrock']]);
  // A host without a clipboard just says no.
  assert.equal(await session(vault, file).s.handlers['copy-link']({ stroke: 'ab' }), false);
});

test("a new note's starting link is handed to its canvas once", async () => {
  const vault = new FakeVault();
  const file = await vault.createBinary('Lecture 3 notes.bedrock', new ArrayBuffer(0));
  let start = { noteLinks: [{ target: 'Lecture 3', type: 'note', text: 'Lecture 3' }] };
  const { s } = session(vault, file, { start: () => { const v = start; start = null; return v; } });
  assert.deepEqual(await s.handlers.start(), { noteLinks: [{ target: 'Lecture 3', type: 'note', text: 'Lecture 3' }] });
  assert.equal(await s.handlers.start(), null);
  assert.equal(await session(vault, file).s.handlers.start(), null, 'a host without starting links');
});

test('a title becomes a file name Obsidian can link to', () => {
  assert.equal(fileNameFor('Forces'), 'Forces');
  assert.equal(fileNameFor('  Forces and   motion '), 'Forces and motion');
  assert.equal(fileNameFor('Week 3: forces/motion'), 'Week 3 forces motion');
  assert.equal(fileNameFor('a\\b*c?d"e<f>g|h#i^j[k]l'), 'a b c d e f g h i j k l');
  assert.equal(fileNameFor('...hidden'), 'hidden', 'no hidden files');
  assert.equal(fileNameFor('Chapter 1...'), 'Chapter 1', 'Windows drops trailing dots');
  assert.equal(fileNameFor('tab\there'), 'tab here');
  assert.equal(fileNameFor('Ünïcødé 名前'), 'Ünïcødé 名前');
  assert.equal(fileNameFor(' / : '), '');
  assert.equal(fileNameFor(''), '');
  assert.equal(fileNameFor(null), '');
  assert.equal(fileNameFor('x'.repeat(300)).length, 120);
});

test('the app can ask to rename the note; empty and unchanged names rename nothing', async () => {
  const vault = new FakeVault();
  const f = await vault.createBinary('Physics/Forces.bedrock', note(['Newton']));
  const asked = [];
  const s = createSession({
    vault, file: () => f, indexer: null, kv: { get() {}, set: async () => {} },
    rename: async (name) => { asked.push(name); return name === 'Taken' ? f.basename : name; },
  });
  assert.deepEqual(await s.handlers.rename({ title: 'Week 3: motion' }), { name: 'Week 3 motion' });
  assert.deepEqual(await s.handlers.rename({ title: 'Taken' }), { name: 'Forces' }, 'a refused rename answers the file name');
  assert.deepEqual(await s.handlers.rename({ title: '  ' }), { name: 'Forces' });
  assert.deepEqual(await s.handlers.rename({ title: 'Forces' }), { name: 'Forces' });
  assert.deepEqual(await s.handlers.rename({}), { name: 'Forces' });
  assert.deepEqual(asked, ['Week 3 motion', 'Taken'], 'empty and unchanged names are not asked for');
  const none = createSession({ vault, file: () => f, indexer: null, kv: { get() {}, set: async () => {} } });
  assert.deepEqual(await none.handlers.rename({ title: 'Other' }), { name: 'Forces' }, 'a host that cannot rename keeps the name');
});

test('renaming an empty note makes no index note', async () => {
  const vault = new FakeVault();
  const ix = new Indexer(vault);
  await vault.createBinary('Handwritten note.bedrock', new ArrayBuffer(0));
  await ix.rename('Handwritten note.bedrock', 'Forces.bedrock', new ArrayBuffer(0));
  assert.deepEqual(vault.getFiles().map((f) => f.path).filter((p) => p.endsWith('.md')), []);
});

test('session camera is kept per file; the link picker and links get the note path', async () => {
  const vault = new FakeVault();
  const a = await vault.createBinary('A.bedrock', new ArrayBuffer(0));
  const b = await vault.createBinary('B.bedrock', new ArrayBuffer(0));
  const sa = session(vault, a);
  const sb = session(vault, b, {});
  sb.kvStore.clear();
  await sa.s.handlers['set-kv']({ key: 'camera:4f2a', value: [1, 2, 3] });
  assert.deepEqual(await sa.s.handlers['get-kv']({ key: 'camera:other-id' }), [1, 2, 3], 'note ids inside the app do not matter');
  assert.equal(await sb.s.handlers['get-kv']({ key: 'camera:4f2a' }), null);
  assert.deepEqual(await sa.s.handlers['list-files'](), [{ path: 'Ideas.md', link: 'Ideas' }]);
  await sa.s.handlers['open-link']({ type: 'note', target: 'Ideas' });
  assert.deepEqual(sa.calls, [['list', 'A.bedrock'], ['open', 'Ideas', 'A.bedrock']]);
  // The picker may read other handwritten notes (for their picture), nothing else.
  await vault.createBinary('B2.bedrock', new Uint8Array([1, 2, 3]).buffer);
  await vault.create('Secret.md', 'text');
  assert.deepEqual([...new Uint8Array((await sa.s.handlers['read-note']({ path: 'B2.bedrock' })).data)], [1, 2, 3]);
  await assert.rejects(sa.s.handlers['read-note']({ path: 'Secret.md' }), /Not a handwritten note/);
  await assert.rejects(sa.s.handlers['read-note']({ path: 'Missing.bedrock' }), /Not a handwritten note/);
  await assert.rejects(sa.s.handlers['pdf-page']({ path: 'Paper.pdf', page: 1, width: 300 }), /Not a PDF/, 'no PDF renderer in this session');
});

/** Two fake windows joined like a page and its iframe. */
function windows() {
  const mk = () => ({ listeners: [], addEventListener(t, f) { this.listeners.push(f); }, removeEventListener(t, f) { this.listeners = this.listeners.filter((g) => g !== f); } });
  const parent = mk();
  const frame = mk();
  frame.postMessage = (data) => queueMicrotask(() => frame.listeners.forEach((f) => f({ data: structuredClone(data), source: parent })));
  parent.postMessage = (data, _o, src = frame) => queueMicrotask(() => parent.listeners.forEach((f) => f({ data: structuredClone(data), source: src })));
  return { parent, frame };
}

test('bridge answers the app and ignores other windows', async () => {
  const { parent, frame } = windows();
  const bridge = new HostBridge(() => frame, { read: async () => ({ name: 'x' }), boom: async () => { throw new Error('nope'); } });
  bridge.listen(parent);
  const replies = [];
  frame.addEventListener('message', (e) => replies.push(e.data));
  parent.postMessage({ bedrock: 1, seq: 1, method: 'read', args: {} });
  parent.postMessage({ bedrock: 1, seq: 2, method: 'boom', args: {} });
  parent.postMessage({ bedrock: 1, seq: 3, method: 'missing' });
  parent.postMessage({ bedrock: 1, seq: 4, method: 'read' }, '*', { other: true });
  parent.postMessage({ hello: 1 });
  await new Promise((r) => setTimeout(r, 10));
  replies.sort((a, b) => a.reply - b.reply);
  assert.deepEqual(replies, [
    { bedrock: 1, reply: 1, result: { name: 'x' }, error: null },
    { bedrock: 1, reply: 2, result: null, error: 'nope' },
    { bedrock: 1, reply: 3, result: null, error: 'unknown request missing' },
  ]);
  bridge.close();
});

test('bridge events get the app\'s answer, or null when it does not answer', async () => {
  const { parent, frame } = windows();
  const bridge = new HostBridge(() => frame, {});
  bridge.listen(parent);
  frame.addEventListener('message', (e) => {
    if (e.data.event === 'flush') parent.postMessage({ bedrock: 1, reply: e.data.seq, result: 'saved' });
  });
  assert.equal(await bridge.send('flush'), 'saved');
  assert.equal(await bridge.send('ignored', {}, 20), null);
  assert.equal(await new HostBridge(() => null, {}).send('flush'), null, 'no iframe yet');
});

// Each note open (and its save worker) compiled the 2.2 MB WebAssembly
// again: blob: URLs get no compiled-code cache. The plugin compiles it once.
test('the WebAssembly is compiled once while the plugin runs, and the session hands it to each canvas', async () => {
  const empty = btoa(String.fromCharCode(0, 97, 115, 109, 1, 0, 0, 0)); // the smallest valid module
  const app = new InlineApp({ pages: {}, modules: {}, workers: {}, files: { 'pkg/bedrock_web_bg.wasm': empty } });
  const compile = WebAssembly.compile;
  let compiles = 0;
  WebAssembly.compile = (...a) => { compiles++; return compile(...a); };
  try {
    const first = await app.wasmModule();
    assert.ok(first instanceof WebAssembly.Module);
    assert.equal(await app.wasmModule(), first, 'the same module for the next note');
    const vault = new FakeVault();
    const file = await vault.createBinary('Forces.bedrock', new ArrayBuffer(0));
    const { s } = session(vault, file, { wasm: () => app.wasmModule() });
    assert.equal(await s.handlers.wasm({}), first, 'the canvas asks for it over the bridge');
    assert.equal(compiles, 1);
    assert.equal(await session(vault, file).s.handlers.wasm({}), null, 'no module: the canvas compiles its own');
    app.revoke();
    await app.wasmModule();
    assert.equal(compiles, 2, 'compiled again after the plugin is reloaded');
  } finally {
    WebAssembly.compile = compile;
  }
});

test('the canvas pages are written with their files handed over as blob: URLs, never loaded by address', async () => {
  const made = [];
  const revoked = [];
  const urls = {
    createObjectURL: (blob) => { made.push(blob); return `blob:test/${made.length}`; },
    revokeObjectURL: (u) => revoked.push(u),
  };
  const bundle = {
    hash: 'v1',
    pages: { app: `<head>${GLOBALS_MARK}</head><body>${MODULE_MARK}</body>`, welcome: `<head>${GLOBALS_MARK}</head>${MODULE_MARK}` },
    modules: { app: 'app();', welcome: 'welcome();' },
    workers: { 'src/save-worker.js': 'save();' },
    files: { 'pkg/bedrock_web_bg.wasm': btoa('\0asm'), 'dict/en.aff': btoa('SET UTF-8 </script>') },
  };
  const app = new InlineApp(bundle, { urls });
  const html = app.page('app');
  const assets = JSON.parse(html.match(/BEDROCK_ASSETS = (\{.*?\});/)[1]);
  assert.deepEqual(Object.keys(assets).sort(), ['dict/en.aff', 'pkg/bedrock_web_bg.wasm', 'src/save-worker.js']);
  assert.match(html, /BEDROCK_HOST = "obsidian"; globalThis.BEDROCK_PROBE = false;/);
  assert.match(html, /<script type="module" src="blob:test\/\d+"><\/script><\/body>/);
  assert.doesNotMatch(html, /bedrock:(globals|module)/);
  const blobOf = (u) => made[Number(u.split('/').pop()) - 1];
  const wasm = blobOf(assets['pkg/bedrock_web_bg.wasm']);
  assert.equal(wasm.type, 'application/wasm');
  assert.deepEqual([...new Uint8Array(await wasm.arrayBuffer())], [0, 97, 115, 109]);
  const worker = await blobOf(assets['src/save-worker.js']).text();
  assert.match(worker, /^globalThis\.BEDROCK_ASSETS = \{"pkg\/bedrock_web_bg\.wasm":"blob:test\/1"/, 'the worker is told where the WebAssembly is');
  assert.ok(worker.endsWith('save();'));
  assert.match(app.page('welcome', { probe: true }), /BEDROCK_PROBE = true;/);
  assert.match(html, /BEDROCK_VIEW_ONLY = false;/);
  assert.match(app.page('app', { viewOnly: true }), /BEDROCK_VIEW_ONLY = true;/);
  assert.equal(made.length, 5, 'blob: URLs are made once');
  app.revoke();
  assert.equal(revoked.length, 5);
  assert.throws(() => app.page('nope'), /no nope page/);
});

test('the plugin packs the current web app, host adapter and WebAssembly included', async () => {
  const b = await packWebApp();
  assert.deepEqual(Object.keys(b.pages), ['app', 'welcome']);
  for (const page of Object.values(b.pages)) {
    assert.ok(page.includes(GLOBALS_MARK) && page.includes(MODULE_MARK));
    assert.doesNotMatch(page, /<(?:script|link)[^>]+(?:src|href)="(?!https?:)/, 'nothing is loaded by its address');
  }
  assert.match(b.pages.app, /<style>[\s\S]*\.toolbar/, 'the stylesheet is inline');
  assert.match(b.pages.app, /bedrockErrors/, 'errors.js is inline');
  assert.match(b.modules.app, /HostStore/, 'the host adapter is bundled into the app module');
  assert.match(b.modules.app, /BEDROCK_ASSETS/);
  assert.doesNotMatch(b.modules.app, /^import .* from ['"]\./m, 'one module, no imports of neighbours');
  assert.deepEqual(Object.keys(b.workers), ['src/save-worker.js', 'src/recognizer-worker.js']);
  for (const f of ['pkg/bedrock_web_bg.wasm', 'pkg/bedrock_pdf_bg.wasm', 'dict/en.aff', 'dict/en.dic.gz']) assert.ok(b.files[f], `${f} is packed`);
  assert.match(b.pluginWorkers['src/pdf-import-worker.js'], /import_pdf_as_one_note/, "the plugin's own PDF import worker is packed, apart from the web app's");
  assert.match(b.modules.app, /bedrock_pdf_bg\.wasm/, 'PDF import finds its WebAssembly among the handed over files');
  assert.equal(b.hash, (await packWebApp()).hash, 'the version hash is stable');
});

test('the plugin error log keeps file names only, counts repeats and builds a report the backend takes', () => {
  const log = new ErrorLog();
  const err = new Error('boom');
  err.stack = 'Error: boom\n    at load (app://obsidian.md/Users/frederik/Vault/.obsidian/plugins/bedrock-notes/main.js:12:3)';
  log.record('could not write /Users/frederik/Vault/Diary.bedrock', err);
  log.record('could not write /Users/frederik/Vault/Diary.bedrock', err);
  log.record('index not updated', null, 'error');
  const e = log.entries();
  assert.equal(e.length, 2);
  assert.deepEqual([e[0].kind, e[0].message, e[0].count], ['shown', 'could not write Diary.bedrock', 2]);
  assert.equal(e[0].stack, 'Error: boom\nat load (main.js:12:3)');
  const r = log.report({ comment: 'while syncing', appVersion: '0.1.0', now: 1794421375000 });
  assert.equal(r.format, 'bedrock-error-report');
  assert.equal(r.version, 1);
  assert.equal(r.app, 'obsidian');
  assert.equal(r.stage, 'running');
  assert.equal(r.created, 1794421375000);
  assert.equal(r.comment, 'while syncing');
  assert.deepEqual(r.errors.map((x) => x.count ?? 1), [2, 1]);
  assert.doesNotMatch(JSON.stringify(r), /frederik|Vault/);
});

test('reports are sent with requestUrl, and failures say what to do', async () => {
  assert.equal(reportsAddress(''), '', 'no backend address yet: nothing is sent');
  assert.equal(reportsAddress('http://example.com'), '', 'never in the clear');
  const url = reportsAddress('https://bedrock.example');
  assert.equal(url, 'https://bedrock.example/v1/reports');
  const calls = [];
  const ok = async (req) => { calls.push(req); return { status: 200, json: { id: 'r1' } }; };
  assert.equal(await sendReport({ id: 'r1' }, ok, url), 'r1');
  assert.deepEqual(calls[0], { url, method: 'POST', contentType: 'application/json', body: '{"id":"r1"}', throw: false });
  await assert.rejects(sendReport({ id: 'r' }, async () => ({ status: 429, json: {} }), url), /Too many reports/);
  await assert.rejects(sendReport({ id: 'r' }, async () => ({ status: 400, json: { detail: 'app is "web" or "obsidian"' } }), url), /refused \(app is/);
  await assert.rejects(sendReport({ id: 'r' }, async () => { throw new Error('offline'); }, url), /Could not reach/);
  await assert.rejects(sendReport({ id: 'r' }, ok, ''), /not switched on/);
});

test('the canvas sends its error reports through the plugin', async () => {
  const vault = new FakeVault();
  const sent = [];
  const session = createSession({ vault, file: () => null, kv: {}, openLink: () => {}, sendReport: async (r) => { sent.push(r); return r.id; } });
  assert.deepEqual(await session.handlers['send-report']({ report: { id: 'x' } }), { id: 'x' });
  assert.deepEqual(sent, [{ id: 'x' }]);
  const none = createSession({ vault, file: () => null, kv: {}, openLink: () => {} });
  await assert.rejects(none.handlers['send-report']({ report: { id: 'x' } }), /not switched on/);
});

test('slow reads, writes and index updates are logged with what was running', async () => {
  const vault = new FakeVault();
  const file = await vault.createBinary('Forces.bedrock', new ArrayBuffer(0));
  const log = new ErrorLog();
  let t = 0;
  const perf = pluginWatcher(log, { mobile: true }).configure({ now: () => t });
  const slowVault = Object.create(vault);
  slowVault.modifyBinary = async (f, buf) => { t += 2500; return vault.modifyBinary(f, buf); };
  const s = createSession({ vault: slowVault, file: () => file, indexer: null, kv: {}, openLink: () => {}, perf });
  await s.handlers.read({});
  assert.equal(log.entries().length, 0, 'a quick read is not logged');
  await s.handlers.write({ data: new Uint8Array(note(['Newton'])) });
  await s.handlers.write({ data: new Uint8Array(note(['Newton'])) });
  const slow = log.entries();
  assert.equal(slow.length, 1, 'repeats within 30 s add to one entry');
  assert.equal(slow[0].kind, 'slow');
  assert.equal(slow[0].what, 'long_job');
  assert.equal(slow[0].message, 'Plugin: A job took long: write');
  assert.equal(slow[0].count, 2);
  assert.equal(slow[0].ms, 2500);
  assert.equal(slow[0].snapshot.doing, 'mobile');
  assert.deepEqual(slow[0].snapshot.running.map((j) => j.job), ['write']);
});

test("the plugin's slow moments go with the canvas's automatic reports, once, and never into a person's", () => {
  const log = new ErrorLog();
  log.record('Bedrock: search index not renamed', new Error('x'), 'error');
  log.slow({ what: 'long_job', ms: 3200, message: 'A job took long: index' }, 1000);
  const canvas = { format: 'bedrock-error-report', version: 2, sent: 'auto', id: 'a', errors: [{ kind: 'slow', what: 'stutter', ms: 140, message: 'Bedrock stuttered', at: 500 }], context: { webgl2: true } };
  const { report, last } = withPluginSlow(canvas, log, { mobile: true });
  assert.deepEqual(report.errors.map((e) => e.message), ['Bedrock stuttered', 'Plugin: A job took long: index'], 'slow entries only, oldest first');
  assert.deepEqual(report.context, { webgl2: true, mobile: true });
  assert.equal(last, 1000);
  assert.deepEqual(withPluginSlow(canvas, log, { since: last }).report.errors.length, 1, 'not sent twice');
  const person = { ...canvas, sent: 'person' };
  assert.equal(withPluginSlow(person, log).report, person, 'a report the person saw goes as they saw it');
});

// Bug: the link picker found no words in notes saved since points.bin
// (note format version 2): it looked for the samples in note.json only.
test('the link picker finds the words of notes with their samples in points.bin, and of older notes', async () => {
  const channels = ['x', 'y', 'pressure'];
  const strokes = [
    { id: 'a1', points: [10.5, -20.25, 0.5, 300.125, 40, 0.75] },
    { id: 'b2', points: [-5, 7.001, 1, 8, 9, 0.25] },
    { id: 'c3', points: [100, 100, 0.5] },
  ];
  // points.bin as docs/note-format.md describes it (3 decimals each).
  const leb = (v, signed) => {
    const out = [];
    for (;;) {
      const b = v & 0x7f;
      v = Math.floor(v / 128);
      const done = signed ? (v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40)) : v === 0;
      out.push(done ? b : b | 0x80);
      if (done) return out;
    }
  };
  const bin = [...new TextEncoder().encode('BDPT'), ...leb(1), ...leb(channels.length)];
  for (const c of channels) bin.push(...leb(c.length), ...new TextEncoder().encode(c), ...leb(3));
  // The last stroke keeps its points in note.json: no record.
  bin.push(...leb(2));
  for (const s of strokes.slice(0, 2)) {
    bin.push(...leb(s.points.length / 3));
    const prev = [0, 0, 0];
    s.points.forEach((v, i) => { const k = Math.round(v * 1000); bin.push(...leb(k - prev[i % 3], true)); prev[i % 3] = k; });
  }
  assert.deepEqual(readPointsBin(Uint8Array.from(bin)), strokes.slice(0, 2).map((s) => s.points));
  const svg = '<svg viewBox="0 0 400 400"></svg>';
  const rec = JSON.stringify({ format: 'bedrock-recognition', version: 1, items: [{ id: 'r1', text: 'Newton', strokes: ['a1', 'b2'] }, { id: 'r2', text: 'x', strokes: ['c3'] }] });
  const v1 = zip({ 'note.json': JSON.stringify({ format: 'bedrock-note', version: 1, channels, strokes }), 'recognized.json': rec, 'preview.svg': svg });
  const v2 = zip({
    'note.json': JSON.stringify({ format: 'bedrock-note', version: 2, channels, pointsFile: 'points.bin', strokes: [{ id: 'a1' }, { id: 'b2' }, strokes[2]] }),
    'points.bin': Uint8Array.from(bin),
    'recognized.json': rec,
    'preview.svg': svg,
  });
  const before = await notePicture(new Uint8Array(v1));
  const after = await notePicture(new Uint8Array(v2));
  assert.deepEqual(before.words, [
    { text: 'Newton', stroke: 'a1', bounds: [-5, -20.25, 300.125, 40] },
    { text: 'x', stroke: 'c3', bounds: [100, 100, 100, 100] },
  ]);
  assert.deepEqual(after.words, before.words);
  assert.throws(() => readPointsBin(Uint8Array.from(bin.slice(0, -1))), /ends early/);
});

// Dark mode (openspec dark-mode): the canvas's chrome follows Obsidian's
// theme, which can differ from the system's.
test("the canvas's chrome follows Obsidian's theme, set before the page paints and changed live", () => {
  const bundle = { pages: { app: `<html><head>${GLOBALS_MARK}</head><body>${MODULE_MARK}</body></html>` }, modules: { app: 'app();' }, workers: {}, files: {} };
  const urls = { createObjectURL: () => 'blob:test/1', revokeObjectURL() {} };
  let theme = 'dark';
  const app = new InlineApp(bundle, { urls, theme: () => theme });
  assert.match(app.page('app'), /<head><script>[^<]*document\.documentElement\.dataset\.theme = "dark";<\/script>/, 'in the head, before anything paints');
  theme = 'light';
  assert.match(app.page('app'), /dataset\.theme = "light";/);
  assert.doesNotMatch(new InlineApp(bundle, { urls }).page('app'), /dataset\.theme/, 'no host theme: the page follows the system');

  const body = (cls) => ({ classList: { contains: (c) => c === cls } });
  assert.equal(obsidianTheme(body('theme-dark')), 'dark');
  assert.equal(obsidianTheme(body('theme-light')), 'light');
  assert.equal(obsidianTheme(undefined), 'light');

  const frame = () => ({ contentDocument: { documentElement: { dataset: {} } } });
  const a = frame();
  const b = frame();
  const blocked = { get contentDocument() { throw new Error('cross-origin'); } };
  tellTheme([a, null, { contentDocument: null }, blocked, b], 'dark');
  assert.equal(a.contentDocument.documentElement.dataset.theme, 'dark');
  assert.equal(b.contentDocument.documentElement.dataset.theme, 'dark', 'a frame it cannot reach is skipped, not fatal');
});

test("a PDF search's matches name the passage in the page's text items, as Obsidian's selection links count them", async () => {
  const { pageText, selectionOf, findInText, fromItemsOnly } = await import('../src/pdf-pages.js');
  const page = pageText([{ str: 'The second law', hasEOL: true }, { str: '', hasEOL: true }, { str: 'of motion.', hasEOL: false }]);
  assert.equal(page.text, 'The second law\n\nof motion.');
  const [hit] = findInText(page.text, 'law of');
  assert.deepEqual(hit, [11, 7]);
  // From "law" in the first item to "of" in the third (the empty one between is skipped).
  assert.deepEqual(selectionOf(page.starts, page.items, hit[0], hit[0] + hit[1]), [0, 11, 2, 2]);
  // PDF.js's find controller counts without the line breaks.
  assert.deepEqual(fromItemsOnly(page, [11, 5]), hit);
  // Hyphens at a line's end, accents, case and runs of spaces.
  assert.deepEqual(findInText('An inter-\naction', 'INTERACTION'), [[3, 13]]);
  assert.deepEqual(findInText('Ein Café', 'cafe'), [[4, 4]]);
  assert.deepEqual(findInText('a  b', ' '), []);
});

test('the canvas may search PDFs only, for a short text', async () => {
  const vault = new FakeVault();
  const asked = [];
  const s = createSession({ vault, file: () => ({ path: 'A.bedrock' }), kv: { get() {}, async set() {} }, pdfFind: async (p, q) => { asked.push([p, q]); return { count: 1, total: 0, hits: [] }; } });
  assert.deepEqual(await s.handlers['pdf-find']({ path: 'P/Paper.pdf', query: 'law' }), { count: 1, total: 0, hits: [] });
  await assert.rejects(s.handlers['pdf-find']({ path: 'Notes.md', query: 'law' }), /Not a PDF/);
  await assert.rejects(s.handlers['pdf-find']({ path: 'P/Paper.pdf', query: 'x'.repeat(201) }), /200 letters/);
  assert.deepEqual(asked, [['P/Paper.pdf', 'law']]);
});

test('every tag in the vault is offered for the tag box: Markdown notes and index notes, counted per note, without bedrock', async () => {
  const { vaultTags } = await import('../src/tags.js');
  const { getAllTags } = (await import('./fake-obsidian.cjs')).default;
  const caches = new Map([
    ['Lecture 3.md', { tags: [{ tag: '#physics/forces' }, { tag: '#Exam' }], frontmatter: { tags: ['biology'] } }],
    ['Bedrock index/Notes.md', { frontmatter: { tags: ['bedrock', 'Biology', 'exam'] } }],
    ['Empty.md', null],
  ]);
  const app = {
    vault: { getMarkdownFiles: () => [...caches.keys()].map((path) => ({ path })) },
    metadataCache: { getFileCache: (f) => caches.get(f.path) },
  };
  assert.deepEqual(vaultTags(app, getAllTags), [
    { tag: 'biology', count: 2 },
    { tag: 'physics/forces', count: 1 },
    { tag: 'Exam', count: 2 },
  ]);
  const session = createSession({ vault: new FakeVault(), file: () => null, kv: new Map(), listTags: async () => [{ tag: 'x', count: 1 }] });
  assert.deepEqual(await session.handlers['list-tags'](), [{ tag: 'x', count: 1 }]);
  assert.deepEqual(await createSession({ vault: new FakeVault(), file: () => null, kv: new Map() }).handlers['list-tags'](), []);
});

test("a PDF's text is read once for search; later searches only match", async () => {
  const { PdfPages } = await import('../src/pdf-pages.js');
  const read = [];
  const texts = ['Newton wrote about forces.', 'The second law of motion.', 'A force changes motion.'];
  let bytesRead = 0;
  const pages = new PdfPages({
    pdfjs: async () => ({ getDocument: () => ({ promise: Promise.resolve({
      numPages: 3,
      getPage: async (n) => ({ getTextContent: async () => { read.push(n); return { items: [{ str: texts[n - 1] }] }; } }),
    }) }) }),
    // The bytes only when the PDF is opened, not for every request.
    read: async () => ({ version: 1, bytes: async () => { bytesRead++; return new ArrayBuffer(4); } }),
    viewer: () => null,
  });
  assert.deepEqual(await pages.find('P.pdf', ''), { count: 3, total: 0, hits: [] });
  assert.deepEqual((await pages.find('P.pdf', 'force')).hits.map((h) => h.page), [1, 3]);
  assert.deepEqual((await pages.find('P.pdf', 'motion')).hits.map((h) => h.page), [2, 3]);
  assert.equal((await pages.find('P.pdf', 'motion')).total, 2);
  assert.deepEqual(read, [1, 2, 3], 'each page read once');
  assert.equal(bytesRead, 1);
});

// Bulk PDF import from the settings (openspec bulk-import-pdfs-in-obsidian).

/** A dropped file: `read` counts how many are being read at once. */
function dropped(name, { bytes = '%PDF-1.4 x', fail = null, reads = null } = {}) {
  return {
    name,
    read: async () => {
      if (reads) { reads.now++; reads.most = Math.max(reads.most, reads.now); }
      await new Promise((r) => setTimeout(r, 1));
      if (reads) reads.now--;
      if (fail) throw new Error(fail);
      return new TextEncoder().encode(bytes).buffer;
    },
  };
}

/** What the PDF reader gives back: a note's bytes, or null (nothing to import). */
const pdfNote = (text = 'note') => ({ bedrock: new TextEncoder().encode(text), warnings: [], strokes: 3 });

test('bulk PDF import: each PDF becomes a note at the vault root named after it, and never overwrites a file', async () => {
  const vault = new FakeVault();
  await vault.createBinary('Physics.bedrock', new TextEncoder().encode('mine').buffer);
  await vault.createFolder('Term 1');
  await vault.createBinary('Term 1/Chemistry.bedrock', new ArrayBuffer(1));
  const indexed = [];
  const job = new BulkImport({ vault, convert: async () => pdfNote(), index: async (path) => indexed.push(path) });
  job.add([dropped('Physics.pdf'), dropped('physics.PDF'), { ...dropped('Physics.pdf'), path: 'Term 1/Physics.pdf' }, dropped('Chemistry.pdf'), dropped('Week 3: forces?.pdf')]);
  const s = await job.finished();
  assert.deepEqual(s.imported.map((i) => i.path), ['Physics 1.bedrock', 'physics 2.bedrock', 'Physics 3.bedrock', 'Chemistry.bedrock', 'Week 3  forces.bedrock']);
  assert.deepEqual(s.failed, []);
  assert.equal(new TextDecoder().decode(vault.files.get('Physics.bedrock').data), 'mine', 'nothing is overwritten');
  assert.equal(vault.files.get('Term 1/Chemistry.bedrock').data.byteLength, 1, 'a note of that name in a folder is left alone');
  assert.equal(new TextDecoder().decode(vault.files.get('Chemistry.bedrock').data), 'note');
  assert.deepEqual(indexed, s.imported.map((i) => i.path), 'each new note is indexed');

  // A name taken after the import started (made meanwhile) is skipped too.
  const racing = new FakeVault();
  const create = racing.createBinary.bind(racing);
  racing.createBinary = async (path, data) => {
    if (path === 'Maths.bedrock' && !racing.files.has(path)) await create(path, new ArrayBuffer(2));
    return create(path, data);
  };
  const again = new BulkImport({ vault: racing, convert: async () => pdfNote() });
  again.add([dropped('Maths.pdf')]);
  assert.deepEqual((await again.finished()).imported.map((i) => i.path), ['Maths 1.bedrock']);
  assert.equal(racing.files.get('Maths.bedrock').data.byteLength, 2);
});

test('bulk PDF import: a PDF that fails is listed with its reason, and the others are still imported', async () => {
  const vault = new FakeVault();
  const create = vault.createBinary.bind(vault);
  vault.createBinary = async (path, data) => { if (path.startsWith('Full')) throw new Error('No space left on device'); return create(path, data); };
  const convert = async (bytes) => {
    const t = new TextDecoder().decode(bytes);
    if (t.includes('locked')) throw new Error('this PDF is locked with a password');
    if (t.includes('blank')) return null;
    return pdfNote(t);
  };
  const job = new BulkImport({ vault, convert, index: async () => { throw new Error('index broke'); } });
  job.add([
    dropped('A.pdf'),
    dropped('Locked.pdf', { bytes: '%PDF locked' }),
    dropped('Blank.pdf', { bytes: '%PDF blank' }),
    dropped('notes.txt', { bytes: 'hello' }),
    dropped('Renamed.pdf', { bytes: 'PK zip really' }),
    dropped('Gone.pdf', { fail: 'NotFoundError' }),
    dropped('Full.pdf'),
    dropped('B.pdf'),
  ]);
  const s = await job.finished();
  assert.deepEqual(s.imported.map((i) => i.path), ['A.bedrock', 'B.bedrock']);
  assert.deepEqual(s.failed.map((f) => [f.name, f.reason]), [
    ['Locked.pdf', 'this PDF is locked with a password'],
    ['Blank.pdf', 'no handwriting or pictures found'],
    ['notes.txt', 'not a PDF'],
    ['Renamed.pdf', 'not a PDF'],
    ['Gone.pdf', 'could not be read (NotFoundError)'],
    ['Full.pdf', 'could not be saved (No space left on device)'],
  ]);
  assert.match(s.imported[0].warnings.join(), /not added to search/, 'a note whose index failed is still imported, with a warning');
  assert.equal(s.done, 8);
  assert.equal(s.total, 8);
  assert.equal(s.running, false);
});

test('bulk PDF import: hundreds of PDFs are read one at a time, with progress, letting Obsidian run between files', async () => {
  const vault = new FakeVault();
  const reads = { now: 0, most: 0 };
  let converting = 0;
  let mostConverting = 0;
  const convert = async () => {
    converting++;
    mostConverting = Math.max(mostConverting, converting);
    await new Promise((r) => setTimeout(r, 0));
    converting--;
    return pdfNote();
  };
  const seen = [];
  const done = [];
  const job = new BulkImport({ vault, convert, onDone: (s) => done.push(s) });
  job.subscribe((s) => seen.push(s.done));
  const files = Array.from({ length: 300 }, (_, i) => dropped(`Notebook ${i}.pdf`, { reads }));
  job.add(files.slice(0, 150));
  // Obsidian's own work: a timer that should fire between files.
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  job.add(files.slice(150)); // a second drop while the first is under way joins it
  const s = await job.finished();
  clearInterval(timer);
  assert.equal(s.imported.length, 300);
  assert.equal(s.total, 300);
  assert.equal(reads.most, 1, 'one file read at a time');
  assert.equal(mostConverting, 1, 'one PDF converted at a time');
  assert.ok(ticks >= 100, `Obsidian ran between files (${ticks} ticks)`);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], 'progress only goes up');
  assert.ok(new Set(seen).size >= 300, 'progress after every file');
  assert.equal(done.length, 1, 'told once when it is done');
  assert.equal(done[0].imported.length, 300);
  // A new drop after that starts a new count.
  job.add([dropped('Late.pdf')]);
  const late = await job.finished();
  assert.equal(late.total, 1);
  assert.deepEqual(late.imported.map((i) => i.path), ['Late.bedrock']);
});

test('bulk PDF import: Stop keeps the notes already made and lists the rest as not imported', async () => {
  const vault = new FakeVault();
  let job;
  let n = 0;
  const convert = async () => { if (++n === 3) job.stop(); return pdfNote(); };
  job = new BulkImport({ vault, convert });
  job.add(Array.from({ length: 10 }, (_, i) => dropped(`P${i}.pdf`)));
  const s = await job.finished();
  assert.deepEqual(s.imported.map((i) => i.path), ['P0.bedrock', 'P1.bedrock', 'P2.bedrock'], 'the PDF being read is finished');
  assert.equal(s.failed.length, 7);
  assert.deepEqual(new Set(s.failed.map((f) => f.reason)), new Set(['stopped']));
  assert.equal(s.stopped, true);
  assert.equal(n, 3, 'nothing more is read');
});

/** A stand-in for the PDF reader's Worker. `answer(msg)` returns the reply,
 *  'hang' to never answer, or 'crash' to fail as a crashed worker does. */
function fakeWorkers(answer) {
  const made = [];
  const start = async () => {
    const w = {
      terminated: false,
      sent: [],
      postMessage(msg) {
        w.sent.push(msg);
        const a = answer(msg, made.length);
        if (a === 'hang') return;
        setTimeout(() => (a === 'crash' ? w.onerror?.({ message: 'out of memory' }) : w.onmessage?.({ data: { id: msg.id, ...a } })), 1);
      },
      terminate() { w.terminated = true; },
    };
    made.push(w);
    return w;
  };
  return { made, start };
}

test('bulk PDF import: a PDF the reader hangs or crashes on is given up, and the reader is started afresh', async () => {
  const kind = (msg) => new TextDecoder().decode(msg.bytes);
  const { made, start } = fakeWorkers((msg) => {
    const t = kind(msg);
    if (t.includes('hang')) return 'hang';
    if (t.includes('crash')) return 'crash';
    if (t.includes('empty')) return { page: null };
    return { page: { bedrock: new TextEncoder().encode('note').buffer, warnings: ['one picture left out'], strokes: 2 } };
  });
  const reader = new PdfReader({ start, timeoutMs: 30, freshEvery: 3 });
  const bytes = (t) => new TextEncoder().encode(t).buffer;
  const page = await reader.convert(bytes('%PDF ok'));
  assert.equal(new TextDecoder().decode(page.bedrock), 'note');
  assert.deepEqual(page.warnings, ['one picture left out']);
  assert.equal(made[0].sent[0].bytes.byteLength, 7, 'the bytes are handed over');
  assert.equal(made[0].sent[0].paper, 'grid', 'the note is on grid unless the settings choose another paper');
  assert.equal(await reader.convert(bytes('%PDF empty')), null);
  await assert.rejects(reader.convert(bytes('%PDF hang')), /did not finish reading this PDF/);
  assert.ok(made[0].terminated, 'the stuck reader is stopped');
  assert.ok(await reader.convert(bytes('%PDF ok')), 'a new reader reads the next PDF');
  assert.equal(made.length, 2);
  await assert.rejects(reader.convert(bytes('%PDF crash')), /reader stopped \(out of memory\)/);
  assert.ok(made[1].terminated);
  for (let i = 0; i < 4; i++) await reader.convert(bytes('%PDF ok'));
  assert.equal(made.length, 4, 'and started afresh every 3 PDFs, so its memory is given back');
  assert.ok(made[2].terminated);
  reader.close();
  assert.ok(made[3].terminated, 'closed with the plugin');
  let paper = 'dots';
  const onDots = new PdfReader({ start, paper: () => paper });
  await onDots.convert(bytes('%PDF ok'));
  paper = 'plain';
  await onDots.convert(bytes('%PDF ok'));
  assert.deepEqual(made.at(-1).sent.map((m) => m.paper), ['dots', 'plain'], 'each PDF is read onto the paper for new notes at that time');
  onDots.close();

  // In the queue: the hung PDF is listed and the rest go on.
  const vault = new FakeVault();
  const job = new BulkImport({ vault, convert: (b) => reader.convert(b) });
  job.add([dropped('Hang.pdf', { bytes: '%PDF hang' }), dropped('Ok.pdf')]);
  const s = await job.finished();
  assert.deepEqual(s.imported.map((i) => i.path), ['Ok.bedrock']);
  assert.match(s.failed[0].reason, /did not finish reading this PDF/);
  reader.close();
});

test('bulk PDF import: a dropped folder is searched for its files, in its folders too', async () => {
  const file = (name) => ({ name, arrayBuffer: async () => new TextEncoder().encode(name).buffer });
  const fileEntry = (path) => ({ isFile: true, fullPath: `/${path}`, file: (ok) => ok(file(path.split('/').pop())) });
  // readEntries answers in batches until an empty one, as browsers do.
  const dirEntry = (children) => {
    const batches = [children.slice(0, 2), children.slice(2), []];
    return { isDirectory: true, createReader: () => ({ readEntries: (ok) => ok(batches.shift() || []) }) };
  };
  const library = dirEntry([
    fileEntry('GoodNotes/Physics.pdf'),
    dirEntry([fileEntry('GoodNotes/Term 1/Maths.pdf'), fileEntry('GoodNotes/Term 1/Cover.png')]),
    fileEntry('GoodNotes/Chemistry.pdf'),
  ]);
  const dt = {
    items: [
      { kind: 'file', webkitGetAsEntry: () => library, getAsFile: () => null },
      { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => file('Loose.pdf') },
      { kind: 'string', getAsFile: () => null },
    ],
  };
  const files = await droppedFiles(dt);
  assert.deepEqual(files.map((f) => f.path), ['GoodNotes/Physics.pdf', 'GoodNotes/Term 1/Maths.pdf', 'GoodNotes/Term 1/Cover.png', 'GoodNotes/Chemistry.pdf', 'Loose.pdf']);
  assert.equal(new TextDecoder().decode(await files[1].read()), 'Maths.pdf', 'read only when asked');
  // Where the browser gives only a list of files.
  assert.deepEqual((await droppedFiles({ files: [file('A.pdf')] })).map((f) => f.name), ['A.pdf']);
  // All of them land at the root; the picture is listed as not a PDF.
  const vault = new FakeVault();
  const job = new BulkImport({ vault, convert: async () => pdfNote() });
  job.add(files.map((f) => ({ ...f, read: async () => new TextEncoder().encode('%PDF-1.7').buffer })));
  const s = await job.finished();
  assert.deepEqual(s.imported.map((i) => i.path), ['Physics.bedrock', 'Maths.bedrock', 'Chemistry.bedrock', 'Loose.bedrock']);
  assert.deepEqual(s.failed, [{ name: 'Cover.png', reason: 'not a PDF' }]);
});
