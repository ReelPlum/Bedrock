# Tasks

## 1. Header and file name

- [x] 1.1 Failing tests first: the header shows the file name, naming the note in the header renames the vault file (through `fileManager.renameFile`), a rename in Obsidian reaches the header; the camera follows a rename with search off; renaming an empty note makes no index note.
- [x] 1.2 `session.js`: `fileNameFor(title)` and the `rename { title }` request.
- [x] 1.3 Plugin: renames with `fileManager.renameFile`, refuses clashes with a notice, the view sends `renamed { name }` from `onRename`; cameras follow every rename.
- [x] 1.4 `index-note.js`: renaming an empty note only removes old index notes.
- [x] 1.5 Web app (`host.js`, `main.js`): header shows the host's file name, asks for `rename` when a name is done, takes `renamed`.
- [x] 1.6 Spec, README protocol table.
