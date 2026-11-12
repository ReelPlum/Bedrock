# Design

## Storage

IndexedDB `bedrock` goes from version 1 to 2 and gains a `folders` object
store, keyed by `id`: `{ id, name, parent, created }`. `parent` is a folder
id or null. Notes keep their record and gain an optional `folder` (missing
or null: the top), so notes from version 1 need no migration and show at the
top. A note or folder whose folder is missing is shown at the top, so
nothing becomes unreachable.

Deleting a folder deletes the folders and notes inside it in one
transaction. The app waits for a save that is under way first, so a save
cannot bring a deleted note back.

Folder names are cleaned to what iPadOS, macOS, Windows and Obsidian all
accept (no `\ / : * ? " < > |`, no leading dots, which Obsidian hides, no
trailing dots or spaces, at most 80 characters) and must be unique among
their siblings, ignoring case, because the export turns them into
directories on case-insensitive file systems.

## Export

`libraryFiles(folders, notes)` in `apps/web/src/library.js` returns the
ZIP's entries in a stable order: a `Folder/` directory entry for every
folder, then for each note `Folder/Name.bedrock` and
`Folder/Name.bedrock.md`. Same-named notes in a folder get the start of
their id added.

## Sidecar

`sidecar.js` holds what `apps/obsidian/src/index-note.js` used to: reading
`recognized.json` and `links.md` from the archive and laying out the index
Markdown. The ZIP reader moves with it (`apps/web/src/zip-read.js`). The
front matter `bedrock:` path is the note's path from the export root, which
is the vault path when the folder is dropped into the vault's root.

In the plugin, `Indexer.pathFor` prefers an existing sidecar to the index
folder, `isIndexPath` always accepts `*.bedrock.md`, and `noteForIndex`
opens the note beside a sidecar before trying its front matter. `sync()`
also rewrites an index note whose front matter names another path.
