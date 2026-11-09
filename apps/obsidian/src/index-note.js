// Obsidian only searches and links Markdown. Each .bedrock note therefore
// gets a companion Markdown note, the "index note", holding the text read
// from the handwriting (with the writer's corrections) and the note's links.
// Obsidian search finds the handwriting through it, and its [[links]] put
// the handwritten note in the graph and in backlinks.
//
// Everything comes from the saved file (recognized.json and links.md in the
// ZIP), so an index note can be rebuilt from any .bedrock file, including
// ones written by the web app or edited on another device.

import { readZip, text } from './zip.js';

export const DEFAULT_INDEX_FOLDER = 'Bedrock index';

/** Where the index note of a .bedrock file lives. With no folder it sits
 *  beside the file as `Name.bedrock.md`. */
export function indexPath(notePath, folder = DEFAULT_INDEX_FOLDER) {
  const f = (folder || '').replace(/^\/+|\/+$/g, '');
  return f ? `${f}/${notePath.replace(/\.bedrock$/i, '')}.md` : `${notePath}.md`;
}

/** Could this path be an index note (with this folder setting)? */
export function isIndexPath(path, folder = DEFAULT_INDEX_FOLDER) {
  const f = (folder || '').replace(/^\/+|\/+$/g, '');
  return f ? path.startsWith(`${f}/`) && path.endsWith('.md') : path.endsWith('.bedrock.md');
}

/** The note an index note belongs to, from its front matter. */
export function noteOfIndex(markdown) {
  const m = /^---\n[\s\S]*?^bedrock: "((?:[^"\\]|\\.)*)"$[\s\S]*?^---$/m.exec(markdown);
  return m ? JSON.parse(`"${m[1]}"`) : null;
}

const escapeText = (s) => s.replace(/([[\]])/g, '\\$1');

/** Recognised text, in reading order as saved, and the links as Markdown. */
export async function readNoteText(bytes) {
  const files = await readZip(bytes, ['recognized.json', 'links.md']);
  let words = [];
  try {
    const rec = JSON.parse(text(files.get('recognized.json')) || '{}');
    words = (Array.isArray(rec.items) ? rec.items : [])
      .map((i) => (typeof i?.text === 'string' ? i.text.trim() : ''))
      .filter(Boolean);
  } catch (_) { /* damaged: no text */ }
  const links = text(files.get('links.md')).split('\n').filter((l) => /^- /.test(l));
  return { words, links };
}

/** The index note's Markdown. */
export function indexMarkdown(notePath, { words, links }) {
  const name = notePath.split('/').pop().replace(/\.bedrock$/i, '');
  const lines = [
    '---',
    `bedrock: ${JSON.stringify(notePath)}`,
    'tags: [bedrock]',
    '---',
    `> Handwritten note: [[${notePath}|${name}]]. This index is written by the Bedrock plugin from the handwriting; changes made here are replaced.`,
    '',
    '## Text',
    '',
    words.length ? escapeText(words.join(' ')) : '_Nothing read yet._',
    '',
  ];
  if (links.length) lines.push('## Links', '', ...links, '');
  return lines.join('\n');
}

/** Keeps index notes in step with the .bedrock files in a vault. */
export class Indexer {
  /** `vault` is Obsidian's Vault (or a stand-in with the same methods);
   *  `folder()` returns the index folder setting. */
  constructor(vault, folder = () => DEFAULT_INDEX_FOLDER) {
    this.vault = vault;
    this.folder = folder;
  }

  pathFor(notePath) { return indexPath(notePath, this.folder()); }

  /** Write the index for a note's bytes. Returns true if it changed. */
  async update(notePath, bytes) {
    const md = indexMarkdown(notePath, await readNoteText(bytes));
    const path = this.pathFor(notePath);
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing) {
      if ((await this.vault.read(existing)) === md) return false;
      await this.vault.modify(existing, md);
    } else {
      await this.ensureFolder(path.split('/').slice(0, -1).join('/'));
      await this.vault.create(path, md);
    }
    return true;
  }

  async ensureFolder(dir) {
    if (!dir) return;
    let at = '';
    for (const part of dir.split('/')) {
      at = at ? `${at}/${part}` : part;
      if (!this.vault.getAbstractFileByPath(at)) {
        try { await this.vault.createFolder(at); } catch (_) { /* made meanwhile */ }
      }
    }
  }

  async rename(oldNotePath, newNotePath, bytes) {
    const old = this.vault.getAbstractFileByPath(this.pathFor(oldNotePath));
    if (old) await this.vault.delete(old);
    await this.update(newNotePath, bytes);
  }

  async remove(notePath) {
    const f = this.vault.getAbstractFileByPath(this.pathFor(notePath));
    if (f) await this.vault.delete(f);
  }

  /** Index every .bedrock file whose index is missing or older. */
  async sync() {
    let n = 0;
    for (const f of this.vault.getFiles()) {
      if (f.extension !== 'bedrock') continue;
      const idx = this.vault.getAbstractFileByPath(this.pathFor(f.path));
      if (idx && idx.stat.mtime >= f.stat.mtime) continue;
      const bytes = await this.vault.readBinary(f);
      if (bytes.byteLength && (await this.update(f.path, bytes))) n++;
    }
    return n;
  }
}
