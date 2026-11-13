// Just enough of the `obsidian` module to load the built plugin in Node and
// drive it: records what the plugin registers, and lets tests answer modals.
class Events {
  constructor() { this.handlers = {}; }
  on(name, fn) { (this.handlers[name] ||= []).push(fn); return { name, fn }; }
  async trigger(name, ...args) { for (const fn of this.handlers[name] || []) await fn(...args); }
}

class TFile {}

class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.views = {};
    this.extensions = {};
    this.commands = [];
    this.ribbons = [];
    this.settingTabs = [];
    this.data = null;
  }
  async loadData() { return this.data; }
  async saveData(d) { this.data = JSON.parse(JSON.stringify(d)); }
  registerView(type, make) { this.views[type] = make; }
  registerExtensions(exts, type) { for (const e of exts) this.extensions[e] = type; }
  registerEvent() {}
  register(fn) { (this.cleanups ||= []).push(fn); }
  unload() { for (const fn of this.cleanups || []) fn(); }
  addCommand(c) { this.commands.push(c); }
  addRibbonIcon(icon, title, fn) { this.ribbons.push({ icon, title, fn }); }
  addSettingTab(t) { this.settingTabs.push(t); }
}

class Modal {
  constructor(app) {
    this.app = app;
    this.inputEl = { value: '' };
  }
  open() { Modal.opened.push(this); }
  close() { this.onClose(); }
  onClose() {}
}
Modal.opened = [];

class FuzzySuggestModal extends Modal {
  setPlaceholder(p) { this.placeholder = p; }
  setInstructions(i) { this.instructions = i; }
  /** Test helper: what Obsidian does when an item is chosen (close first). */
  choose(item) { this.close(); this.onChooseItem(item); }
}

class FileView { constructor(leaf) { this.leaf = leaf; } }

/** Records what was opened in it, as `leaf.opened`. */
class WorkspaceLeaf {
  constructor() { this.opened = []; this.view = null; }
  async openFile(file, openState) { this.opened.push({ path: file.path, openState }); }
}
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class Setting {}
class Notice { constructor(msg) { Notice.shown.push(msg); } }
Notice.shown = [];

/** Records requests; tests set `requestUrl.answer(req)` to reply. */
async function requestUrl(req) {
  requestUrl.calls.push(req);
  return requestUrl.answer(req);
}
requestUrl.calls = [];
requestUrl.answer = () => ({ status: 200, json: {} });

const normalizePath = (p) => p.replace(/\/+/g, '/').replace(/^\/|\/$/g, '') || '/';

module.exports = { Events, TFile, WorkspaceLeaf, Plugin, Modal, FuzzySuggestModal, FileView, PluginSettingTab, Setting, Notice, normalizePath, requestUrl };
