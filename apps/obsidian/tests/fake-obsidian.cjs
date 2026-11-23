// Just enough of the `obsidian` module to load the built plugin in Node and
// drive it: records what the plugin registers, and lets tests answer modals.
class Events {
  constructor() { this.handlers = {}; }
  on(name, fn) { (this.handlers[name] ||= []).push(fn); return { name, fn }; }
  async trigger(name, ...args) { for (const fn of this.handlers[name] || []) await fn(...args); }
}

class TFile {}
class TFolder {
  constructor(path) { this.path = path; this.children = []; }
  isRoot() { return this.path === '/'; }
}

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
  registerDomEvent(target, name, fn) { (this.domEvents ||= []).push({ target, name, fn }); }
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

/** Obsidian's PDF.js; tests set `loadPdfJs.lib`. */
async function loadPdfJs() { return loadPdfJs.lib; }
loadPdfJs.lib = null;

/** Records its items as `{ title, icon, section, click }`. */
class MenuItem {
  setTitle(t) { this.title = t; return this; }
  setIcon(i) { this.icon = i; return this; }
  setSection(s) { this.section = s; return this; }
  onClick(fn) { this.click = fn; return this; }
}
class Menu {
  constructor() { this.items = []; Menu.made.push(this); }
  addItem(fn) { const i = new MenuItem(); fn(i); this.items.push(i); return this; }
  showAtMouseEvent(e) { this.shownAt = e; return this; }
}
Menu.made = [];

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

module.exports = { Events, TFile, TFolder, Menu, WorkspaceLeaf, Plugin, Modal, FileView, loadPdfJs, PluginSettingTab, Setting, Notice, normalizePath, requestUrl };
