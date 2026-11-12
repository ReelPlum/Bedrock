// Obsidian only searches and links Markdown. Each .bedrock note therefore
// gets a companion Markdown note, the "index note", holding the text read
// from the handwriting (with the writer's corrections) and the note's links.
// Obsidian search finds the handwriting through it, and its [[links]] put
// the handwritten note in the graph and in backlinks.
//
// Everything comes from the saved file (recognized.json and links.md in the
// ZIP), so an index note can be rebuilt from any .bedrock file, including
// ones written by the web app or edited on another device.

import { indexLayout, indexMarkdown, noteOfIndex, readNoteText, sidecarPath } from '../../web/src/sidecar.js';

// The Markdown itself is made by a module shared with the web app, which
// writes the same sidecars when it exports a library.
export { indexLayout, indexMarkdown, noteOfIndex, readNoteText, sidecarPath };

export const DEFAULT_INDEX_FOLDER = 'Bedrock index';

const trimSlashes = (folder) => (folder || '').replace(/^\/+|\/+$/g, '');

/** Where the index note of a .bedrock file lives. With no folder it sits
 *  beside the file as `Name.bedrock.md` (a sidecar). */
export function indexPath(notePath, folder = DEFAULT_INDEX_FOLDER) {
  const f = trimSlashes(folder);
  return f ? `${f}/${notePath.replace(/\.bedrock$/i, '')}.md` : sidecarPath(notePath);
}

/** Could this path be an index note (with this folder setting)? A sidecar
 *  beside a note (`Name.bedrock.md`, as the web app exports them) always
 *  counts, whatever the folder setting. */
export function isIndexPath(path, folder = DEFAULT_INDEX_FOLDER) {
  const f = trimSlashes(folder);
  if (path.endsWith('.bedrock.md')) return true;
  return !!f && path.startsWith(`${f}/`) && path.endsWith('.md');
}

/** The note a sidecar sits beside (`Name.bedrock.md` -> `Name.bedrock`). */
export const noteBesideSidecar = (path) => (path.endsWith('.bedrock.md') ? path.slice(0, -3) : null);

/** The note an index note opens: a sidecar opens the note beside it
 *  (whatever its front matter says, so a folder dropped in anywhere in the
 *  vault works at once); an index note in the index folder opens the note
 *  its front matter names. `exists(path)` says whether a note is there.
 *  Null if neither is. */
export function noteForIndex(path, markdown, exists) {
  const beside = noteBesideSidecar(path);
  if (beside && exists(beside)) return beside;
  const named = noteOfIndex(markdown);
  return named && exists(named) ? named : null;
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

/** Keeps index notes in step with the .bedrock files in a vault.
 *
 *  A note's index note is its sidecar (`Name.bedrock.md` beside it) when
 *  one exists, as in a folder exported from the web app, and otherwise the
 *  note in the index folder setting. So a dropped-in library is used as it
 *  is, with no second copy in the index folder. */
export class Indexer {
  /** `vault` is Obsidian's Vault (or a stand-in with the same methods);
   *  `folder()` returns the index folder setting. */
  constructor(vault, folder = () => DEFAULT_INDEX_FOLDER) {
    this.vault = vault;
    this.folder = folder;
  }

  /** The index note's path: the sidecar if there is one, else the folder
   *  setting's place. */
  pathFor(notePath) {
    const side = sidecarPath(notePath);
    return this.vault.getAbstractFileByPath(side) ? side : indexPath(notePath, this.folder());
  }

  /** The index notes that exist for a note (its sidecar and its note in
   *  the index folder). */
  existing(notePath) {
    const paths = [...new Set([sidecarPath(notePath), indexPath(notePath, this.folder())])];
    return paths.map((p) => this.vault.getAbstractFileByPath(p)).filter((f) => f && !f.children);
  }

  /** Write the index for a note's bytes. Returns true if it changed. */
  async update(notePath, bytes, path = this.pathFor(notePath)) {
    const md = indexMarkdown(notePath, await readNoteText(bytes));
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

  /** A note was renamed or moved. A sidecar stays a sidecar: it moves
   *  with the note (Obsidian has already moved it if its folder moved). */
  async rename(oldNotePath, newNotePath, bytes) {
    let sidecar = !!this.vault.getAbstractFileByPath(sidecarPath(newNotePath));
    for (const f of this.existing(oldNotePath)) {
      if (f.path === sidecarPath(oldNotePath)) sidecar = true;
      await this.vault.delete(f);
    }
    await this.update(newNotePath, bytes, sidecar ? sidecarPath(newNotePath) : indexPath(newNotePath, this.folder()));
  }

  async remove(notePath) {
    for (const f of this.existing(notePath)) await this.vault.delete(f);
  }

  /** Index every .bedrock file whose index is missing, older than the
   *  note, or names another path (a folder dropped in from the web app
   *  somewhere other than the vault's root). */
  async sync() {
    let n = 0;
    for (const f of this.vault.getFiles()) {
      if (f.extension !== 'bedrock') continue;
      const idx = this.vault.getAbstractFileByPath(this.pathFor(f.path));
      if (idx && idx.stat.mtime >= f.stat.mtime && noteOfIndex(await this.vault.cachedRead(idx)) === f.path) continue;
      const bytes = await this.vault.readBinary(f);
      if (bytes.byteLength && (await this.update(f.path, bytes))) n++;
    }
    return n;
  }
}
