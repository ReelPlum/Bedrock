// Unit tests of the plugin's Obsidian-free parts, with an in-memory vault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { FakeVault } from './fake-vault.mjs';
import { readZip, text } from '../src/zip.js';
import { DEFAULT_INDEX_FOLDER, Indexer, indexMarkdown, indexPath, isIndexPath, noteOfIndex, readNoteText } from '../src/index-note.js';
import { createSession } from '../src/session.js';
import { HostBridge } from '../src/bridge.js';
import { installWebApp, webAppUrl } from '../src/assets.js';
import { packWebApp } from '../build.mjs';

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
  for (const f of ['index.html', 'style.css', 'src/main.js', 'src/host.js', 'src/word-menu.js', 'pkg/bedrock_web.js', 'pkg/bedrock_web_bg.wasm', 'dict/en.txt.gz']) {
    assert.ok(b.files[f], `${f} is packed`);
  }
  assert.ok(!Object.keys(b.files).some((f) => f.startsWith('tests/')), 'tests are not shipped');
  assert.equal(b.hash, (await packWebApp()).hash, 'the version hash is stable');
});
