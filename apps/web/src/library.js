// The library's folders, and turning the library into a folder of files.
//
// Folders are kept in IndexedDB beside the notes (storage.js). Exporting
// makes them real directories, with each note as `Name.bedrock` and its
// Markdown sidecar `Name.bedrock.md` beside it (sidecar.js), so the
// unzipped folder can be dropped into an Obsidian vault as it is.
//
// Nothing here touches the DOM or IndexedDB, so it is tested in Node.

import { sidecarMarkdown, sidecarPath } from './sidecar.js';

/** Characters no file system takes in a name, and control characters. */
const BAD = /[\\/:*?"<>|\u0000-\u001f]+/g;

/** A name that works as a file or folder name on every system Bedrock's
 *  files go to (iPadOS, macOS, Windows, Obsidian): no path characters, no
 *  leading dots (Obsidian hides those), no trailing dots or spaces
 *  (Windows drops them), at most 80 characters. */
export function cleanName(name, fallback = 'Untitled') {
  const s = String(name ?? '').replace(BAD, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, 80).replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  return s || fallback;
}

const same = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/** Why a folder can't have this name among its siblings, or null if it can.
 *  `siblings` are the other folders with the same parent. */
export function folderNameProblem(name, siblings) {
  const raw = String(name ?? '').trim();
  if (!raw) return 'A folder needs a name.';
  const clean = cleanName(raw, '');
  if (!clean) return 'That name has no letters or digits a file system keeps.';
  if (siblings.some((f) => same(cleanName(f.name), clean))) return `There is already a folder called “${clean}” here.`;
  return null;
}

/** Folder id -> its folders from the top, e.g. ['School', 'Physics'].
 *  A folder whose parent is missing (or a loop) is treated as top-level. */
export function folderTrail(folders) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const trails = new Map();
  const trailOf = (f, seen = new Set()) => {
    if (trails.has(f.id)) return trails.get(f.id);
    seen.add(f.id);
    const parent = f.parent && byId.get(f.parent);
    const up = parent && !seen.has(parent.id) ? trailOf(parent, seen) : [];
    const t = [...up, f];
    trails.set(f.id, t);
    return t;
  };
  for (const f of folders) trailOf(f);
  return trails;
}

/** Folder id -> path such as `School/Physics`, made of cleaned names. */
export function folderPaths(folders) {
  const out = new Map();
  for (const [id, trail] of folderTrail(folders)) out.set(id, trail.map((f) => cleanName(f.name, 'Folder')).join('/'));
  return out;
}

/** Folders in `parent` (null: the top) and their notes, sorted for the
 *  library: folders by name, notes newest first. A note whose folder is
 *  gone is shown at the top. */
export function folderContents(folders, notes, parent) {
  const ids = new Set(folders.map((f) => f.id));
  const top = (id) => !id || !ids.has(id);
  const here = (id) => (parent ? id === parent : top(id));
  return {
    folders: folders.filter((f) => here(f.parent))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })),
    notes: notes.filter((n) => here(n.folder)).sort((a, b) => b.modified - a.modified),
  };
}

/** Every folder id inside `id`, `id` included. */
export function folderAndBelow(folders, id) {
  const out = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of folders) if (!out.has(f.id) && out.has(f.parent)) { out.add(f.id); grew = true; }
  }
  return out;
}

/**
 * The files of an exported library, as [path, bytes] pairs in a stable
 * order: a directory entry (`School/`) for each folder, so empty ones are
 * kept, then each note as `Folder/Name.bedrock` followed by its Markdown
 * sidecar `Folder/Name.bedrock.md`.
 *
 * `notes` are { id, title, folder, data }; `titleOf(note)` may supply a
 * title for notes saved without one. Two notes with the same name in a
 * folder get the start of their id added.
 */
export async function libraryFiles(folders, notes, { titleOf = (n) => n.title } = {}) {
  const enc = new TextEncoder();
  const paths = folderPaths(folders);
  const out = [];
  for (const p of [...new Set(paths.values())].sort()) out.push([`${p}/`, new Uint8Array(0)]);
  const used = new Set();
  for (const n of notes) {
    const dir = (n.folder && paths.get(n.folder)) || '';
    const base = cleanName(titleOf(n), 'Untitled note');
    let path = `${dir ? `${dir}/` : ''}${base}.bedrock`;
    for (let k = 1; used.has(path.toLowerCase()); k++) {
      const tag = k <= 4 ? n.id.slice(0, 4 * k) : `${n.id} ${k}`;
      path = `${dir ? `${dir}/` : ''}${base} ${tag}.bedrock`;
    }
    used.add(path.toLowerCase());
    out.push([path, n.data]);
    out.push([sidecarPath(path), enc.encode(await sidecarMarkdown(path, n.data))]);
  }
  return out;
}
