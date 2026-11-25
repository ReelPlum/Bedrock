# Handwritten notes that link to a page, and tags for the whole note

## Why

Frederik (2026-11-23): "In obsidian when I open a note or a PDF I want to be
able to rightclick on the side on mac or hold with the finger on ipad, and in
the menu I want to be able to create a handwritten note linking to this page.
I want notes to have a global link embedded in the file where it doesn't have
to link to strokes. I also want to be able to add tags to a handwritten note
that also doesn't have to have strokes it links to."

Today every link in a note belongs to strokes (`links[].strokes`), and a link
whose strokes are gone is dropped when the note is saved. A note has no tags
of its own: its index note always says `tags: [bedrock]`.

## What changes

- **Note links**: links that belong to the whole note, not to ink. Stored in
  a new optional `noteLinks` list in `note.json`: the same fields as a word
  link (`target`, `type`, `text`) without `strokes`.
- **Tags**: a new optional `tags` list in `note.json`, plain words in
  Obsidian's tag form (letters, digits, `-`, `_`, `/` for nesting; no `#`,
  no spaces), kept in the order added, without repeats (case-insensitive).
- `links.md` lists the note links before the word links, so the index note,
  Obsidian's backlinks and graph see them.
- The index note / sidecar puts the note's tags in its front matter after
  `bedrock` (`tags: [bedrock, physics, exam]`); with no tags it is unchanged.
- **Obsidian**: "New handwritten note linking here" in
  - the editor's right-click menu of a Markdown note (`editor-menu`; Obsidian
    on the iPad shows it on a long press),
  - a file's menu: a tab's ⋯ "More options" menu, the tab header and the file
    explorer (`file-menu`; on the iPad the ⋯ button at the top of a note or
    PDF),
  - a right-click inside a PDF that Obsidian does not answer with its own
    menu,
  - the command palette.
  For a PDF the link names the page in view (`[[Paper.pdf#page=4]]`); for a
  Markdown note, the note (`[[Lecture 3]]`). The new note is made next to the
  page (or in the "Folder for new notes"), named after it ("Lecture 3 notes"),
  opens at once, and is saved with the link straight away.
- **The canvas**: the main menu gets "Tags and links…", a panel listing the
  note's tags and note links: add a tag, remove one; add a note link (the
  vault's link picker in Obsidian, a web address anywhere), open or remove
  one.

## Data format change

**What changes.** `note.json` gains two optional top-level fields,
`noteLinks` and `tags`; `links.md` lists the note links too; the index note
and sidecar front matter carry the tags.

**Why.** A link or tag that belongs to the whole note has nowhere to live:
links are tied to strokes and are dropped with them. A stroke-less entry in
`links` was considered and turned down because every Bedrock released so
far drops such an entry when it saves (it keeps a link only while all its
strokes exist), so older apps would silently lose it. A new field is kept by
them unchanged, because unknown fields are written back as they were.

**How old data keeps working.** Both fields are optional, so `version` stays
1 (`data-format-changes`: adding an optional field older readers can ignore).
A file without them opens with no note links and no tags. A fixture written
by the version just before this change (`v1-before-note-links`) is added
first and must open with everything it had. Older Bedrock reading a new file
keeps `noteLinks` and `tags` as unknown fields and writes them back; it
regenerates `links.md` without the note links, so the index note misses them
until a newer Bedrock saves the note again. Index notes written before this
change are still recognised, and are rewritten with the tags line when the
note next changes.

**Approval.** Asked 2026-11-23 in the project thread; Frederik approved it
as proposed the same day ("OK").

## Open source

Nothing new is needed. The menus are Obsidian's own API (`Menu`,
`workspace.on('editor-menu' | 'file-menu')`); the PDF's page in view is read
from PDF.js's own page elements (`.page[data-page-number]`), which Obsidian's
viewer already draws; tags follow Obsidian's tag syntax. Note links and tags
are stored with `serde_json`, already used for the note format.
