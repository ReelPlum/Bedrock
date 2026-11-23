// "Tags and links" (main menu): the tags and links of the whole note, which
// belong to no ink (`tags` and `noteLinks` in note.json, see
// docs/note-format.md). A tag is added by typing it; a link by the host's
// picker (a vault file, PDF page or word in Obsidian) or by typing a web
// address. Each can be opened (links) or removed.

import { LINK_TYPES, linkType } from './links.js';

const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
};

export class NoteInfo {
  /** `canvas` is the WebAssembly canvas; `onChange()` is called after the
   *  note's tags or links changed (to save it). */
  constructor(root, canvas, { onChange } = {}) {
    this.root = root;
    this.canvas = canvas;
    this.onChange = onChange || (() => {});
    root.classList.add('word-menu', 'note-info');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Tags and links');
    root.hidden = true;
    const close = el('button', { className: 'wm-close', type: 'button', textContent: '×', ariaLabel: 'Close' });
    close.addEventListener('click', () => this.close());
    this.tags = el('ul', { className: 'ni-tags' });
    this.tagInput = el('input', { type: 'text', placeholder: 'Add a tag', enterKeyHint: 'done', autocapitalize: 'off', spellcheck: false });
    this.tagInput.setAttribute('aria-label', 'New tag');
    const addTag = el('button', { type: 'button', className: 'wm-save', textContent: 'Add' });
    const tagForm = el('form', { className: 'ni-row' }, this.tagInput, addTag);
    tagForm.addEventListener('submit', (e) => { e.preventDefault(); this.addTag(this.tagInput.value); });
    addTag.addEventListener('click', (e) => { e.preventDefault(); this.addTag(this.tagInput.value); });
    this.links = el('ul', { className: 'ni-links' });
    this.error = el('div', { className: 'wm-error', hidden: true });
    // A picker for a vault file where the host has one, and a typed web address.
    this.browse = el('button', { type: 'button', className: 'ni-browse', textContent: 'Link a file in the vault…' });
    this.browse.addEventListener('click', () => this.browseLink());
    this.urlInput = el('input', { type: 'url', placeholder: linkType('url').placeholder, enterKeyHint: 'done', autocapitalize: 'off', spellcheck: false });
    this.urlInput.setAttribute('aria-label', 'Web address to link');
    const addUrl = el('button', { type: 'button', className: 'wm-save', textContent: 'Add' });
    // Not checked by the browser: "example.com" is tidied into an address here.
    const urlForm = el('form', { className: 'ni-row', noValidate: true }, this.urlInput, addUrl);
    urlForm.addEventListener('submit', (e) => { e.preventDefault(); this.addUrl(); });
    addUrl.addEventListener('click', (e) => { e.preventDefault(); this.addUrl(); });
    root.append(
      el('div', { className: 'wm-head' }, el('span', { className: 'wm-word', textContent: 'Tags and links' }), close),
      el('div', { className: 'wm-form' },
        el('div', { className: 'ni-label', textContent: 'Tags' }), this.tags, tagForm,
        el('div', { className: 'ni-label', textContent: 'Links of the whole note' }), this.links, this.browse, urlForm, this.error),
    );
    document.addEventListener('pointerdown', (e) => {
      // The link picker opens over the panel, which waits for its answer.
      if (!root.hidden && !root.contains(e.target) && !e.target.closest?.('#link-picker') && !e.target.closest?.('[data-action="note-info"]')) this.close();
    });
  }

  get open() { return !this.root.hidden; }

  info() {
    try { return JSON.parse(this.canvas.note_info_json()); } catch (_) { return { noteLinks: [], tags: [] }; }
  }

  show() {
    this.root.hidden = false;
    this.render();
  }

  close() {
    this.root.hidden = true;
    this.say('');
  }

  say(message) {
    this.error.textContent = message;
    this.error.hidden = !message;
  }

  render() {
    const { noteLinks = [], tags = [] } = this.info();
    this.tags.replaceChildren(...tags.map((t) => {
      const x = el('button', { type: 'button', className: 'ni-remove', textContent: '×', ariaLabel: `Remove tag ${t}` });
      x.addEventListener('click', () => { if (this.canvas.remove_tag(t)) this.changed(); });
      return el('li', { className: 'ni-tag' }, el('span', { textContent: `#${t}` }), x);
    }));
    if (!tags.length) this.tags.append(el('li', { className: 'ni-none', textContent: 'No tags yet.' }));
    this.links.replaceChildren(...noteLinks.map((l) => {
      const type = linkType(l.type);
      const label = l.text || (type ? type.describe(l.target) : l.target);
      const open = el('button', { type: 'button', className: 'ni-open', textContent: label, title: l.target });
      open.addEventListener('click', () => type?.open(l.target));
      const x = el('button', { type: 'button', className: 'ni-remove', textContent: '×', ariaLabel: `Remove link to ${label}` });
      x.addEventListener('click', () => { if (this.canvas.remove_note_link(l.target)) this.changed(); });
      return el('li', { className: 'ni-link' }, open, x);
    }));
    if (!noteLinks.length) this.links.append(el('li', { className: 'ni-none', textContent: 'No links yet.' }));
    this.browse.hidden = !LINK_TYPES.some((t) => t.available && t.pick);
  }

  changed() {
    this.say('');
    this.onChange();
    this.render();
  }

  addTag(raw) {
    if (!raw.trim()) return;
    const tag = this.canvas.add_tag(raw);
    if (!tag) return this.say('That is already a tag of this note, or not a tag (letters, digits, - _ and /).');
    this.tagInput.value = '';
    this.changed();
  }

  addUrl() {
    const target = linkType('url').normalize(this.urlInput.value);
    if (!target) return this.say('That is not a web address.');
    if (!this.canvas.add_note_link(target, 'url', '')) return this.say('The note already links there.');
    this.urlInput.value = '';
    this.changed();
  }

  async browseLink() {
    const t = LINK_TYPES.find((t) => t.available && t.pick);
    if (!t) return;
    let target = null;
    try { target = await t.pick(''); } catch (e) { console.warn('picker failed', e); }
    if (!target || this.root.hidden) return;
    target = t.normalize(target);
    if (!target) return;
    if (!this.canvas.add_note_link(target, t.id, '')) return this.say('The note already links there.');
    this.changed();
  }
}
