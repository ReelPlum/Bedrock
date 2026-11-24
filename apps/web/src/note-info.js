// "Tags and links" (main menu): the tags and links of the whole note, which
// belong to no ink (`tags` and `noteLinks` in note.json, see
// docs/note-format.md). A tag is added by typing it; a link by the host's
// picker (a vault file, PDF page or word in Obsidian) or by typing a web
// address. Each can be opened (links) or removed. With `lockLinks` (a
// view-only note) tags are still added and removed, and links only shown
// and opened.
//
// Typing a tag suggests tags already in use (tag-suggest.js): in the
// library, or in Obsidian the whole vault. They sit above the tag box, so
// the iPad's keyboard (which covers the bottom of the screen) never hides
// them, and picking one keeps the box focused and the keyboard up.

import { LINK_TYPES, linkType } from './links.js';
import { suggestTags } from './tag-suggest.js';

const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
};

export class NoteInfo {
  /** `canvas` is the WebAssembly canvas; `onChange()` is called after the
   *  note's tags or links changed (to save it). `knownTags()` resolves to
   *  the tags in use elsewhere, `[{ tag, count }]`, to suggest. */
  constructor(root, canvas, { onChange, lockLinks = false, knownTags = null } = {}) {
    this.root = root;
    this.lockLinks = lockLinks;
    this.canvas = canvas;
    this.onChange = onChange || (() => {});
    this.knownTags = knownTags;
    this.known = [];
    this.active = -1;
    root.classList.add('word-menu', 'note-info');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Tags and links');
    root.hidden = true;
    const close = el('button', { className: 'wm-close', type: 'button', textContent: '×', ariaLabel: 'Close' });
    close.addEventListener('click', () => this.close());
    this.tags = el('ul', { className: 'ni-tags' });
    this.tagInput = el('input', { type: 'text', placeholder: 'Add a tag', enterKeyHint: 'done', autocapitalize: 'off', spellcheck: false });
    this.tagInput.setAttribute('aria-label', 'New tag');
    // A combobox: the suggestions are its list, picked with the arrow keys
    // and Enter, or a tap.
    this.suggest = el('ul', { className: 'ni-suggest', id: 'ni-suggest', hidden: true });
    this.suggest.setAttribute('role', 'listbox');
    this.suggest.setAttribute('aria-label', 'Tags in use');
    this.tagInput.setAttribute('role', 'combobox');
    this.tagInput.setAttribute('aria-autocomplete', 'list');
    this.tagInput.setAttribute('aria-controls', 'ni-suggest');
    this.tagInput.setAttribute('aria-expanded', 'false');
    this.tagInput.addEventListener('input', () => { this.active = -1; this.renderSuggestions(); });
    this.tagInput.addEventListener('keydown', (e) => this.suggestKey(e));
    // A tap on a suggestion must not take focus from the box: on the iPad
    // that would put the keyboard away.
    this.suggest.addEventListener('pointerdown', (e) => e.preventDefault());
    this.suggest.addEventListener('mousedown', (e) => e.preventDefault());
    this.suggest.addEventListener('click', (e) => {
      const o = e.target.closest?.('.ni-option');
      if (o) this.addTag(o.dataset.tag);
    });
    const addTag = el('button', { type: 'button', className: 'wm-save', textContent: 'Add' });
    const tagForm = el('form', { className: 'ni-row ni-tag-row' }, this.suggest, this.tagInput, addTag);
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
    if (lockLinks) urlForm.hidden = true;
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
    this.loadKnownTags();
  }

  /** Ask again for the tags in use each time the panel opens: other notes
   *  may have changed since. */
  async loadKnownTags() {
    if (!this.knownTags) return;
    let known = [];
    try { known = (await this.knownTags()) || []; } catch (e) { console.warn('tags in use not read', e); }
    this.known = Array.isArray(known) ? known : [];
    if (this.open) this.renderSuggestions();
  }

  /** The suggestions for what is typed, above the tag box. */
  renderSuggestions() {
    const { tags = [] } = this.info();
    const list = suggestTags(this.tagInput.value, this.known, tags);
    if (this.active >= list.length) this.active = list.length - 1;
    this.suggest.replaceChildren(...list.map(({ tag, count }, i) => {
      const o = el('li', { className: 'ni-option', id: `ni-option-${i}`, textContent: `#${tag}` });
      o.dataset.tag = tag;
      o.title = count === 1 ? 'Used in 1 note' : `Used in ${count} notes`;
      o.setAttribute('role', 'option');
      o.setAttribute('aria-selected', String(i === this.active));
      return o;
    }));
    this.suggest.hidden = !list.length;
    this.tagInput.setAttribute('aria-expanded', String(!!list.length));
    if (this.active >= 0) this.tagInput.setAttribute('aria-activedescendant', `ni-option-${this.active}`);
    else this.tagInput.removeAttribute('aria-activedescendant');
  }

  /** Arrow keys move through the suggestions, Enter takes the one chosen,
   *  Escape lets go of it. */
  suggestKey(e) {
    const n = this.suggest.children.length;
    if (this.suggest.hidden || !n) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this.active = this.active < 0 ? (step > 0 ? 0 : n - 1) : (this.active + step + n) % n;
      this.renderSuggestions();
    } else if (e.key === 'Enter' && this.active >= 0) {
      e.preventDefault();
      this.addTag(this.suggest.children[this.active].dataset.tag);
    } else if (e.key === 'Escape' && this.active >= 0) {
      e.preventDefault();
      e.stopPropagation();
      this.active = -1;
      this.renderSuggestions();
    }
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
    this.renderSuggestions();
    this.links.replaceChildren(...noteLinks.map((l) => {
      const type = linkType(l.type);
      const label = l.text || (type ? type.describe(l.target) : l.target);
      const open = el('button', { type: 'button', className: 'ni-open', textContent: label, title: l.target });
      open.addEventListener('click', () => type?.open(l.target));
      const x = el('button', { type: 'button', className: 'ni-remove', textContent: '×', ariaLabel: `Remove link to ${label}` });
      x.addEventListener('click', () => { if (this.canvas.remove_note_link(l.target)) this.changed(); });
      return el('li', { className: 'ni-link' }, open, ...(this.lockLinks ? [] : [x]));
    }));
    if (!noteLinks.length) this.links.append(el('li', { className: 'ni-none', textContent: 'No links yet.' }));
    this.browse.hidden = this.lockLinks || !LINK_TYPES.some((t) => t.available && t.pick);
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
    this.active = -1;
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
