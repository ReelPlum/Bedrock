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
  // Obsidian's FileManager: renames the file (and would update links to
  // it), then the vault tells everyone, as Obsidian does.
  const renamed = [];
  const fileManager = {
    async renameFile(f, newPath) {
      const oldPath = f.path;
      await vault.rename(f, newPath);
      renamed.push([oldPath, newPath]);
      await vault.trigger('rename', f, oldPath);
    },
  };
  const app = {
    vault,
    workspace,
    fileManager,
    metadataCache: { fileToLinktext: (f, source, omitMd) => (omitMd && f.extension === 'md' ? f.path.slice(0, -3) : f.path) },
  };
  return { app, vault, written, opened, renamed };
}

async function loaded() {
  const env = makeApp();
  const plugin = new Plugin(env.app, { id: 'bedrock-notes', dir: '.obsidian/plugins/bedrock-notes', version: '0.1.0' });
  await plugin.onload();
  return { ...env, plugin };
}

test('registers the .bedrock view, commands and settings, and writes nothing into the plugin folder', async () => {
  const { plugin, written } = await loaded();
  assert.deepEqual(Object.keys(plugin.views), ['bedrock-note']);
  assert.deepEqual(plugin.extensions, { bedrock: 'bedrock-note' });
  assert.deepEqual(plugin.commands.map((c) => c.id), ['new-note', 'new-linked-note', 'report-problem', 'reindex', 'graph-filter']);
  assert.equal(plugin.settingTabs.length, 1);
  assert.deepEqual([...written.keys()], [], 'the canvas is not unpacked: Obsidian would not let the view load it');
  for (const name of ['app', 'welcome']) assert.match(plugin.webApp.bundle.pages[name], /<!--bedrock:module-->/, `the ${name} page is carried in main.js`);
});

test('on a desktop computer notes are view only, and new notes are still made; the iPad edits', async () => {
  fake.Platform.isDesktopApp = true;
  let env;
  try { env = await loaded(); } finally { fake.Platform.isDesktopApp = false; }
  const { plugin, app, vault } = env;
  assert.equal(plugin.viewOnly, true);
  assert.deepEqual(plugin.commands.map((c) => c.id), ['new-note', 'new-linked-note', 'report-problem', 'reindex', 'graph-filter'], 'new notes are made on a computer too');
  assert.deepEqual(plugin.ribbons.map((r) => r.title), ['New Bedrock note']);
  // "New Bedrock note" on a folder, "New handwritten note linking here" on a note.
  await vault.create('Lecture 3.md', '# Lecture 3');
  Object.setPrototypeOf(vault.files.get('Lecture 3.md'), fake.TFile.prototype);
  const menu = new fake.Menu();
  await app.workspace.trigger('file-menu', menu, new fake.TFolder('Physics'), 'file-explorer-context-menu');
  await app.workspace.trigger('editor-menu', menu, {}, { file: vault.files.get('Lecture 3.md') });
  assert.deepEqual(menu.items.map((i) => i.title), ['New Bedrock note', 'New handwritten note linking here']);
  await menu.items[1].click();
  assert.ok(vault.files.has('Lecture 3 notes.bedrock'), 'the note is made');
  assert.equal(plugin.starts.get('Lecture 3 notes.bedrock').noteLinks[0].target, 'Lecture 3', 'and starts with its link');
  // The note's name is not changed from the canvas header either.
  const note = await vault.createBinary('Forces.bedrock', new ArrayBuffer(0));
  Object.setPrototypeOf(note, fake.TFile.prototype);
  assert.equal(await plugin.renameNote(note, 'Gravity'), 'Forces');
  assert.ok(vault.files.has('Forces.bedrock'));
  // The view opens the canvas view only.
  const pages = [];
  const page = plugin.webApp.page.bind(plugin.webApp);
  plugin.webApp.page = (name, opts) => { pages.push([name, opts]); return page(name, opts); };
  const view = plugin.views['bedrock-note'](new fake.WorkspaceLeaf());
  const frame = { remove() {}, ownerDocument: { defaultView: { addEventListener() {}, removeEventListener() {} } }, contentWindow: null };
  view.app = app;
  view.file = note;
  view.contentEl = { createEl: () => frame };
  await view.onLoadFile(note);
  assert.deepEqual(pages, [['app', { viewOnly: true }]]);
  await assert.rejects(view.session.handlers.write({ data: new Uint8Array([1]) }), /view only/);
  assert.equal(vault.files.get('Forces.bedrock').data.byteLength, 0);

  const ipad = await loaded();
  assert.equal(ipad.plugin.viewOnly, false);
  assert.deepEqual(ipad.plugin.commands.map((c) => c.id), ['new-note', 'new-linked-note', 'report-problem', 'reindex', 'graph-filter']);
});

test('soon after Obsidian starts, the WebAssembly is compiled once, ready for the first note', async () => {
  const { plugin } = await loaded();
  const module = await plugin.wasmWarm;
  assert.ok(module instanceof WebAssembly.Module, 'compiled in the background');
  assert.equal(await plugin.webApp.wasmModule(), module, 'the first note gets that module');
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

test('new notes start on grid paper; the settings choose another paper for new notes, and it is remembered', async () => {
  const { plugin, app, vault } = await loaded();
  const tab = plugin.settingTabs[0];
  tab.display();
  const setting = tab.containerEl.settings.find((x) => x.name === 'Paper for new notes');
  assert.ok(setting, 'the settings have it');
  assert.equal(setting.control.kind, 'dropdown');
  assert.deepEqual(setting.control.options, { grid: 'Grid', dots: 'Dots', lines: 'Lines', plain: 'Plain' });
  assert.equal(setting.control.value, 'grid', 'grid is the default');
  // A new note's canvas is told the paper to start with.
  const note = await vault.createBinary('Forces.bedrock', new ArrayBuffer(0));
  Object.setPrototypeOf(note, fake.TFile.prototype);
  const view = plugin.views['bedrock-note'](new fake.WorkspaceLeaf());
  const frame = { remove() {}, ownerDocument: { defaultView: { addEventListener() {}, removeEventListener() {} } }, contentWindow: null };
  view.app = app;
  view.contentEl = { createEl: () => frame };
  await view.onLoadFile(note);
  assert.deepEqual(await view.session.handlers.defaults(), { paper: 'grid' });
  await setting.control.change('lines');
  assert.deepEqual(await view.session.handlers.defaults(), { paper: 'lines' });
  assert.equal(plugin.data.settings.newNotePaper, 'lines', 'saved with the settings');
  // Something that is not a paper is never kept.
  await setting.control.change('stripes');
  assert.equal(plugin.settings.newNotePaper, 'grid');
  // Restarted, the choice comes back; settings saved before it existed get grid.
  await setting.control.change('dots');
  const again = new Plugin(app, plugin.manifest);
  again.data = plugin.data;
  await again.onload();
  assert.equal(again.settings.newNotePaper, 'dots');
  const old = new Plugin(app, plugin.manifest);
  old.data = { settings: { index: true, indexFolder: 'Bedrock index', newNoteFolder: '' } };
  await old.onload();
  assert.equal(old.settings.newNotePaper, 'grid');
});

/** A PDF open in Obsidian's viewer, its pages `count` tall pages of 1000px
 *  with the view scrolled to `scroll`: just the DOM pdfPageInView reads. */
function pdfLeaf(file, count, scroll) {
  const view = { top: 0, bottom: 800, left: 0, right: 600 };
  const pages = Array.from({ length: count }, (_, i) => ({
    dataset: { pageNumber: String(i + 1) },
    getBoundingClientRect: () => ({ top: i * 1000 - scroll, bottom: (i + 1) * 1000 - scroll, left: 0, right: 600 }),
    closest(sel) { return sel.startsWith('.page') ? this : null; },
  }));
  const containerEl = {
    getBoundingClientRect: () => view,
    querySelectorAll: () => pages,
    contains: (el) => el === containerEl || pages.includes(el),
    closest: () => null,
  };
  return { view: { file, containerEl, getViewType: () => 'pdf' }, pages };
}

test('a note or PDF offers "New handwritten note linking here": named after the page, it starts with a link to it', async () => {
  const { plugin, vault, app, opened } = await loaded();
  const lecture = await vault.create('Lectures/Lecture 3.md', '# Lecture 3');
  const pdf = await vault.createBinary('Lectures/Week 3.pdf', new ArrayBuffer(0));
  const index = await vault.create('Bedrock index/Forces.md', 'index');
  const menuOf = async (event, ...args) => {
    const menu = new fake.Menu();
    await app.workspace.trigger(event, menu, ...args);
    return menu.items.filter((i) => i.title === 'New handwritten note linking here');
  };

  // Right-click (a long press on the iPad) in a Markdown note.
  const [fromEditor] = await menuOf('editor-menu', {}, { file: lecture });
  assert.ok(fromEditor, 'the editor menu offers it');
  await fromEditor.click();
  assert.deepEqual(opened, ['Lectures/Lecture 3 notes.bedrock'], 'made next to the page, named after it, and opened');
  assert.equal(vault.files.get('Lectures/Lecture 3 notes.bedrock').data.byteLength, 0, 'an empty file: the canvas writes the first save');
  const file = vault.files.get('Lectures/Lecture 3 notes.bedrock');
  assert.deepEqual(plugin.takeStart(file), { noteLinks: [{ target: 'Lectures/Lecture 3', type: 'note', text: 'Lecture 3' }] });
  assert.equal(plugin.takeStart(file), null, 'handed to the canvas once');

  // A PDF's menu (its tab's ⋯, a right-click on it) links the page in view.
  const leaf = pdfLeaf(pdf, 6, 3300);
  const [fromTab] = await menuOf('file-menu', pdf, 'more-options', leaf);
  await fromTab.click();
  const pdfNote = vault.files.get('Lectures/Week 3 page 4 notes.bedrock');
  assert.ok(pdfNote, `named after the page: ${opened.at(-1)}`);
  assert.deepEqual(plugin.takeStart(pdfNote).noteLinks, [{ target: 'Lectures/Week 3.pdf#page=4', type: 'note', text: 'Week 3, page 4' }]);

  // Right-clicking inside the PDF links the page under the pointer.
  app.workspace.getLeavesOfType = (type) => (type === 'pdf' ? [leaf] : []);
  const right = { fn: (ev) => plugin.pdfContextMenu(ev) };
  const e = { target: leaf.pages[1], defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  fake.Menu.made.length = 0;
  right.fn(e);
  assert.ok(e.defaultPrevented, 'our menu is shown');
  const [pageItem] = fake.Menu.made[0].items;
  assert.equal(fake.Menu.made[0].shownAt, e);
  await pageItem.click();
  assert.ok(vault.files.get('Lectures/Week 3 page 2 notes.bedrock'), 'the page that was right-clicked');
  // A right-click Obsidian already answered is left alone.
  fake.Menu.made.length = 0;
  right.fn({ target: leaf.pages[0], defaultPrevented: true, preventDefault() {} });
  assert.equal(fake.Menu.made.length, 0);

  // From the file explorer, a PDF that is not open links the whole file;
  // index notes, handwritten notes and other files are not offered.
  app.workspace.getLeavesOfType = () => [];
  const [fromExplorer] = await menuOf('file-menu', pdf, 'file-explorer');
  await fromExplorer.click();
  const whole = vault.files.get('Lectures/Week 3 notes.bedrock');
  assert.deepEqual(plugin.takeStart(whole).noteLinks, [{ target: 'Lectures/Week 3.pdf', type: 'note', text: 'Week 3' }]);
  assert.equal((await menuOf('file-menu', index, 'file-explorer')).length, 0, 'not on index notes');
  assert.equal((await menuOf('file-menu', whole, 'file-explorer')).length, 0, 'not on handwritten notes');

  // The same again never overwrites: the next name is free.
  await (await menuOf('editor-menu', {}, { file: lecture }))[0].click();
  assert.equal(opened.at(-1), 'Lectures/Lecture 3 notes 1.bedrock');

  // And from the command palette, for the note in front.
  app.workspace.getMostRecentLeaf = () => ({ view: { file: lecture } });
  const command = plugin.commands.find((c) => c.id === 'new-linked-note');
  assert.equal(command.checkCallback(true), true);
  app.workspace.getMostRecentLeaf = () => ({ view: { file: index } });
  assert.equal(command.checkCallback(true), false, 'not for an index note');
});

test('holding (or right-clicking) a folder offers a new Bedrock note in that folder', async () => {
  const { plugin, vault, app, opened } = await loaded();
  await vault.createFolder('Physics');
  // The folder for new notes and the open file do not matter: the folder held does.
  plugin.settings.newNoteFolder = 'Inbox';
  app.workspace.active = { parent: { path: 'Maths' } };
  const menuFor = async (file) => {
    const menu = new fake.Menu();
    await app.workspace.trigger('file-menu', menu, file, 'file-explorer-context-menu');
    return menu.items.filter((i) => i.title === 'New Bedrock note');
  };
  const [item] = await menuFor(new fake.TFolder('Physics'));
  assert.ok(item, 'the folder menu has the item');
  assert.equal(item.icon, 'pen-tool');
  await item.click();
  await (await menuFor(new fake.TFolder('Physics')))[0].click();
  assert.deepEqual(opened, ['Physics/Handwritten note.bedrock', 'Physics/Handwritten note 1.bedrock']);
  assert.equal(vault.files.get('Physics/Handwritten note.bedrock').data.byteLength, 0);
  // The vault's top folder.
  await (await menuFor(new fake.TFolder('/')))[0].click();
  assert.equal(opened.at(-1), 'Handwritten note.bedrock');
  // A file's menu is left alone.
  const file = vault.files.get('Physics/Handwritten note.bedrock');
  assert.deepEqual(await menuFor(file), []);
});

test('the link picker is offered every vault file but the note itself and index notes, with its link text', async () => {
  const { plugin, vault } = await loaded();
  await vault.create('Ideas.md', '# Ideas');
  await vault.create('Bedrock index/Forces.md', 'index');
  await vault.create('Old/Maths.bedrock.md', 'sidecar index');
  await vault.createBinary('Forces.bedrock', new ArrayBuffer(0));
  await vault.createBinary('Old/Maths.bedrock', new ArrayBuffer(0));
  await vault.createBinary('Papers/Paper.pdf', new ArrayBuffer(0));
  const files = plugin.linkableFiles('Forces.bedrock').sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(files, [
    { path: 'Ideas.md', link: 'Ideas' },
    { path: 'Old/Maths.bedrock', link: 'Old/Maths.bedrock' },
    { path: 'Papers/Paper.pdf', link: 'Papers/Paper.pdf' },
  ]);
});

test("a PDF's pages are drawn for the link picker with Obsidian's PDF.js, and the open PDF is kept for the next page", async () => {
  const { plugin, vault } = await loaded();
  await vault.createBinary('Paper.pdf', new Uint8Array([37, 80, 68, 70]).buffer);
  const opened = [];
  const drawn = [];
  fake.loadPdfJs.lib = {
    getDocument: ({ data }) => {
      opened.push([...data.slice(0, 4)]);
      return { promise: Promise.resolve({
        numPages: 3,
        getPage: async (n) => ({
          getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
          render: ({ viewport }) => { drawn.push([n, viewport.width]); return { promise: Promise.resolve() }; },
        }),
        destroy() {},
      }) };
    },
  };
  // Node has no canvas: a stand-in that makes a "PNG".
  plugin.pdfPages.doc = { createElement: () => ({ getContext: () => ({ fillRect() {} }), toBlob: (cb) => cb(new Blob([new Uint8Array([137, 80, 78, 71])])) }) };
  const p1 = await plugin.pdfPages.page('Paper.pdf', 1, 300);
  const p3 = await plugin.pdfPages.page('Paper.pdf', 3, 300);
  assert.equal(p1.count, 3);
  assert.deepEqual([...new Uint8Array(p3.png)], [137, 80, 78, 71]);
  assert.deepEqual(drawn, [[1, 300], [3, 300]]);
  assert.deepEqual(opened, [[37, 80, 68, 70]], 'read and opened once');
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
  // Sent with Obsidian's requestUrl to the backend built into the app.
  const report = plugin.errors.report({ appVersion: plugin.manifest.version });
  assert.equal(report.app, 'obsidian');
  assert.equal(report.app_version, '0.1.0');
  fake.requestUrl.calls.length = 0;
  fake.requestUrl.answer = (req) => ({ status: 200, json: { id: JSON.parse(req.body).id } });
  try {
    assert.equal(await plugin.sendReport(report), report.id);
  } finally {
    fake.requestUrl.answer = () => ({ status: 200, json: {} });
  }
  assert.equal(fake.requestUrl.calls.length, 1);
  assert.equal(fake.requestUrl.calls[0].url, 'https://bedrock-collect.reelplum.workers.dev/v1/reports');
  assert.equal(fake.requestUrl.calls[0].method, 'POST');
});

/** A .bedrock file in the vault with these recognised words. */
async function noteFile(vault, path, words) {
  const f = await vault.createBinary(path, inkNote(...words.map((w, i) => [w, [`s${i}`]])));
  Object.setPrototypeOf(f, fake.TFile.prototype);
  return f;
}

test("naming a note in the header renames its file with Obsidian's file manager, in its folder", async () => {
  const { plugin, vault, renamed } = await loaded();
  await vault.createFolder('Physics');
  const f = await noteFile(vault, 'Physics/Handwritten note.bedrock', ['Newton']);
  await plugin.indexer.update(f.path, await vault.readBinary(f));
  assert.equal(await plugin.renameNote(f, 'Forces'), 'Forces');
  assert.deepEqual(renamed, [['Physics/Handwritten note.bedrock', 'Physics/Forces.bedrock']], 'through fileManager, so links follow');
  assert.equal(f.path, 'Physics/Forces.bedrock');
  // The index note followed, as for every rename.
  assert.ok(vault.files.has('Bedrock index/Physics/Forces.md'));
  assert.ok(!vault.files.has('Bedrock index/Physics/Handwritten note.md'));
  // A case change is a rename too.
  assert.equal(await plugin.renameNote(f, 'forces'), 'forces');
  assert.equal(f.path, 'Physics/forces.bedrock');
  plugin.unload();
});

test('a header name another file already has renames nothing and says so', async () => {
  const { plugin, vault, renamed } = await loaded();
  const f = await noteFile(vault, 'Forces.bedrock', ['Newton']);
  await noteFile(vault, 'Motion.bedrock', ['Galileo']);
  fake.Notice.shown.length = 0;
  assert.equal(await plugin.renameNote(f, 'Motion'), 'Forces');
  assert.deepEqual(renamed, []);
  assert.equal(f.path, 'Forces.bedrock');
  assert.match(fake.Notice.shown.join('\n'), /Motion\.bedrock.*already/);
  plugin.unload();
});

test('the view tells the canvas when Obsidian renames its file', async () => {
  const { plugin, vault } = await loaded();
  const view = plugin.views['bedrock-note'](new fake.WorkspaceLeaf());
  const sent = [];
  view.bridge = { send: (event, args) => { sent.push([event, args]); return Promise.resolve(true); } };
  const f = await noteFile(vault, 'Forces.bedrock', ['Newton']);
  await vault.rename(f, 'School/Motion.bedrock');
  await view.onRename(f);
  assert.deepEqual(sent, [['renamed', { name: 'Motion' }]]);
  view.bridge = null;
  await view.onRename(f); // closed meanwhile: nothing to tell
  plugin.unload();
});

test('the camera follows a renamed note, even with search switched off', async () => {
  const { plugin, vault } = await loaded();
  plugin.settings.index = false;
  const f = await noteFile(vault, 'Forces.bedrock', ['Newton']);
  await plugin.kv.set('Forces.bedrock\u0000camera', [1, 2, 3]);
  await plugin.renameNote(f, 'Motion');
  assert.deepEqual(plugin.kv.get('Motion.bedrock\u0000camera'), [1, 2, 3]);
  assert.equal(plugin.kv.get('Forces.bedrock\u0000camera'), undefined);
  assert.ok(!vault.getFiles().some((x) => x.path.endsWith('.md')), 'no index note with search off');
  plugin.unload();
});

test('the settings have a place to drop PDFs, which imports them at the vault root', async () => {
  const { plugin, vault } = await loaded();
  const tab = plugin.settingTabs[0];
  tab.display();
  const setting = tab.containerEl.settings.find((x) => x.name === 'Import PDFs');
  assert.ok(setting, 'the settings have it');
  assert.match(setting.desc, /GoodNotes/);
  assert.match(setting.desc, /top of the vault/);
  assert.equal(setting.control.kind, 'button');
  assert.equal(setting.control.text, 'Choose PDFs…');
  // The real reader is a worker with the WebAssembly (host.test.mjs); here it is stood in for.
  plugin.readPdf = async () => ({ bedrock: new Uint8Array([1, 2, 3]), warnings: [] });
  await vault.createFolder('Lectures');
  fake.Notice.shown.length = 0;
  const pdf = (name) => ({ name, read: async () => new TextEncoder().encode('%PDF-1.4\n').buffer });
  const s = await plugin.importPdfs([pdf('Lecture.pdf'), pdf('Lecture.pdf'), { name: 'notes.txt', read: async () => new ArrayBuffer(1) }]);
  assert.deepEqual(s.imported.map((i) => i.path), ['Lecture.bedrock', 'Lecture 1.bedrock'], 'at the root, whatever the folder for new notes');
  assert.deepEqual([...new Uint8Array(vault.files.get('Lecture.bedrock').data)], [1, 2, 3]);
  assert.ok(vault.files.get('Bedrock index/Lecture.md'), 'each note gets its index note');
  assert.deepEqual(s.failed, [{ name: 'notes.txt', reason: 'not a PDF' }]);
  assert.match(fake.Notice.shown.at(-1), /2 notes made at the top of the vault; 1 file not imported/, 'a notice says when it is done, with the settings closed too');
  tab.hide();
});
