// Loads the built plugin (dist/main.js, as Obsidian would: CommonJS with an
// `obsidian` module) against fake Obsidian objects and an in-memory vault.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlugin } from '../build.mjs';
import { FakeVault } from './fake-vault.mjs';

const require = createRequire(import.meta.url);
const fake = require('./fake-obsidian.cjs');
let Plugin;

before(async () => {
  const out = await mkdtemp(join(tmpdir(), 'bedrock-obsidian-'));
  await buildPlugin({ outdir: out });
  // Load the bundle as CommonJS with our `obsidian`, as Obsidian does.
  const code = await readFile(join(out, 'main.js'), 'utf8');
  await writeFile(join(out, 'main.cjs'), code);
  const Module = require('node:module');
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === 'obsidian' ? fake : load.call(this, req, ...rest); };
  try { Plugin = require(join(out, 'main.cjs')).default; } finally { Module._load = load; }
});

function makeApp() {
  const vault = new FakeVault();
  for (const f of vault.getFiles()) Object.setPrototypeOf(f, fake.TFile.prototype);
  const wrap = (fn) => async (...a) => { const f = await fn(...a); if (f) Object.setPrototypeOf(f, fake.TFile.prototype); return f; };
  vault.createBinary = wrap(vault.createBinary.bind(vault));
  vault.create = wrap(vault.create.bind(vault));
  Object.assign(vault, new fake.Events(), { on: fake.Events.prototype.on, trigger: fake.Events.prototype.trigger });
  const written = new Map();
  vault.adapter = {
    exists: async (p) => written.has(p),
    mkdir: async (p) => { written.set(p, 'dir'); },
    read: async (p) => written.get(p),
    write: async (p, d) => { written.set(p, d); },
    writeBinary: async (p, d) => { written.set(p, d); },
    getResourcePath: (p) => `app://local/${p}?1`,
  };
  const opened = [];
  const workspace = Object.assign(new fake.Events(), {
    active: null,
    getActiveFile() { return this.active; },
    getLeaf: () => ({ openFile: async (f) => opened.push(f.path) }),
    getLeavesOfType: () => [],
    getMostRecentLeaf: () => null,
    onLayoutReady: (fn) => fn(),
    openLinkText: () => {},
  });
  const app = {
    vault,
    workspace,
    metadataCache: { fileToLinktext: (f, source, omitMd) => (omitMd && f.extension === 'md' ? f.path.slice(0, -3) : f.path) },
  };
  return { app, vault, written, opened };
}

async function loaded() {
  const env = makeApp();
  const plugin = new Plugin(env.app, { id: 'bedrock-notes', dir: '.obsidian/plugins/bedrock-notes', version: '0.1.0' });
  await plugin.onload();
  await plugin.webAppReady;
  return { ...env, plugin };
}

test('registers the .bedrock view, commands and settings, and unpacks the web app', async () => {
  const { plugin, written } = await loaded();
  assert.deepEqual(Object.keys(plugin.views), ['bedrock-note']);
  assert.deepEqual(plugin.extensions, { bedrock: 'bedrock-note' });
  assert.deepEqual(plugin.commands.map((c) => c.id), ['new-note', 'report-problem', 'reindex']);
  assert.equal(plugin.settingTabs.length, 1);
  assert.ok(written.get('.obsidian/plugins/bedrock-notes/web/index.html'), 'web app unpacked');
  assert.ok(written.get('.obsidian/plugins/bedrock-notes/web/src/host.js'));
  assert.ok(written.get('.obsidian/plugins/bedrock-notes/web/pkg/bedrock_web_bg.wasm'));
  assert.ok(written.get('.obsidian/plugins/bedrock-notes/web/welcome/index.html'), 'the launch gate page');
  assert.ok(written.get('.obsidian/plugins/bedrock-notes/web/welcome/welcome.js'));
  assert.ok(written.get('.obsidian/plugins/bedrock-notes/web/src/consent.js'));
});

test('new notes are empty .bedrock files next to the open file, never overwriting one', async () => {
  const { plugin, vault, app, opened } = await loaded();
  await vault.createFolder('Physics');
  app.workspace.active = { parent: { path: 'Physics' } };
  await plugin.commands.find((c) => c.id === 'new-note').callback();
  await plugin.commands.find((c) => c.id === 'new-note').callback();
  assert.deepEqual(opened, ['Physics/Handwritten note.bedrock', 'Physics/Handwritten note 1.bedrock']);
  assert.equal(vault.files.get('Physics/Handwritten note.bedrock').data.byteLength, 0);
});

test('the note picker lists vault notes, not index notes or the note itself, and gives link text', async () => {
  const { plugin, vault } = await loaded();
  await vault.create('Ideas.md', '# Ideas');
  await vault.create('Bedrock index/Forces.md', 'index');
  await vault.createBinary('Forces.bedrock', new ArrayBuffer(0));
  await vault.createBinary('Maths.bedrock', new ArrayBuffer(0));
  fake.Modal.opened.length = 0;
  const picked = plugin.pickNote('Ide', 'Forces.bedrock');
  const modal = fake.Modal.opened[0];
  assert.equal(modal.inputEl.value, 'Ide', 'starts with what was typed');
  const items = modal.getItems().map((f) => modal.getItemText(f)).sort();
  assert.deepEqual(items, ['Ideas', 'Maths.bedrock']);
  modal.choose(modal.getItems().find((f) => f.path === 'Ideas.md'));
  assert.equal(await picked, 'Ideas');
  // Escape: no link.
  const none = plugin.pickNote('', 'Forces.bedrock');
  fake.Modal.opened[1].close();
  assert.equal(await none, null);
});

test('at start, an empty (new) note is left alone: nothing to index yet', async () => {
  const env = makeApp();
  const plugin = new Plugin(env.app, { id: 'bedrock-notes', dir: '.obsidian/plugins/bedrock-notes', version: '0.1.0' });
  await env.vault.createBinary('Empty.bedrock', new ArrayBuffer(0));
  await plugin.onload();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!env.vault.files.has('Bedrock index/Empty.md'));
  assert.deepEqual(env.vault.log.filter((l) => l[0] !== 'create' || l[1] !== 'Empty.bedrock'), []);
});

/** A .bedrock archive with only recognised text: [text, [stroke ids]]. */
function inkNote(...items) {
  const name = Buffer.from('recognized.json');
  const data = Buffer.from(JSON.stringify({ format: 'bedrock-recognition', version: 1, items: items.map(([text, strokes], i) => ({ id: `r${i}`, text, strokes })) }));
  const body = deflateRawSync(data);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
  h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
  c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + body.length, 16);
  const all = Buffer.concat([h, name, body, c, name, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

test('a search result on an index note opens the handwriting at the words that matched', async () => {
  const { plugin, vault } = await loaded();
  await vault.createBinary('Physics/Forces.bedrock', inkNote(['Newton', ['a1', 'a2']], ['second', ['b1']], ['law', ['c1']]));
  await plugin.commands.find((c) => c.id === 'reindex').callback();
  const index = vault.files.get('Bedrock index/Physics/Forces.md');
  const md = index.data;
  const leaf = new fake.WorkspaceLeaf();
  // Obsidian's search: the file, and where in it the clicked match is.
  const i = md.indexOf('second');
  await leaf.openFile(index, { active: true, state: { mode: 'source' }, eState: { match: { content: md, matches: [[i, i + 6]] } } });
  assert.deepEqual(leaf.opened, [{ path: 'Physics/Forces.bedrock', openState: { active: true, eState: { bedrock: { strokes: ['b1'] } } } }]);
  // Opened without a place (the file explorer, the graph): just the note.
  await leaf.openFile(index);
  assert.deepEqual(leaf.opened[1], { path: 'Physics/Forces.bedrock', openState: { eState: {} } });
  // Every other file opens exactly as asked.
  const other = await vault.create('Ideas.md', 'Newton second law');
  const asked = { eState: { match: { content: 'x', matches: [[0, 6]] } } };
  await leaf.openFile(other, asked);
  assert.equal(leaf.opened[2].path, 'Ideas.md');
  assert.equal(leaf.opened[2].openState, asked);
  await leaf.openFile(vault.files.get('Physics/Forces.bedrock'), { eState: { subpath: '#^a1' } });
  assert.deepEqual(leaf.opened[3], { path: 'Physics/Forces.bedrock', openState: { eState: { subpath: '#^a1' } } });
  // With the index turned off, index notes are ordinary notes.
  plugin.settings.index = false;
  await leaf.openFile(index, asked);
  assert.equal(leaf.opened[4].path, 'Bedrock index/Physics/Forces.md');
  plugin.settings.index = true;
  // Unloading the plugin puts Obsidian's own openFile back.
  plugin.unload();
  await leaf.openFile(index, asked);
  assert.equal(leaf.opened[5].path, 'Bedrock index/Physics/Forces.md');
});

test('an index note opened some other way is swapped for the handwriting, at the cursor', async () => {
  const { plugin, vault, app } = await loaded();
  await vault.createBinary('Forces.bedrock', inkNote(['Newton', ['a1']], ['law', ['c1']]));
  await plugin.commands.find((c) => c.id === 'reindex').callback();
  const index = vault.files.get('Bedrock index/Forces.md');
  const md = index.data;
  const line = md.slice(0, md.indexOf('law')).split('\n').length - 1;
  const leaf = new fake.WorkspaceLeaf();
  leaf.view = { file: index, editor: { getCursor: () => ({ line, ch: md.indexOf('law') - md.indexOf('Newton') + 1 }) } };
  app.workspace.getMostRecentLeaf = () => leaf;
  await app.workspace.trigger('file-open', index);
  assert.deepEqual(leaf.opened, [{ path: 'Forces.bedrock', openState: { eState: { bedrock: { strokes: ['c1'] } } } }]);
  // A cursor left at the top says nothing about a place.
  leaf.view.editor.getCursor = () => ({ line: 0, ch: 0 });
  await app.workspace.trigger('file-open', index);
  assert.deepEqual(leaf.opened[1], { path: 'Forces.bedrock', openState: { eState: {} } });
  // Other files are left alone.
  const other = await vault.create('Ideas.md', 'x');
  leaf.view.file = other;
  await app.workspace.trigger('file-open', other);
  assert.equal(leaf.opened.length, 2);
  plugin.unload();
});

test('the view shows the ink once the canvas is ready, and at once if it already is', async () => {
  const { plugin } = await loaded();
  const view = plugin.views['bedrock-note'](new fake.WorkspaceLeaf());
  const sent = [];
  view.bridge = { send: (event, args) => { sent.push([event, args]); return Promise.resolve(true); } };
  // Obsidian gives the place before the canvas has loaded the note.
  view.setEphemeralState({ bedrock: { strokes: ['a1', 'a2'] } });
  assert.deepEqual(sent, []);
  view.appReady = true;
  view.showPending();
  assert.deepEqual(sent, [['show', { strokes: ['a1', 'a2'] }]]);
  view.showPending();
  assert.equal(sent.length, 1, 'shown once');
  // The note is already open: the next hit, or a link to a word, goes straight there.
  view.setEphemeralState({ subpath: '#^c1' });
  assert.deepEqual(sent[1], ['show', { strokes: ['c1'] }]);
  // State without a place (scroll positions and the like) is ignored.
  view.setEphemeralState({ scroll: 3 });
  view.setEphemeralState(null);
  assert.equal(sent.length, 2);
  plugin.unload();
});

test('a plugin problem is shown with Report and logged; reports go out through requestUrl, from the plugin and from the canvas', async () => {
  const { plugin } = await loaded();
  fake.Notice.shown.length = 0;
  plugin.problem('Bedrock could not unpack its canvas: Error: EACCES /Users/frederik/Vault/.obsidian/plugins/bedrock-notes/web/index.html', new Error('EACCES'));
  assert.equal(fake.Notice.shown.length, 1);
  const [entry] = plugin.errors.entries();
  assert.equal(entry.kind, 'shown');
  assert.equal(entry.message, 'Bedrock could not unpack its canvas: Error: EACCES index.html', 'no folders');
  // Opening the report is a command.
  const before = fake.Modal.opened.length;
  plugin.commands.find((c) => c.id === 'report-problem').callback();
  assert.equal(fake.Modal.opened.length, before + 1);
  // Sending needs the backend's address, which this version does not have.
  const report = plugin.errors.report({ appVersion: plugin.manifest.version });
  assert.equal(report.app, 'obsidian');
  assert.equal(report.app_version, '0.1.0');
  await assert.rejects(plugin.sendReport(report), /not switched on/);
  assert.equal(fake.requestUrl.calls.length, 0);
});
