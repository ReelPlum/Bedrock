# Folders on the website, and an export that drops into Obsidian

## Why

The website keeps every note in one flat list. Writers asked to sort notes
into folders, saved on the device like the notes are. They also want to move
to Obsidian by dragging a folder into their vault, without the Bedrock plugin
having to index everything first.

Notes live in Safari's website storage (IndexedDB), which the Files app
cannot see, and Safari on iPad cannot write into a folder the user picks
(no File System Access API). The way out of the website is therefore an
export: a ZIP the Files app unzips into a folder.

## What changes

- The notes list gets folders: create, open, nest, rename, delete (with
  what is inside, after a confirmation that says how much), and move a note
  into a folder. Folders are saved in IndexedDB next to the notes (database
  version 2, a `folders` store; a note names its folder in `folder`). New
  notes are made in the folder the list shows.
- "Export all notes" writes the folders as real directories, each note as
  `Name.bedrock`, and beside it the Markdown sidecar `Name.bedrock.md` the
  Obsidian plugin uses as the note's index note. Empty folders are kept.
- The sidecar Markdown is made by one module, `apps/web/src/sidecar.js`,
  used by the website and the plugin, so both write the same bytes.
- The plugin treats a sidecar beside a note as that note's index note
  whatever its index folder setting is: it opens the note beside it, keeps
  it up to date, moves it with the note, and makes no second copy in the
  index folder. A sidecar whose front matter names another path (the folder
  was dropped somewhere other than the vault's root) is rewritten.

## Not changed

- The note format (`note.json` and the `.bedrock` archive) does not change:
  a note's folder is where its file is, as in Obsidian. `version` stays 1.
- A single note saved with "Save to iCloud Drive / Files" is still one file.
