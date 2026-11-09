// Loads the built plugin (dist/main.js, as Obsidian would: CommonJS with an
// `obsidian` module) against fake Obsidian objects and an in-memory vault.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(plugin.commands.map((c) => c.id), ['new-note', 'reindex']);
  assert.equal(plugin.settingTabs.length, 1);
  assert.ok(written.get('.obsidian/plugins/bedrock-notes/web/index.html'), 'web app unpacked');
  assert.ok(written.get('.obsidian/plugins/bedrock-notes/web/src/host.js'));
  assert.ok(written.get('.obsidian/plugins/bedrock-notes/web/pkg/bedrock_web_bg.wasm'));
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
