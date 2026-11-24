// The Markdown sidecar of a .bedrock note: `Name.bedrock.md` beside
// `Name.bedrock`. Obsidian only searches and links Markdown, so the sidecar
// holds the text read from the handwriting (with the writer's corrections)
// and the note's links. Obsidian search finds the handwriting through it,
// and its [[links]] put the handwritten note in the graph and in backlinks.
//
// The Obsidian plugin writes it (it calls it the "index note") and the web
// app writes the same bytes when it exports a library, so an exported folder
// dropped into a vault is already indexed. Both use this one module; its
// output is described in docs/note-format.md ("Markdown sidecar").
//
// Everything comes from the saved file (recognized.json, links.md and the
// tags in note.json, in the ZIP), so a sidecar can be rebuilt from any
// .bedrock file.

import { readZip, text } from './zip-read.js';

/** The sidecar beside a note: `Physics/Newton.bedrock.md`. */
export const sidecarPath = (notePath) => `${notePath}.md`;

/** The note an index note or sidecar belongs to, from its front matter. */
export function noteOfIndex(markdown) {
  const m = /^---\n[\s\S]*?^bedrock: "((?:[^"\\]|\\.)*)"$[\s\S]*?^---$/m.exec(markdown);
  return m ? JSON.parse(`"${m[1]}"`) : null;
}

const escapeText = (s) => s.replace(/([[\]])/g, '\\$1');

/** Recognised text as it goes in the text section: also `#` is escaped
 *  (`\#`), so a handwritten `#word` is no Obsidian tag and a `#` at the
 *  start is no heading. Markdown shows it as a plain `#`, and a search for
 *  `#word` or `word` still finds it. */
const escapeBody = (s) => escapeText(s).replace(/#/g, '\\#');

/** Was this index note written before `#` in the text was escaped (does
 *  its text section hold a bare `#`)? Such a note is written again. */
export function hasBareHash(markdown) {
  const body = markdown.split('\n## Text\n\n')[1];
  return body !== undefined && /(^|[^\\])#/.test(body.split('\n')[0]);
}

/** A tag as Obsidian takes it (letters, digits, `_`, `-`, `/`, not only
 *  digits), as bedrock-core's `clean_tag` stores them. */
export const isTag = (t) => typeof t === 'string' && /^[\p{L}\p{N}_\-/]+$/u.test(t) && !/^[\d/]+$/.test(t);

// YAML would read these as something other than text: quote them.
const yamlTag = (t) => (/^(true|false|null|yes|no|on|off|y|n|[-+]?[\d_]*\.?[\d_]+(e[-+]?\d+)?)$/i.test(t) ? JSON.stringify(t) : t);

/** Recognised text, in reading order as saved, the links as Markdown and
 *  the note's tags (`tags` in note.json).
 *  `items` keeps each piece of text with the strokes it was read from, so
 *  a place in the index note can be traced back to ink. */
export async function readNoteText(bytes) {
  const files = await readZip(bytes, ['recognized.json', 'links.md', 'note.json']);
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
  const tags = noteJsonTags(text(files.get('note.json')));
  return { words: items.map((i) => i.text), items, links, tags };
}

/** The note's tags from the text of its note.json (`tags`), leaving out
 *  `bedrock` (every index note has it). */
export function noteJsonTags(json) {
  try {
    // Only the top-level `tags` list is wanted: found without parsing every
    // stroke of a big note. (Inside a JSON string a quote is escaped, so
    // `"tags":[` there cannot match.)
    const m = /[{,]"tags":(\[[^\]]*\])/.exec(json);
    const list = m ? JSON.parse(m[1]) : [];
    if (Array.isArray(list)) return [...new Set(list.filter(isTag))].filter((t) => t.toLowerCase() !== 'bedrock');
  } catch (_) { /* damaged: no tags */ }
  return [];
}

export const LINKED_NOTES_HEADING = '## Linked handwritten notes';

/** The link targets (`[[target#anchor|text]]` -> `target`) of `links`
 *  lines that point at a handwritten note (`.bedrock`), each once. */
export function noteLinkTargets(links) {
  const out = [];
  for (const line of links || []) {
    for (const m of line.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
      const t = m[1].trim();
      if (/\.bedrock$/i.test(t) && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

/** The graph only draws a link between two notes it shows, and a link to
 *  a handwritten note points at its `.bedrock` file, which a tidy graph
 *  hides. So each linked handwritten note's index note is linked too:
 *  `indexOf(target)` gives its path (with `.md`), or null when there is
 *  none. Without `indexOf`, a target is a path from the root and its index
 *  note is its sidecar. */
function linkedNoteLines(notePath, links, indexOf = sidecarPath) {
  const own = indexOf(notePath);
  const lines = [];
  for (const t of noteLinkTargets(links)) {
    const idx = indexOf(t);
    // A link to a word of this same note needs no edge.
    if (!idx || idx === own) continue;
    const name = t.split('/').pop().replace(/\.bedrock$/i, '');
    const line = `- [[${idx}|${escapeText(name)}]]`;
    if (!lines.includes(line)) lines.push(line);
  }
  return lines;
}

/** The index note's Markdown, and where each piece of text sits in it:
 *  `spans` are `{ start, end, strokes }` with offsets into `markdown`.
 *  `notePath` is the note's path from the vault (or export) root;
 *  `indexOf` finds the index notes of linked handwritten notes (above). */
export function indexLayout(notePath, { words, items, links, tags = [] }, { indexOf } = {}) {
  const name = notePath.split('/').pop().replace(/\.bedrock$/i, '');
  const head = [
    '---',
    `bedrock: ${JSON.stringify(notePath)}`,
    `tags: [${['bedrock', ...tags.map(yamlTag)].join(', ')}]`,
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
    const t = escapeBody(p.text);
    spans.push({ start: head.length + body.length, end: head.length + body.length + t.length, strokes: p.strokes || [] });
    body += t;
  }
  const lines = [body || '_Nothing read yet._', ''];
  if (links.length) lines.push('## Links', '', ...links, '');
  const linked = linkedNoteLines(notePath, links, indexOf);
  if (linked.length) lines.push(LINKED_NOTES_HEADING, '', ...linked, '');
  return { markdown: head + lines.join('\n'), spans };
}

/** The index note's Markdown. */
export function indexMarkdown(notePath, content, opts) {
  return indexLayout(notePath, content, opts).markdown;
}

/** The sidecar Markdown for a note file's bytes at `notePath`. */
export async function sidecarMarkdown(notePath, bytes, opts) {
  return indexMarkdown(notePath, await readNoteText(bytes), opts);
}
