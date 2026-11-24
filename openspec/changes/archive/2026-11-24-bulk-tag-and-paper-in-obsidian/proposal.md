# Add tags to, and change the paper of, many notes at once in Obsidian

## Why

Frederik (2026-11-24): "Please add so I can bulk tag notes somehow. Maybe add
a rightclick menu for bedrock notes to add tags that works for multiple
selected files also." And: "Also make it possible to change the paper style
in bulk also".

Today tags and paper are changed one note at a time, with the note open on
the canvas. A GoodNotes library imported with "Import PDFs" is hundreds of
notes at the top of the vault that all need tags.

## What changes

- **The file explorer's menu.** Right-click (desktop) or hold (iPad) a
  handwritten note, several selected files or a folder: "Add tags…" and
  "Change paper…". Only `.bedrock` files count; a folder counts the notes in
  its folders too.
- **Add tags.** A window with a tag box that suggests every tag in the vault,
  as the canvas's tag box does (`suggestTags`, PR 59). Each tag is added to
  every note, keeping the tags it has.
- **Change paper.** Grid, Dots, Lines or Plain for every note.
- **Many notes.** One note at a time, in a worker with the canvas's
  WebAssembly, so Obsidian never freezes. An open note saves first and
  reloads with the change. A note that fails (damaged, empty) is listed in
  the notice with its reason, and the others go on. Each changed note's index
  note is brought up to date.
- **bedrock-core:** `note_edit::edit_note`, exposed as `edit_saved_note` in
  bedrock-web: reads a saved note, adds tags and sets the paper, and saves it
  with the same writer as the canvas; returns nothing when nothing changes.

## Data format

No data format changes. `tags` and `paper` in `note.json` are written as the
canvas writes them (`format::load_bytes` and `format::to_bedrock`), and the
index notes by the existing indexer. Notes of every earlier version are read
(tested on `tests/fixtures/old-formats/`) and saved in today's version, as any
edit on the canvas saves them.

## Open source used

No new library; see the requirement's "Open source used".
