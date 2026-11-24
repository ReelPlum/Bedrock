// Bedrock for Obsidian. Opens .bedrock files in a view that runs the
// Bedrock web app (apps/web) in an iframe; see README.md for how the pieces
// fit together.

import { FileView, Menu, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, TFolder, WorkspaceLeaf, getAllTags, loadPdfJs, normalizePath, requestUrl } from 'obsidian';
import { vaultTags } from './tags.js';
import { PdfPages, pdfPageInView } from './pdf-pages.js';
import bundle from 'virtual:web-app';
import { InlineApp } from './inline-app.js';
import { obsidianTheme, tellTheme } from './theme.js';
import { HostBridge } from './bridge.js';
import { watchKeyboard } from './keyboard.js';
import { askAtLaunch } from './consent.js';
import { createSession, linkToStroke, strokesOfState } from './session.js';
import { ErrorLog, pluginWatcher, reportsAddress, sendReport, withPluginSlow } from './report.js';
import { GRAPH_FILTER, GRAPH_HOW, copyGraphFilter } from './graph.js';
import { DEFAULT_INDEX_FOLDER, Indexer, isIndexPath, noteForIndex, noteOfIndex, strokesForIndexPlace } from './index-note.js';

export const VIEW_TYPE = 'bedrock-note';
const EXTENSION = 'bedrock';
const MAX_CAMERAS = 500;
/** How long after Obsidian starts the WebAssembly is compiled. */
const WASM_WARM_MS = 1500;

/** "Share with the Bedrock team" for the plugin's own errors: the exact
 *  report, an optional comment, and Send. (The canvas has its own panel.) */
/** The window the launch gate is shown in (see consent.js). */
class ConsentModal extends Modal {
  constructor(app, { mount, onClose }) {
    super(app);
    this.mount = mount;
    this.whenClosed = onClose;
  }

  onOpen() {
    this.modalEl?.addClass?.('bedrock-consent-modal');
    this.mount(this.contentEl);
  }

  onClose() {
    this.contentEl.empty?.();
    this.whenClosed();
  }
}

class ReportModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    const log = this.plugin.errors;
    const now = Date.now();
    const report = () => {
      const r = log.report({ comment: comment.value, appVersion: this.plugin.manifest.version, now });
      r.id = id;
      return r;
    };
    contentEl.createEl('h2', { text: 'Share with the Bedrock team' });
    contentEl.createEl('p', { text: log.list.length
      ? 'This is everything that will be sent: what went wrong, the plugin version and the kind of device. No notes, no file names, nothing about you. Nothing is sent until you press Send.'
      : 'Nothing has gone wrong that Bedrock noticed. Say what happened and it is sent with the plugin version and the kind of device.' });
    const comment = contentEl.createEl('textarea', { attr: { placeholder: 'What were you doing? (optional)', maxlength: '2000', rows: '3' }, cls: 'bedrock-report-comment' });
    const pre = contentEl.createEl('pre', { cls: 'bedrock-report' });
    const id = log.report({ now }).id;
    const row = contentEl.createDiv({ cls: 'bedrock-report-row' });
    const status = row.createSpan({ cls: 'bedrock-report-status' });
    const copy = row.createEl('button', { text: 'Copy' });
    const send = row.createEl('button', { text: 'Send', cls: 'mod-cta' });
    const render = () => {
      const r = report();
      pre.setText(JSON.stringify(r, null, 2));
      send.disabled = !reportsAddress() || (!r.errors.length && !r.comment);
    };
    render();
    if (!reportsAddress()) status.setText('Sending is not switched on in this version yet: copy the report and email it to us.');
    comment.addEventListener('input', render);
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(pre.textContent); status.setText('Copied.'); } catch (_) { status.setText('Select the text and copy it.'); }
    });
    send.addEventListener('click', async () => {
      send.disabled = true;
      status.setText('Sending…');
      try {
        const sent = await this.plugin.sendReport(report());
        status.setText(`Sent, thank you. Report ${sent}`);
        log.clear();
        send.remove();
      } catch (e) {
        status.setText(e.message);
        send.disabled = false;
      }
    });
  }

  onClose() { this.contentEl?.empty?.(); }
}

class BedrockView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = true;
    this.frame = null;
    this.bridge = null;
    this.session = null;
    this.keyboard = null;
    // Ink to show once the canvas has loaded the note (a search hit, a link).
    this.pending = null;
    this.appReady = false;
  }

  /** Obsidian calls this after opening the file, and again when a file
   *  that is already open is opened once more (another search hit). */
  setEphemeralState(state) {
    super.setEphemeralState?.(state);
    const strokes = strokesOfState(state);
    if (!strokes.length) return;
    this.pending = strokes;
    this.showPending();
  }

  showPending() {
    if (!this.appReady || !this.pending || !this.bridge) return;
    const strokes = this.pending;
    this.pending = null;
    this.bridge.send('show', { strokes }).catch(() => null);
  }

  /** How much of the bottom of the canvas is hidden (by the keyboard). */
  tellInset(bottom) {
    if (this.appReady && this.bridge) this.bridge.send('inset', { bottom }, 1000).catch(() => null);
  }

  getViewType() { return VIEW_TYPE; }

  getDisplayText() { return this.file ? this.file.basename : 'Bedrock'; }

  getIcon() { return 'pen-tool'; }

  canAcceptExtension(ext) { return ext === EXTENSION; }

  async onLoadFile(file) {
    const plugin = this.plugin;
    this.appReady = false;
    this.session = createSession({
      viewOnly: plugin.viewOnly,
      vault: this.app.vault,
      file: () => this.file,
      indexer: plugin.settings.index ? plugin.indexer : null,
      kv: plugin.kv,
      listFiles: async (sourcePath) => plugin.linkableFiles(sourcePath),
      listTags: async () => vaultTags(this.app, getAllTags),
      pdfPage: (path, page, width) => plugin.pdfPages.page(path, page, width),
      pdfFind: (path, query) => plugin.pdfPages.find(path, query),
      openLink: (target, sourcePath) => this.app.workspace.openLinkText(target, sourcePath, false),
      copyLink: (stroke) => plugin.copyLink(this.file, stroke),
      start: () => plugin.takeStart(this.file),
      paper: () => plugin.settings.newNotePaper,
      sendReport: (report) => plugin.sendReport(report),
      perf: plugin.perf,
      rename: (name) => plugin.renameNote(this.file, name),
      wasm: () => plugin.webApp.wasmModule(),
      onReady: () => { this.appReady = true; this.showPending(); this.tellInset(this.keyboard?.covered() || 0); },
    });
    const frame = this.contentEl.createEl('iframe', { cls: 'bedrock-frame', attr: { allow: 'clipboard-read; clipboard-write' } });
    this.frame = frame;
    this.bridge = new HostBridge(() => frame.contentWindow, this.session.handlers);
    this.bridge.listen(frame.ownerDocument.defaultView);
    // The iPad's keyboard covers the bottom of the view without resizing it:
    // tell the canvas, so its menus stay above the keyboard.
    this.keyboard = watchKeyboard(frame.ownerDocument.defaultView, frame, (bottom) => this.tellInset(bottom));
    // The page is written into the frame, not loaded from the plugin
    // folder: Obsidian refuses file requests from inside a view.
    frame.srcdoc = plugin.webApp.page('app', { viewOnly: plugin.viewOnly });
  }

  async onUnloadFile() {
    // Save what was drawn last before the iframe goes away.
    await this.bridge?.send('flush', {}, 3000).catch(() => null);
    // And bring its index note up to date (it waits for writing to pause).
    await this.session?.flushIndex().catch(() => null);
    this.keyboard?.stop();
    this.keyboard = null;
    this.bridge?.close();
    this.frame?.remove();
    this.frame = this.bridge = this.session = null;
    this.appReady = false;
  }

  /** Obsidian renamed or moved the file (from anywhere, the canvas
   *  header included): the header shows the file's name. */
  async onRename(file) {
    await super.onRename?.(file);
    await this.bridge?.send('renamed', { name: file.basename }).catch(() => null);
  }

  /** The file changed outside this view (sync, another window). */
  fileChanged(file) {
    if (this.session?.isOutsideChange(file)) this.bridge.send('reload');
  }
}

/** Notes are view only in Obsidian's desktop app (Mac, Windows, Linux),
 *  and editable on the iPad and phones. */
export function isViewOnly(platform) {
  return !!platform?.isDesktopApp && !platform?.isMobileApp;
}

/** Paper patterns a note can have, as the setting names them. */
export const PAPERS = { grid: 'Grid', dots: 'Dots', lines: 'Lines', plain: 'Plain' };

const DEFAULT_SETTINGS = { index: true, indexFolder: DEFAULT_INDEX_FOLDER, newNoteFolder: '', newNotePaper: 'grid' };

export default class BedrockPlugin extends Plugin {
  async onload() {
    this.errors = new ErrorLog();
    // The plugin's own slow jobs; they go with the canvas's automatic
    // performance reports when the person switched those on (perf.js).
    this.mobile = !!Platform?.isMobile;
    // On a desktop computer (Mac, Windows, Linux) notes are view only: they
    // open, move, zoom and follow links, but nothing draws in them or
    // changes them, and no new notes are made. The iPad and phones edit.
    this.viewOnly = isViewOnly(Platform);
    this.perf = pluginWatcher(this.errors, { mobile: this.mobile });
    this.slowSentUpTo = 0;
    const data = (await this.loadData()) || {};
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    this.cameras = data.cameras || {};
    // Links a new note starts with (note path -> { noteLinks }), handed to
    // its canvas once, when it opens (see newNote).
    this.starts = new Map();
    // The canvas's pages and files, handed to it from memory (inline-app.js).
    // Its chrome is light or dark with Obsidian's theme (theme.js).
    this.webApp = new InlineApp(bundle, { theme: () => obsidianTheme(globalThis.document?.body) });
    this.register(() => this.webApp.revoke());
    this.registerEvent(this.app.workspace.on('css-change', () => this.followTheme()));
    this.indexer = new Indexer(this.app.vault, () => this.settings.indexFolder,
      (link, source) => this.app.metadataCache.getFirstLinkpathDest?.(link, source)?.path ?? null);
    // A PDF's pages for the canvas's link picker, drawn with Obsidian's own
    // PDF.js, and searched with the find controller of Obsidian's PDF viewer.
    this.pdfPages = new PdfPages({
      pdfjs: () => loadPdfJs(),
      read: async (path) => {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (!(f instanceof TFile)) throw new Error('No such file.');
        return { bytes: await this.app.vault.readBinary(f), version: f.stat.mtime };
      },
    });
    this.register(() => this.pdfPages.close());
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

    // Notes are made on every device, a view-only desktop too: there they
    // open view only, to be written on the iPad.
    this.addRibbonIcon('pen-tool', 'New Bedrock note', () => this.newNote());
    // Holding a folder (iPad) or right-clicking it (desktop): a new note in it.
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFolder)) return;
      menu.addItem((item) => item
        .setTitle('New Bedrock note')
        .setIcon('pen-tool')
        .onClick(() => this.newNote(file.path)));
    }));
    this.addCommand({ id: 'new-note', name: 'New handwritten note', callback: () => this.newNote() });
    this.addCommand({
      id: 'new-linked-note',
      name: 'New handwritten note linking here',
      checkCallback: (checking) => {
        const about = this.aboutActive();
        if (!about) return false;
        if (!checking) this.newNote(undefined, about);
        return true;
      },
    });
    this.addCommand({ id: 'report-problem', name: 'Report a problem with Bedrock', callback: () => new ReportModal(this.app, this).open() });
    this.addCommand({ id: 'reindex', name: 'Rebuild search index of handwritten notes', callback: () => this.reindex(true) });
    this.addCommand({ id: 'graph-filter', name: 'Copy graph filter that hides .bedrock files and the #bedrock tag', callback: () => this.copyGraphFilter() });
    this.addSettingTab(new BedrockSettings(this.app, this));

    const vault = this.app.vault;
    this.registerEvent(vault.on('modify', (f) => {
      if (!(f instanceof TFile) || f.extension !== EXTENSION) return;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.fileChanged?.(f);
    }));
    this.registerEvent(vault.on('rename', async (f, oldPath) => {
      if (!(f instanceof TFile) || f.extension !== EXTENSION) return;
      // The camera follows the note whether or not it is searchable.
      let moved = false;
      for (const k of Object.keys(this.cameras)) {
        if (k.startsWith(`${oldPath}\u0000`)) { this.cameras[f.path + k.slice(oldPath.length)] = this.cameras[k]; delete this.cameras[k]; moved = true; }
      }
      if (moved) this.persist();
      if (!this.settings.index) return;
      await this.indexer.rename(oldPath, f.path, await vault.readBinary(f)).catch((e) => this.errors.record('Bedrock: search index not renamed', e, 'error'));
    }));
    this.registerEvent(vault.on('delete', (f) => {
      if (f instanceof TFile && f.extension === EXTENSION && this.settings.index) this.indexer.remove(f.path).catch((e) => this.errors.record('Bedrock: search index not removed', e, 'error'));
    }));
    // "New handwritten note linking here" in the menus of a note or PDF.
    this.registerLinkedNoteMenus();
    // A search result or link that lands on an index note opens the
    // handwriting, at the words that were found.
    this.redirectIndexNotes();
    // In case an index note was opened some other way: swap in the
    // handwriting, at the editor's cursor if it was put somewhere.
    this.registerEvent(this.app.workspace.on('file-open', async (f) => {
      const leaf = this.app.workspace.getMostRecentLeaf();
      if (!leaf || leaf.view?.file !== f) return;
      const cursor = leaf.view.editor?.getCursor?.();
      const at = cursor && (cursor.line || cursor.ch) ? { line: cursor.line, ch: cursor.ch } : null;
      const to = await this.handwritingFor(f, at).catch(() => null);
      if (to) await leaf.openFile(to.file, { eState: to.eState });
    }));
    // Notes edited by the web app or on another device get indexed too.
    this.app.workspace.onLayoutReady(() => {
      this.reindex(false);
      this.askConsent();
      // Compile the canvas's WebAssembly soon after Obsidian has started
      // (compiling runs off the main thread), so the first note need not
      // wait for it; every note after reuses it (inline-app.js).
      this.wasmWarm = new Promise((r) => setTimeout(r, WASM_WARM_MS)).then(() => this.webApp?.wasmModule()).catch(() => null);
    });
  }

  /** If `file` is an index note: the handwritten note to open in its
   *  place, and the ephemeral state that takes the view to the place
   *  `eState` points at in the index note. Otherwise null. */
  async handwritingFor(file, eState) {
    if (!this.settings.index || !(file instanceof TFile) || !isIndexPath(file.path, this.settings.indexFolder)) return null;
    const vault = this.app.vault;
    const markdown = await vault.cachedRead(file);
    const notePath = noteForIndex(file.path, markdown, (p) => vault.getAbstractFileByPath(p) instanceof TFile);
    const note = notePath && vault.getAbstractFileByPath(notePath);
    if (!(note instanceof TFile)) return null;
    // Places are found in the index as it was written (its own note path,
    // which differs if the folder was dropped in somewhere else).
    const layoutPath = noteOfIndex(markdown) || notePath;
    const strokes = eState
      ? await vault.readBinary(note).then((bytes) => strokesForIndexPlace(layoutPath, bytes, markdown, eState)).catch(() => [])
      : [];
    return { file: note, eState: strokes.length ? { bedrock: { strokes } } : {} };
  }

  /** Obsidian's search opens a result with `leaf.openFile(file, { eState:
   *  { match } })`, and only that call knows which match was clicked. So
   *  opening an index note is turned, there, into opening the handwriting
   *  with the matched words. Anything unexpected opens the file as asked. */
  redirectIndexNotes() {
    const proto = WorkspaceLeaf?.prototype;
    if (!proto || typeof proto.openFile !== 'function') return;
    const plugin = this;
    const original = proto.openFile;
    let on = true;
    const patched = async function (file, openState) {
      let to = null;
      if (on) {
        try { to = await plugin.handwritingFor(file, openState?.eState); } catch (_) { to = null; }
      }
      if (!to) return original.call(this, file, openState);
      const { state: _markdownState, ...rest } = openState || {};
      return original.call(this, to.file, { ...rest, eState: to.eState });
    };
    proto.openFile = patched;
    this.register(() => {
      on = false;
      // Leave it in place (switched off) if someone patched over it since.
      if (proto.openFile === patched) proto.openFile = original;
    });
  }

  /** Tells the person about a problem, with a Report button, and logs it. */
  problem(message, err) {
    this.errors.record(message, err);
    const notice = new Notice(message, 15000);
    const el = notice.noticeEl;
    if (el?.createEl) {
      const b = el.createEl('button', { text: 'Report', cls: 'bedrock-report-button' });
      b.addEventListener('click', (e) => { e.stopPropagation(); new ReportModal(this.app, this).open(); });
    }
    return notice;
  }

  /** While Bedrock is invite-only, ask for the invite code and consent
   *  as soon as Obsidian has started (consent.js). Resolves to how it
   *  went, or null where there is no window (tests without a DOM). */
  async askConsent() {
    if (typeof document === 'undefined') return null;
    this.consent = askAtLaunch({
      doc: document,
      page: (probe) => this.webApp.page('welcome', { probe }),
      open: (w) => { const m = new ConsentModal(this.app, w); m.open(); return m; },
    });
    return this.consent;
  }

  /** Sends an error report (the plugin's, or the canvas's through
   *  `send-report`). Resolves to its id. */
  async sendReport(report) {
    const { report: out, last } = withPluginSlow(report, this.errors, { since: this.slowSentUpTo, mobile: this.mobile });
    const id = await sendReport(out, requestUrl);
    this.slowSentUpTo = last;
    return id;
  }

  /** Rename a note to `name` (no extension) in its folder, as typed in
   *  the canvas header. Obsidian's file manager does it, so links to the
   *  note are updated as for any rename; the index note and camera follow
   *  through the vault's rename event. A name another file already has is
   *  refused with a notice, as Obsidian refuses it. Resolves to the note's
   *  name after. */
  async renameNote(file, name) {
    if (this.viewOnly) return file?.basename ?? '';
    if (!(file instanceof TFile) || !name || name === file.basename) return file?.basename ?? '';
    const folder = file.parent?.path && file.parent.path !== '/' ? `${file.parent.path}/` : (file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '');
    const path = normalizePath(`${folder}${name}.${EXTENSION}`);
    const there = this.app.vault.getAbstractFileByPath(path);
    if (there && there !== file) {
      new Notice(`“${name}.${EXTENSION}” already exists in this folder, so the note keeps its name.`);
      return file.basename;
    }
    try {
      await this.app.fileManager.renameFile(file, path);
    } catch (e) {
      this.problem(`Bedrock: the note could not be renamed: ${e?.message || e}`, e);
    }
    return file.basename;
  }

  /** Put a link to a word of a handwritten note on the clipboard. */
  async copyLink(file, stroke) {
    const text = linkToStroke(this.app.metadataCache.fileToLinktext(file, '', true), stroke);
    try {
      await navigator.clipboard.writeText(text);
      new Notice('Link to this word copied. Paste it into a note.');
    } catch (_) {
      new Notice(`Could not copy. The link is ${text}`, 10000);
    }
  }

  async persist() {
    await this.saveData({ settings: this.settings, cameras: this.cameras });
  }

  /** The graph filter goes on the clipboard: Obsidian offers plugins no
   *  way to set the graph's filters (graph.js). */
  copyGraphFilter() {
    return copyGraphFilter(globalThis.navigator?.clipboard, (msg) => new Notice(msg, 12000));
  }

  async reindex(announce) {
    if (!this.settings.index) return;
    const n = await this.indexer.sync().catch((e) => {
      console.warn('Bedrock: indexing failed', e);
      this.errors.record('Bedrock: indexing failed', e, 'error');
      return 0;
    });
    if (announce) new Notice(`Bedrock: ${n} handwritten note${n === 1 ? '' : 's'} indexed.`);
  }

  /** Every file in the vault the canvas's link picker offers: not the
   *  note itself or index notes, with the link text Obsidian would use. */
  linkableFiles(sourcePath) {
    const isIndex = (path) => path.endsWith('.bedrock.md') || (this.settings.index && isIndexPath(path, this.settings.indexFolder));
    return this.app.vault.getFiles()
      .filter((f) => f.path !== sourcePath && !isIndex(f.path))
      .map((f) => ({ path: f.path, link: this.app.metadataCache.fileToLinktext(f, sourcePath, true) }));
  }

  /** What a new note would link to from the active view: the Markdown
   *  note, or the PDF at the page in view. Null for anything else. */
  aboutActive() {
    const leaf = this.app.workspace.getMostRecentLeaf?.();
    const file = leaf?.view?.file || this.app.workspace.getActiveFile();
    return this.aboutFile(file, leaf);
  }

  /** `{ file, page }` for a Markdown note or a PDF (`page` when the PDF is
   *  open in `leaf`, at the page in view or under `at`). */
  aboutFile(file, leaf = null, at = null) {
    if (!(file instanceof TFile) || !['md', 'pdf'].includes(file.extension)) return null;
    if (file.extension === 'md' && isIndexPath(file.path, this.settings.index ? this.settings.indexFolder : '')) return null;
    const el = leaf?.view?.file === file ? leaf.view.containerEl : null;
    const page = file.extension === 'pdf' && el ? pdfPageInView(el, at) : null;
    return { file, page };
  }

  /** The link a new note at `notePath` keeps to the page it was made about. */
  linkTo({ file, page }, notePath) {
    const link = this.app.metadataCache.fileToLinktext(file, notePath, true);
    return page
      ? { target: `${link}#page=${page}`, type: 'note', text: `${file.basename}, page ${page}` }
      : { target: link, type: 'note', text: file.basename };
  }

  /** Adds "New handwritten note linking here" to a menu. */
  addLinkedNoteItem(menu, about) {
    if (!about) return;
    menu.addItem((item) => {
      item.setTitle('New handwritten note linking here').setIcon('pen-tool').onClick(() => this.newNote(undefined, about));
      item.setSection?.('action');
    });
  }

  /** The item goes in the editor's menu (right-click; a long press on the
   *  iPad), in a file's menu (a tab's ⋯ and header, the file explorer) and
   *  in a right-click inside a PDF that Obsidian leaves unanswered. */
  registerLinkedNoteMenus() {
    const ws = this.app.workspace;
    this.registerEvent(ws.on('editor-menu', (menu, _editor, info) => {
      this.addLinkedNoteItem(menu, this.aboutFile(info?.file));
    }));
    this.registerEvent(ws.on('file-menu', (menu, file, _source, leaf) => {
      // From the explorer there is no leaf: a PDF found open still links its page.
      const open = leaf || ws.getLeavesOfType?.('pdf').find((l) => l.view?.file === file) || null;
      this.addLinkedNoteItem(menu, this.aboutFile(file, open));
    }));
    if (typeof document !== 'undefined') this.registerDomEvent(document, 'contextmenu', (e) => this.pdfContextMenu(e));
  }

  /** A right-click inside a PDF that Obsidian did not answer with a menu
   *  of its own: offer a note linking the page under the pointer. */
  pdfContextMenu(e) {
    if (e.defaultPrevented) return;
    const leaf = this.app.workspace.getLeavesOfType?.('pdf').find((l) => l.view?.containerEl?.contains(e.target));
    const about = leaf && this.aboutFile(leaf.view.file, leaf, e.target);
    if (!about) return;
    const menu = new Menu();
    this.addLinkedNoteItem(menu, about);
    menu.showAtMouseEvent(e);
    e.preventDefault();
  }

  /** The starting links of a note made by newNote, once. */
  /** Obsidian's theme changed: every open canvas and the launch gate
   *  follow it at once. */
  followTheme() {
    const theme = obsidianTheme(globalThis.document?.body);
    const frames = this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view?.frame);
    frames.push(...(globalThis.document?.querySelectorAll?.('iframe.bedrock-welcome-frame') || []));
    tellTheme(frames, theme);
  }

  takeStart(file) {
    const start = file && this.starts.get(file.path);
    if (start) this.starts.delete(file.path);
    return start || null;
  }

  /** Makes an empty note and opens it: in `inFolder` when given (a
   *  folder's menu), otherwise in the folder for new notes or beside the
   *  open file (or the page it is about). With `about` (`{ file, page }`),
   *  it is named after that page and starts with a link to it. */
  async newNote(inFolder, about = null) {
    const active = about?.file || this.app.workspace.getActiveFile();
    const folder = inFolder ?? (this.settings.newNoteFolder || active?.parent?.path || '');
    const dir = folder && folder !== '/' ? `${folder}/` : '';
    const base = about ? `${about.file.basename}${about.page ? ` page ${about.page}` : ''} notes`.replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim() : 'Handwritten note';
    let path;
    for (let n = 0; ; n++) {
      path = normalizePath(`${dir}${base}${n ? ` ${n}` : ''}.${EXTENSION}`);
      if (!this.app.vault.getAbstractFileByPath(path)) break;
    }
    if (dir) await this.indexer.ensureFolder(folder);
    if (about) this.starts.set(path, { noteLinks: [this.linkTo(about, path)] });
    // An empty file is a new note; the canvas writes the first save.
    const file = await this.app.vault.createBinary(path, new ArrayBuffer(0));
    await this.app.workspace.getLeaf(true).openFile(file);
    return file;
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
      .setDesc('Keep a Markdown index note for each handwritten note, with the text read from the handwriting and its links, so Obsidian search, backlinks and the graph include them. Opening an index note opens the handwriting, and a search result opens it at the words that were found.')
      .addToggle((t) => t.setValue(p.settings.index).onChange(async (v) => {
        p.settings.index = v;
        await p.persist();
        if (v) p.reindex(true);
      }));
    new Setting(containerEl)
      .setName('Index folder')
      .setDesc('Where index notes are kept. Leave empty to keep each beside its note as “Name.bedrock.md”. A note that already has one beside it, as notes exported from the Bedrock website do, keeps using that one.')
      .addText((t) => t.setPlaceholder(DEFAULT_INDEX_FOLDER).setValue(p.settings.indexFolder).onChange(async (v) => {
        p.settings.indexFolder = normalizePath(v.trim() || '/').replace(/^\/$/, '');
        await p.persist();
      }));
    new Setting(containerEl)
      .setName('Tidy graph view')
      .setDesc(`Shows each handwritten note once (its index note, which keeps its links to notes and PDF pages) and hides the #bedrock tag. Copy the filter, then: ${GRAPH_HOW} The filter is: ${GRAPH_FILTER}`)
      .addButton((b) => b.setButtonText('Copy filter').onClick(() => p.copyGraphFilter()));
    new Setting(containerEl)
      .setName('Folder for new notes')
      .setDesc('Leave empty to create new notes next to the open file.')
      .addText((t) => t.setValue(p.settings.newNoteFolder).onChange(async (v) => {
        p.settings.newNoteFolder = v.trim() ? normalizePath(v.trim()) : '';
        await p.persist();
      }));
    new Setting(containerEl)
      .setName('Paper for new notes')
      .setDesc('The paper a new note starts with. Notes you already have keep their own paper, and each note can be changed in its menu.')
      .addDropdown((d) => d.addOptions(PAPERS).setValue(PAPERS[p.settings.newNotePaper] ? p.settings.newNotePaper : 'grid').onChange(async (v) => {
        p.settings.newNotePaper = PAPERS[v] ? v : 'grid';
        await p.persist();
      }));
  }
}
