// Bedrock for Obsidian. Opens .bedrock files in a view that runs the
// Bedrock web app (apps/web) in an iframe; see README.md for how the pieces
// fit together.

import { FileView, FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath } from 'obsidian';
import bundle from 'virtual:web-app';
import { installWebApp, webAppUrl } from './assets.js';
import { HostBridge } from './bridge.js';
import { createSession } from './session.js';
import { DEFAULT_INDEX_FOLDER, Indexer, isIndexPath, noteOfIndex } from './index-note.js';

export const VIEW_TYPE = 'bedrock-note';
const EXTENSION = 'bedrock';
const MAX_CAMERAS = 500;

/** Obsidian's own kind of file picker, over every file in the vault. */
class NotePicker extends FuzzySuggestModal {
  constructor(app, { query, exclude, isIndex, onDone }) {
    super(app);
    this.exclude = exclude;
    this.isIndex = isIndex;
    this.onDone = onDone;
    this.chosen = null;
    this.setPlaceholder('Link to a note…');
    this.setInstructions([
      { command: '↑↓', purpose: 'to navigate' },
      { command: '↵', purpose: 'to link' },
      { command: 'esc', purpose: 'to cancel' },
    ]);
    if (query) this.inputEl.value = query;
  }

  getItems() {
    return this.app.vault.getFiles()
      .filter((f) => f.path !== this.exclude && !this.isIndex(f.path))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  getItemText(f) { return f.extension === 'md' ? f.path.slice(0, -3) : f.path; }

  onChooseItem(f) { this.chosen = f; }

  onClose() {
    super.onClose();
    // onChooseItem runs before onClose; wait a tick so it has.
    setTimeout(() => this.onDone(this.chosen), 0);
  }
}

class BedrockView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = true;
    this.frame = null;
    this.bridge = null;
    this.session = null;
  }

  getViewType() { return VIEW_TYPE; }

  getDisplayText() { return this.file ? this.file.basename : 'Bedrock'; }

  getIcon() { return 'pen-tool'; }

  canAcceptExtension(ext) { return ext === EXTENSION; }

  async onLoadFile(file) {
    await this.plugin.webAppReady;
    const plugin = this.plugin;
    this.session = createSession({
      vault: this.app.vault,
      file: () => this.file,
      indexer: plugin.settings.index ? plugin.indexer : null,
      kv: plugin.kv,
      pickNote: (query, sourcePath) => plugin.pickNote(query, sourcePath),
      openLink: (target, sourcePath) => this.app.workspace.openLinkText(target, sourcePath, false),
    });
    const frame = this.contentEl.createEl('iframe', { cls: 'bedrock-frame', attr: { allow: 'clipboard-read; clipboard-write' } });
    this.frame = frame;
    this.bridge = new HostBridge(() => frame.contentWindow, this.session.handlers);
    this.bridge.listen(frame.ownerDocument.defaultView);
    frame.src = webAppUrl(this.app.vault.adapter, plugin.webDir, bundle.hash);
  }

  async onUnloadFile() {
    // Save what was drawn last before the iframe goes away.
    await this.bridge?.send('flush', {}, 3000).catch(() => null);
    this.bridge?.close();
    this.frame?.remove();
    this.frame = this.bridge = this.session = null;
  }

  /** The file changed outside this view (sync, another window). */
  fileChanged(file) {
    if (this.session?.isOutsideChange(file)) this.bridge.send('reload');
  }
}

const DEFAULT_SETTINGS = { index: true, indexFolder: DEFAULT_INDEX_FOLDER, newNoteFolder: '' };

export default class BedrockPlugin extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    this.cameras = data.cameras || {};
    this.webDir = normalizePath(`${this.manifest.dir}/web`);
    this.webAppReady = installWebApp(this.app.vault.adapter, this.webDir, bundle).catch((e) => {
      new Notice(`Bedrock could not unpack its canvas: ${e}`);
    });
    this.indexer = new Indexer(this.app.vault, () => this.settings.indexFolder);
    this.kv = {
      get: (key) => this.cameras[key],
      set: async (key, value) => {
        delete this.cameras[key];
        this.cameras[key] = value;
        const keys = Object.keys(this.cameras);
        for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CAMERAS))) delete this.cameras[k];
        await this.persist();
      },
    };

    this.registerView(VIEW_TYPE, (leaf) => new BedrockView(leaf, this));
    this.registerExtensions([EXTENSION], VIEW_TYPE);

    this.addRibbonIcon('pen-tool', 'New Bedrock note', () => this.newNote());
    this.addCommand({ id: 'new-note', name: 'New handwritten note', callback: () => this.newNote() });
    this.addCommand({ id: 'reindex', name: 'Rebuild search index of handwritten notes', callback: () => this.reindex(true) });
    this.addSettingTab(new BedrockSettings(this.app, this));

    const vault = this.app.vault;
    this.registerEvent(vault.on('modify', (f) => {
      if (!(f instanceof TFile) || f.extension !== EXTENSION) return;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.fileChanged?.(f);
    }));
    this.registerEvent(vault.on('rename', async (f, oldPath) => {
      if (!(f instanceof TFile) || f.extension !== EXTENSION || !this.settings.index) return;
      await this.indexer.rename(oldPath, f.path, await vault.readBinary(f)).catch(() => {});
      for (const k of Object.keys(this.cameras)) {
        if (k.startsWith(`${oldPath}\u0000`)) { this.cameras[f.path + k.slice(oldPath.length)] = this.cameras[k]; delete this.cameras[k]; }
      }
      this.persist();
    }));
    this.registerEvent(vault.on('delete', (f) => {
      if (f instanceof TFile && f.extension === EXTENSION && this.settings.index) this.indexer.remove(f.path).catch(() => {});
    }));
    // A search result or link that lands on an index note opens the handwriting.
    this.registerEvent(this.app.workspace.on('file-open', async (f) => {
      if (!this.settings.index || !(f instanceof TFile) || !isIndexPath(f.path, this.settings.indexFolder)) return;
      const notePath = noteOfIndex(await vault.cachedRead(f));
      const note = notePath && vault.getAbstractFileByPath(notePath);
      const leaf = this.app.workspace.getMostRecentLeaf();
      if (note instanceof TFile && leaf && leaf.view?.file === f) leaf.openFile(note);
    }));
    // Notes edited by the web app or on another device get indexed too.
    this.app.workspace.onLayoutReady(() => this.reindex(false));
  }

  async persist() {
    await this.saveData({ settings: this.settings, cameras: this.cameras });
  }

  async reindex(announce) {
    if (!this.settings.index) return;
    const n = await this.indexer.sync().catch((e) => { console.warn('Bedrock: indexing failed', e); return 0; });
    if (announce) new Notice(`Bedrock: ${n} handwritten note${n === 1 ? '' : 's'} indexed.`);
  }

  /** Show the note picker; resolves to a link target or null. */
  pickNote(query, sourcePath) {
    return new Promise((resolve) => {
      new NotePicker(this.app, {
        query,
        exclude: sourcePath,
        isIndex: (path) => this.settings.index && isIndexPath(path, this.settings.indexFolder),
        onDone: (f) => resolve(f ? this.app.metadataCache.fileToLinktext(f, '', true) : null),
      }).open();
    });
  }

  async newNote() {
    const active = this.app.workspace.getActiveFile();
    const folder = this.settings.newNoteFolder || active?.parent?.path || '';
    const dir = folder && folder !== '/' ? `${folder}/` : '';
    let path;
    for (let n = 0; ; n++) {
      path = normalizePath(`${dir}Handwritten note${n ? ` ${n}` : ''}.${EXTENSION}`);
      if (!this.app.vault.getAbstractFileByPath(path)) break;
    }
    if (dir) await this.indexer.ensureFolder(folder);
    // An empty file is a new note; the canvas writes the first save.
    const file = await this.app.vault.createBinary(path, new ArrayBuffer(0));
    await this.app.workspace.getLeaf(true).openFile(file);
  }
}

class BedrockSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();
    new Setting(containerEl)
      .setName('Make handwriting searchable')
      .setDesc('Keep a Markdown index note for each handwritten note, with the text read from the handwriting and its links, so Obsidian search, backlinks and the graph include them. Opening an index note opens the handwriting.')
      .addToggle((t) => t.setValue(p.settings.index).onChange(async (v) => {
        p.settings.index = v;
        await p.persist();
        if (v) p.reindex(true);
      }));
    new Setting(containerEl)
      .setName('Index folder')
      .setDesc('Where index notes are kept. Leave empty to keep each beside its note as “Name.bedrock.md”.')
      .addText((t) => t.setPlaceholder(DEFAULT_INDEX_FOLDER).setValue(p.settings.indexFolder).onChange(async (v) => {
        p.settings.indexFolder = normalizePath(v.trim() || '/').replace(/^\/$/, '');
        await p.persist();
      }));
    new Setting(containerEl)
      .setName('Folder for new notes')
      .setDesc('Leave empty to create new notes next to the open file.')
      .addText((t) => t.setValue(p.settings.newNoteFolder).onChange(async (v) => {
        p.settings.newNoteFolder = v.trim() ? normalizePath(v.trim()) : '';
        await p.persist();
      }));
  }
}
