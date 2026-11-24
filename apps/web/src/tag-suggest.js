// Suggestions for the tag box ("Tags and links", note-info.js): tags that
// are already in use, so a tag is picked rather than typed again with a
// different spelling. Where they come from depends on where Bedrock runs:
//
//   * the web app: the tags of every note in the library on this device
//     (`libraryTags`, read from each note's note.json);
//   * the Obsidian plugin: every tag in the vault, from Markdown notes and
//     from handwritten notes' index notes (apps/obsidian/src/tags.js),
//     asked for with the host's `list-tags`.
//
// Both hand `suggestTags` a list of `{ tag, count }`. Nothing here is saved:
// suggestions are worked out from the notes each time the panel opens.

import { readZip, text } from './zip-read.js';
import { isTag, noteJsonTags } from './sidecar.js';

/** How many suggestions the panel shows at once. */
export const SUGGESTIONS = 8;

/** The tag a person means by `raw` for matching, as bedrock-core's
 *  `clean_tag` would store it (no `#`, spaces as `-`), in lower case. */
export function tagQuery(raw) {
  return String(raw ?? '').trim().replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase();
}

/** Count tags over many notes: `lists` holds one list of tags per note.
 *  Tags that differ only in case are one tag (as Obsidian and
 *  bedrock-core treat them), shown in the spelling used most. Returns
 *  `[{ tag, count }]`, `count` being the number of notes with the tag. */
export function tallyTags(lists, ignore = ['bedrock']) {
  const skip = new Set(ignore.map((t) => t.toLowerCase()));
  const byKey = new Map();
  for (const list of lists) {
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
      const tag = typeof raw === 'string' ? raw.replace(/^#/, '') : '';
      const key = tag.toLowerCase();
      if (!isTag(tag) || skip.has(key) || seen.has(key)) continue;
      seen.add(key);
      const e = byKey.get(key) || { count: 0, spellings: new Map() };
      e.count++;
      e.spellings.set(tag, (e.spellings.get(tag) || 0) + 1);
      byKey.set(key, e);
    }
  }
  return [...byKey.values()].map(({ count, spellings }) => ({
    tag: [...spellings].sort((a, b) => b[1] - a[1])[0][0],
    count,
  }));
}

/** Merge `{ tag, count }` lists (case-insensitively, counts added). */
export function mergeTags(...lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const { tag, count = 1 } of Array.isArray(list) ? list : []) {
      if (!isTag(tag)) continue;
      const key = tag.toLowerCase();
      const e = byKey.get(key);
      if (e) e.count += count;
      else byKey.set(key, { tag, count });
    }
  }
  return [...byKey.values()];
}

/** How well `tag` matches the typed `q` (lower case, from `tagQuery`):
 *  0 starts with it, 1 a part of it does (after `/`, `-` or `_`, so
 *  "forc" finds `physics/forces`), 2 has it inside, or -1 no match. */
function rank(tag, q) {
  const t = tag.toLowerCase();
  if (t.startsWith(q)) return 0;
  if (t.split(/[/_-]/).some((part) => part.startsWith(q))) return 1;
  return t.includes(q) ? 2 : -1;
}

/** The tags to offer for what is typed (`raw`): the known tags that match
 *  it, best first (how they match, then the most used, then the shortest,
 *  then A to Z), leaving out tags the note already has (`have`). With
 *  nothing typed, the most used tags. */
export function suggestTags(raw, known, have = [], limit = SUGGESTIONS) {
  const q = tagQuery(raw);
  const taken = new Set(have.map((t) => String(t).toLowerCase()));
  const out = [];
  for (const k of Array.isArray(known) ? known : []) {
    if (!k || !isTag(k.tag) || taken.has(k.tag.toLowerCase())) continue;
    const r = q ? rank(k.tag, q) : 0;
    if (r >= 0) out.push({ tag: k.tag, count: k.count || 0, r });
  }
  out.sort((a, b) => a.r - b.r || b.count - a.count || a.tag.length - b.tag.length || a.tag.localeCompare(b.tag));
  return out.slice(0, limit).map(({ tag, count }) => ({ tag, count }));
}

/** The tags of a .bedrock file (`tags` in its note.json). */
export async function readNoteTags(bytes) {
  try {
    const files = await readZip(bytes, ['note.json']);
    return noteJsonTags(text(files.get('note.json')));
  } catch (_) {
    return [];
  }
}

/** Every tag used in the library on this device, with how many notes use
 *  it, leaving out the note `except` (the open note, whose tags the panel
 *  shows and may have changed since it was saved). Each note is read once
 *  per change: `cache` keeps a note's tags by its id and when it changed. */
export async function libraryTags(store, { except = null, cache = new Map() } = {}) {
  const notes = await store.list();
  const lists = [];
  for (const n of notes) {
    if (n.id === except) continue;
    let hit = cache.get(n.id);
    if (!hit || hit.modified !== n.modified) {
      const rec = await store.get(n.id).catch(() => null);
      hit = { modified: n.modified, tags: rec?.data ? await readNoteTags(rec.data) : [] };
      cache.set(n.id, hit);
    }
    lists.push(hit.tags);
  }
  return tallyTags(lists);
}
