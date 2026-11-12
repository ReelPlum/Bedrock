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
// Everything comes from the saved file (recognized.json and links.md in the
// ZIP), so a sidecar can be rebuilt from any .bedrock file.

import { readZip, text } from './zip-read.js';

/** The sidecar beside a note: `Physics/Newton.bedrock.md`. */
export const sidecarPath = (notePath) => `${notePath}.md`;

/** The note an index note or sidecar belongs to, from its front matter. */
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
 *  `spans` are `{ start, end, strokes }` with offsets into `markdown`.
 *  `notePath` is the note's path from the vault (or export) root. */
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

/** The sidecar Markdown for a note file's bytes at `notePath`. */
export async function sidecarMarkdown(notePath, bytes) {
  return indexMarkdown(notePath, await readNoteText(bytes));
}
