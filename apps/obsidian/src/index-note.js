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

/** Recognised text, in reading order as saved, and the links as Markdown.
 *  `items` keeps each piece of text with the strokes it was read from, so
 *  a place in the index note can be traced back to ink. */
export async function readNoteText(bytes) {
  const files = await readZip(bytes, ['recognized.json', 'links.md']);
  let items = [];
  try {
    const rec = JSON.parse(text(files.get('recognized.json')) || '{}');
    items = (Array.isArray(rec.items) ? rec.items : [])
      .map((i) => ({
        text: typeof i?.text === 'string' ? i.text.trim() : '',
        strokes: Array.isArray(i?.strokes) ? i.strokes.filter((s) => typeof s === 'string') : [],
      }))
      .filter((i) => i.text);
  } catch (_) { /* damaged: no text */ }
  const links = text(files.get('links.md')).split('\n').filter((l) => /^- /.test(l));
  return { words: items.map((i) => i.text), items, links };
}

/** The index note's Markdown, and where each piece of text sits in it:
 *  `spans` are `{ start, end, strokes }` with offsets into `markdown`. */
export function indexLayout(notePath, { words, items, links }) {
  const name = notePath.split('/').pop().replace(/\.bedrock$/i, '');
  const head = [
    '---',
    `bedrock: ${JSON.stringify(notePath)}`,
    'tags: [bedrock]',
    '---',
    `> Handwritten note: [[${notePath}|${name}]]. This index is written by the Bedrock plugin from the handwriting; changes made here are replaced.`,
    '',
    '## Text',
    '',
    '',
  ].join('\n');
  const pieces = items || (words || []).map((t) => ({ text: t, strokes: [] }));
  const spans = [];
  let body = '';
  for (const p of pieces) {
    if (body) body += ' ';
    const t = escapeText(p.text);
    spans.push({ start: head.length + body.length, end: head.length + body.length + t.length, strokes: p.strokes || [] });
    body += t;
  }
  const lines = [body || '_Nothing read yet._', ''];
  if (links.length) lines.push('## Links', '', ...links, '');
  return { markdown: head + lines.join('\n'), spans };
}

/** The index note's Markdown. */
export function indexMarkdown(notePath, content) {
  return indexLayout(notePath, content).markdown;
}

/** The strokes of the text between two offsets of an index note (a search
 *  hit), in writing order and without repeats. A caret (`start === end`)
 *  inside or at the edge of a word names that word. Empty if the range is
 *  not on the text (the title, the links). */
export function strokesAt(spans, start, end = start) {
  const [a, b] = start <= end ? [start, end] : [end, start];
  const out = [];
  for (const s of spans) {
    const hit = a === b ? a >= s.start && a <= s.end : a < s.end && b > s.start;
    if (hit) for (const id of s.strokes) if (!out.includes(id)) out.push(id);
    // A caret between two words belongs to the first.
    if (hit && a === b) break;
  }
  return out;
}

/** Offset of an editor position (`line` and `ch` from 0) in `markdown`. */
export function offsetOf(markdown, line, ch = 0) {
  let at = 0;
  for (let i = 0; i < line; i++) {
    const nl = markdown.indexOf('\n', at);
    if (nl < 0) return markdown.length;
    at = nl + 1;
  }
  return Math.min(at + Math.max(0, ch), markdown.length);
}

/** Where in a handwritten note an opened index note points.
 *
 *  `eState` is what Obsidian hands a file when it opens it. A search result
 *  gives `match: { content, matches: [[start, end], ...] }` (offsets into
 *  the index note); other ways of opening give `line` (and sometimes
 *  `ch`), or nothing. `noteBytes` is the .bedrock file, `markdown` the
 *  index note as Obsidian searched it. Returns stroke ids, empty when the
 *  place is not known (the note then opens where it was left). */
export async function strokesForIndexPlace(notePath, noteBytes, markdown, eState) {
  let range = null;
  const m = eState?.match?.matches?.[0];
  if (Array.isArray(m) && Number.isFinite(m[0]) && Number.isFinite(m[1])) range = [m[0], m[1]];
  else if (Number.isFinite(eState?.line)) {
    const at = offsetOf(markdown, eState.line, Number.isFinite(eState.ch) ? eState.ch : 0);
    // A line alone: the whole line.
    const nl = markdown.indexOf('\n', at);
    range = Number.isFinite(eState.ch) ? [at, at] : [at, nl < 0 ? markdown.length : nl];
  }
  if (!range) return [];
  const layout = indexLayout(notePath, await readNoteText(noteBytes));
  if (layout.markdown === markdown) return strokesAt(layout.spans, range[0], range[1]);
  // The index is older than the note (edited on another device): find the
  // words that were hit by their text instead of their place.
  const hit = markdown.slice(range[0], range[1]).trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (const w of hit) {
    const s = layout.spans.find((s) => layout.markdown.slice(s.start, s.end).toLowerCase().includes(w.toLowerCase()));
    if (s) for (const id of s.strokes) if (!out.includes(id)) out.push(id);
  }
  return out;
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
