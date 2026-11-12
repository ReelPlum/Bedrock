// An in-memory stand-in for Obsidian's Vault, with the methods the plugin
// uses. Runs in Node and in the browser test harness.
let clock = 1_800_000_000_000;

export class FakeVault {
  constructor() {
    this.files = new Map();
    this.folders = new Set();
    this.log = [];
  }

  _file(path, data) {
    const name = path.split('/').pop();
    const dot = name.lastIndexOf('.');
    const now = ++clock;
    const f = {
      path,
      name,
      basename: dot > 0 ? name.slice(0, dot) : name,
      extension: dot > 0 ? name.slice(dot + 1) : '',
      stat: { ctime: now, mtime: now, size: 0 },
      data,
    };
    this.files.set(path, f);
    return f;
  }

  _touch(f, data) {
    f.data = data;
    f.stat.mtime = ++clock;
  }

  getAbstractFileByPath(path) {
    return this.files.get(path) || (this.folders.has(path) ? { path, children: [] } : null);
  }

  getFiles() { return [...this.files.values()]; }

  async read(f) { return f.data; }

  async cachedRead(f) { return f.data; }

  async readBinary(f) {
    const d = f.data;
    if (typeof d === 'string') return new TextEncoder().encode(d).buffer;
    return d.slice(0);
  }

  async create(path, text) {
    if (this.files.has(path)) throw new Error('File already exists.');
    this.log.push(['create', path]);
    return this._file(path, text);
  }

  async createBinary(path, data) {
    if (this.files.has(path)) throw new Error('File already exists.');
    this.log.push(['create', path]);
    return this._file(path, data.slice(0));
  }

  async createFolder(path) {
    if (this.folders.has(path)) throw new Error('Folder already exists.');
    this.folders.add(path);
  }

  async modify(f, text) {
    this.log.push(['modify', f.path]);
    this._touch(f, text);
  }

  async modifyBinary(f, data) {
    this.log.push(['modify', f.path]);
    this._touch(f, data.slice(0));
  }

  async delete(f) {
    this.log.push(['delete', f.path]);
    this.files.delete(f.path);
  }

  /** Test helper: change a file as another device would. */
  outsideChange(path, data) {
    this._touch(this.files.get(path), data);
  }
}
