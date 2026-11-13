// Unit tests of the plugin's Obsidian-free parts, with an in-memory vault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { FakeVault } from './fake-vault.mjs';
import { readZip, text } from '../src/zip.js';
import { DEFAULT_INDEX_FOLDER, Indexer, indexLayout, indexMarkdown, indexPath, isIndexPath, noteForIndex, noteOfIndex, offsetOf, readNoteText, strokesAt, strokesForIndexPlace } from '../src/index-note.js';
import { libraryFiles } from '../../web/src/library.js';
import { createSession, linkToStroke, strokesOfState } from '../src/session.js';
import { HostBridge } from '../src/bridge.js';
import { installWebApp, webAppUrl } from '../src/assets.js';
import { packWebApp } from '../build.mjs';
import { ErrorLog, pluginWatcher, reportsAddress, sendReport, withPluginSlow } from '../src/report.js';

/** A ZIP like zip.rs writes: each entry deflated if that is smaller. */
function zip(entries) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = enc.encode(content);
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
    pickNote: async (query, source) => { calls.push(['pick', query, source]); return 'Ideas'; },
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
  assert.match(vault.files.get(`${DEFAULT_INDEX_FOLDER}/Forces.md`).data, /Newtn/);
  await s.handlers.write({ data: new Uint8Array(note(['Newton'])) });
  assert.match(vault.files.get(`${DEFAULT_INDEX_FOLDER}/Forces.md`).data, /Newton\n/);
  assert.equal((await s.handlers.read({})).data.byteLength, note(['Newton']).byteLength);
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
  assert.match(vault.files.get(`${DEFAULT_INDEX_FOLDER}/Forces.md`).data, /\bb\b/);
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

test('session camera is kept per file; picker and links get the note path', async () => {
  const vault = new FakeVault();
  const a = await vault.createBinary('A.bedrock', new ArrayBuffer(0));
  const b = await vault.createBinary('B.bedrock', new ArrayBuffer(0));
  const sa = session(vault, a);
  const sb = session(vault, b, {});
  sb.kvStore.clear();
  await sa.s.handlers['set-kv']({ key: 'camera:4f2a', value: [1, 2, 3] });
  assert.deepEqual(await sa.s.handlers['get-kv']({ key: 'camera:other-id' }), [1, 2, 3], 'note ids inside the app do not matter');
  assert.equal(await sb.s.handlers['get-kv']({ key: 'camera:4f2a' }), null);
  assert.equal(await sa.s.handlers['pick-note']({ query: 'Ide' }), 'Ideas');
  await sa.s.handlers['open-link']({ type: 'note', target: 'Ideas' });
  assert.deepEqual(sa.calls, [['pick', 'Ide', 'A.bedrock'], ['open', 'Ideas', 'A.bedrock']]);
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

test('the web app is unpacked once per version', async () => {
  const written = new Map();
  const adapter = {
    exists: async (p) => written.has(p) || [...written.keys()].some((k) => k.startsWith(`${p}/`)),
    mkdir: async () => {},
    read: async (p) => written.get(p),
    write: async (p, d) => { written.set(p, d); },
    writeBinary: async (p, d) => { written.set(p, new Uint8Array(d)); },
    getResourcePath: (p) => `app://local/${p}?1234`,
  };
  const bundle = { hash: 'v1', files: { 'index.html': btoa('<p>hi</p>'), 'pkg/x.wasm': btoa('\0asm') } };
  assert.equal(await installWebApp(adapter, 'plug/web', bundle), true);
  assert.equal(new TextDecoder().decode(written.get('plug/web/index.html')), '<p>hi</p>');
  assert.deepEqual([...written.get('plug/web/pkg/x.wasm')], [0, 97, 115, 109]);
  assert.equal(await installWebApp(adapter, 'plug/web', bundle), false);
  assert.equal(await installWebApp(adapter, 'plug/web', { ...bundle, hash: 'v2' }), true);
  assert.equal(webAppUrl(adapter, 'plug/web', 'v2'), 'app://local/plug/web/index.html?host=obsidian&v=v2');
});

test('the plugin packs the current web app, host adapter and WebAssembly included', async () => {
  const b = await packWebApp();
  for (const f of ['index.html', 'style.css', 'src/main.js', 'src/host.js', 'src/word-menu.js', 'pkg/bedrock_web.js', 'pkg/bedrock_web_bg.wasm', 'dict/en.aff', 'dict/en.dic.gz']) {
    assert.ok(b.files[f], `${f} is packed`);
  }
  assert.ok(!Object.keys(b.files).some((f) => f.startsWith('tests/')), 'tests are not shipped');
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
  const session = createSession({ vault, file: () => null, kv: {}, pickNote: async () => null, openLink: () => {}, sendReport: async (r) => { sent.push(r); return r.id; } });
  assert.deepEqual(await session.handlers['send-report']({ report: { id: 'x' } }), { id: 'x' });
  assert.deepEqual(sent, [{ id: 'x' }]);
  const none = createSession({ vault, file: () => null, kv: {}, pickNote: async () => null, openLink: () => {} });
  await assert.rejects(none.handlers['send-report']({ report: { id: 'x' } }), /not switched on/);
});

test('the welcome page address sits next to the web app', async () => {
  const { welcomeUrl } = await import('../src/consent.js');
  assert.equal(welcomeUrl('app://local/v/web/index.html?host=obsidian&v=abc'), 'app://local/v/web/welcome/index.html?host=obsidian&v=abc');
  assert.equal(welcomeUrl('/index.html'), '/welcome/index.html');
});

test('slow reads, writes and index updates are logged with what was running', async () => {
  const vault = new FakeVault();
  const file = await vault.createBinary('Forces.bedrock', new ArrayBuffer(0));
  const log = new ErrorLog();
  let t = 0;
  const perf = pluginWatcher(log, { mobile: true }).configure({ now: () => t });
  const slowVault = Object.create(vault);
  slowVault.modifyBinary = async (f, buf) => { t += 2500; return vault.modifyBinary(f, buf); };
  const s = createSession({ vault: slowVault, file: () => file, indexer: null, kv: {}, pickNote: async () => null, openLink: () => {}, perf });
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
