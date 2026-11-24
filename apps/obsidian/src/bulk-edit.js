// "Add tags…" and "Change paper…" in the file explorer's menu: tags added
// to, or the paper set on, every handwritten note picked (one note, many
// selected notes, or the notes in a folder), without opening them.
//
// Each note is changed by bedrock-core in a worker (note-edit-worker.js),
// exactly as the canvas changes it in "Tags and links…" or the paper menu,
// so there is no new data format. One note is read and held at a time, and
// Obsidian gets to run between notes. A note open in a view is saved first,
// and reloads with the change. Free of Obsidian imports so it can be tested
// on its own and in the browser harness. (openspec: obsidian-plugin,
// "Tags and paper SHALL be changed on many notes at once".)
//
// The forms are plain DOM, written into an Obsidian modal by the plugin.

import { isTag } from '../../web/src/sidecar.js';
import { suggestTags } from '../../web/src/tag-suggest.js';

export const EXTENSION = 'bedrock';

/** Paper patterns, as the canvas's menu and the settings name them. */
export const PAPERS = { grid: 'Grid', dots: 'Dots', lines: 'Lines', plain: 'Plain' };

const messageOf = (e) => String(e?.message || e || 'unknown error');

/** The handwritten notes among `files` (Obsidian's TAbstractFile list from
 *  `file-menu` or `files-menu`): `.bedrock` files, and those inside a
 *  folder and its folders. Each once, in the order found. */
export function notesIn(files) {
  const out = [];
  const seen = new Set();
  const walk = (f) => {
    if (!f) return;
    if (Array.isArray(f.children)) {
      for (const c of f.children) walk(c);
    } else if (f.extension === EXTENSION && !seen.has(f.path)) {
      seen.add(f.path);
      out.push(f);
    }
  };
  for (const f of Array.isArray(files) ? files : [files]) walk(f);
  return out;
}

/** A typed tag as it is stored: no `#`, spaces as `-` (as bedrock-core's
 *  `clean_tag`: other characters are dropped). Null if it is not a tag. */
export function typedTag(raw) {
  const t = String(raw ?? '').trim().replace(/^#+/, '').replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_\-/]/gu, '').replace(/\/{2,}/g, '/').replace(/^[-/]+|[-/]+$/g, '');
  return isTag(t) ? t : null;
}

/** What the menu says for `n` notes. */
export function menuTitles(n, folder = false) {
  if (folder) return { tags: 'Add tags to notes in this folder…', paper: 'Change paper of notes in this folder…' };
  return n === 1
    ? { tags: 'Add tags…', paper: 'Change paper…' }
    : { tags: `Add tags to ${n} notes…`, paper: `Change paper of ${n} notes…` };
}

const notes = (n) => (n === 1 ? '1 note' : `${n} notes`);

/** The notice when it is done. */
export function summary(s) {
  const what = s.tags?.length ? `Tagged ${s.tags.map((t) => `#${t}`).join(', ')}` : `Paper set to ${PAPERS[s.paper]?.toLowerCase() || s.paper}`;
  const parts = [`${what}: ${notes(s.changed.length)} changed`];
  if (s.unchanged.length) parts.push(`${notes(s.unchanged.length)} already ${s.tags?.length ? 'had them' : 'had it'}`);
  if (s.failed.length) parts.push(`${notes(s.failed.length)} not changed (${s.failed.map((f) => `${f.path}: ${f.reason}`).join('; ')})`);
  return `${parts.join('; ')}.`;
}

export class BulkEdit {
  /**
   * @param {object} o
   * @param {object} o.vault  Obsidian's Vault: readBinary, modifyBinary
   * @param {(bytes: ArrayBuffer, change: { tags: string[], paper: string }) => Promise<{ bedrock: ArrayBuffer } | null>} o.edit  the note's new bytes, null if nothing changes
   * @param {(file: object) => Promise<void>} [o.before]  save the note first if it is open
   * @param {(path: string, bytes: ArrayBuffer) => Promise<any>} [o.index]  bring its index note up to date
   * @param {() => Promise<void>} [o.pause]  lets Obsidian run between notes
   */
  constructor({ vault, edit, before = async () => {}, index = null, pause = () => new Promise((r) => setTimeout(r, 0)) }) {
    this.vault = vault;
    this.edit = edit;
    this.before = before;
    this.index = index;
    this.pause = pause;
    this.chain = Promise.resolve();
  }

  /** Add `tags` to, and/or set `paper` on, each of `files` (notes). Runs
   *  after any change already under way. Resolves to `{ tags, paper,
   *  changed, unchanged, failed: [{ path, reason }] }`. */
  run(files, { tags = [], paper = '' } = {}, onProgress = null) {
    const run = this.chain.then(() => this.runNow(files, { tags, paper }, onProgress));
    this.chain = run.catch(() => null);
    return run;
  }

  async runNow(files, change, onProgress) {
    // Each tag once, whatever its case (as a note holds it).
    const tags = [];
    for (const t of change.tags.map(typedTag)) if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
    const paper = PAPERS[change.paper] ? change.paper : '';
    const s = { tags, paper, changed: [], unchanged: [], failed: [] };
    const list = notesIn(files);
    if (!tags.length && !paper) return s;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      try {
        await this.before(f);
        const bytes = await this.vault.readBinary(f);
        if (!bytes?.byteLength) throw new Error('nothing written in it yet');
        // The worker takes the bytes over: hand it a copy of the vault's.
        const out = await this.edit(bytes.slice(0), { tags, paper });
        if (!out) {
          s.unchanged.push(f.path);
        } else {
          await this.vault.modifyBinary(f, out.bedrock);
          s.changed.push(f.path);
          if (this.index) await this.index(f.path, out.bedrock).catch(() => null);
        }
      } catch (e) {
        s.failed.push({ path: f.path, reason: messageOf(e) });
      }
      onProgress?.(i + 1, list.length);
      await this.pause();
    }
    return s;
  }
}

const el = (doc, tag, props = {}, ...children) => {
  const e = Object.assign(doc.createElement(tag), props);
  e.append(...children);
  return e;
};

/** "Add tags to 3 notes": the tags to add (each removable), a tag box that
 *  suggests tags in use in the vault (as the canvas's tag box does), and
 *  Add tags. `known()` resolves to `[{ tag, count }]`; `onSubmit(tags)` is
 *  called with the tags, `onCancel()` on Cancel. Returns the form's parts. */
export function mountTagForm(root, { count, known = async () => [], onSubmit, onCancel = () => {} }) {
  const doc = root.ownerDocument;
  const chosen = [];
  let inUse = [];
  let active = -1;
  const list = el(doc, 'ul', { className: 'bedrock-bulk-tags' });
  const suggest = el(doc, 'ul', { className: 'bedrock-bulk-suggest', hidden: true });
  suggest.setAttribute('role', 'listbox');
  suggest.setAttribute('aria-label', 'Tags in use');
  const input = el(doc, 'input', { type: 'text', placeholder: 'Type a tag', enterKeyHint: 'done', autocapitalize: 'off', spellcheck: false, className: 'bedrock-bulk-input' });
  input.setAttribute('aria-label', 'Tag to add');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  const error = el(doc, 'div', { className: 'bedrock-bulk-error', hidden: true });
  const add = el(doc, 'button', { type: 'submit', className: 'mod-cta', textContent: 'Add tags', disabled: true });
  const cancel = el(doc, 'button', { type: 'button', textContent: 'Cancel' });
  const form = el(doc, 'form', { className: 'bedrock-bulk-form' },
    el(doc, 'p', { textContent: `Each tag is added to ${count === 1 ? 'the note' : `all ${count} notes`}. Tags a note already has stay.` }),
    list, suggest, input, error, el(doc, 'div', { className: 'bedrock-bulk-buttons' }, cancel, add));

  const say = (m) => { error.textContent = m; error.hidden = !m; };
  const renderSuggest = () => {
    const opts = suggestTags(input.value, inUse, chosen);
    if (active >= opts.length) active = opts.length - 1;
    suggest.replaceChildren(...opts.map(({ tag, count: n }, i) => {
      const o = el(doc, 'li', { className: 'bedrock-bulk-option', textContent: `#${tag}`, title: n === 1 ? 'Used in 1 note' : `Used in ${n} notes` });
      o.dataset.tag = tag;
      o.setAttribute('role', 'option');
      o.setAttribute('aria-selected', String(i === active));
      return o;
    }));
    suggest.hidden = !opts.length;
    input.setAttribute('aria-expanded', String(!!opts.length));
  };
  const render = () => {
    list.replaceChildren(...chosen.map((t) => {
      const x = el(doc, 'button', { type: 'button', className: 'bedrock-bulk-remove', textContent: '×', ariaLabel: `Remove tag ${t}` });
      x.addEventListener('click', () => { chosen.splice(chosen.indexOf(t), 1); render(); });
      return el(doc, 'li', { className: 'bedrock-bulk-tag' }, el(doc, 'span', { textContent: `#${t}` }), x);
    }));
    add.disabled = !chosen.length && !typedTag(input.value);
    renderSuggest();
  };
  /** Add a tag to the list; false (and why) if it is not a tag. */
  const take = (raw) => {
    const t = typedTag(raw);
    if (!t) { if (String(raw ?? '').trim()) say(`“${String(raw).trim()}” is not a tag: use letters, digits, - _ and /.`); return false; }
    say('');
    if (!chosen.some((c) => c.toLowerCase() === t.toLowerCase())) chosen.push(t);
    input.value = '';
    active = -1;
    render();
    return true;
  };

  input.addEventListener('input', () => {
    // Tags typed in one go, split by commas: "physics, exam".
    if (input.value.includes(',')) {
      const parts = input.value.split(',');
      const rest = parts.pop();
      for (const p of parts) take(p);
      input.value = rest;
    }
    active = -1;
    say('');
    render();
  });
  input.addEventListener('keydown', (e) => {
    const n = suggest.children.length;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active = active < 0 ? (step > 0 ? 0 : n - 1) : (active + step + n) % n;
      renderSuggest();
    } else if (e.key === 'Enter') {
      // Enter adds the chosen suggestion or what is typed; with nothing
      // typed it adds the tags (the form's submit).
      if (active >= 0 && n) { e.preventDefault(); take(suggest.children[active].dataset.tag); } else if (input.value.trim()) { e.preventDefault(); take(input.value); }
    }
  });
  // A tap on a suggestion keeps the box focused (the iPad keyboard stays up).
  suggest.addEventListener('pointerdown', (e) => e.preventDefault());
  suggest.addEventListener('mousedown', (e) => e.preventDefault());
  suggest.addEventListener('click', (e) => {
    const o = e.target.closest?.('.bedrock-bulk-option');
    if (o) take(o.dataset.tag);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (input.value.trim() && !take(input.value)) return;
    if (chosen.length) onSubmit([...chosen]);
  });
  cancel.addEventListener('click', () => onCancel());
  root.append(form);
  render();
  Promise.resolve().then(known).then((k) => { inUse = Array.isArray(k) ? k : []; renderSuggest(); }, () => null);
  return { form, input, suggest, list, add, chosen };
}

/** "Change paper of 3 notes": one button per paper. `onSubmit(paper)`. */
export function mountPaperForm(root, { count, onSubmit, onCancel = () => {} }) {
  const doc = root.ownerDocument;
  const buttons = Object.entries(PAPERS).map(([paper, name]) => {
    const b = el(doc, 'button', { type: 'button', className: 'bedrock-bulk-paper', textContent: name });
    b.dataset.paper = paper;
    b.addEventListener('click', () => onSubmit(paper));
    return b;
  });
  const cancel = el(doc, 'button', { type: 'button', textContent: 'Cancel' });
  cancel.addEventListener('click', () => onCancel());
  const form = el(doc, 'div', { className: 'bedrock-bulk-form' },
    el(doc, 'p', { textContent: `The paper behind the writing of ${count === 1 ? 'the note' : `all ${count} notes`}. The writing itself does not change.` }),
    el(doc, 'div', { className: 'bedrock-bulk-papers' }, ...buttons),
    el(doc, 'div', { className: 'bedrock-bulk-buttons' }, cancel));
  root.append(form);
  return { form, buttons };
}
