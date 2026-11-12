# Tasks

## 1. Shared sidecar and storage

- [x] 1.1 Move the index Markdown and the ZIP reader from the plugin into `apps/web/src/sidecar.js` and `zip-read.js`; the plugin re-exports them.
- [x] 1.2 IndexedDB version 2 with a `folders` store, `move`, `listFolders`, `putFolder`, `removeFolder` in `storage.js`.
- [x] 1.3 `library.js`: folder names, paths, contents, and `libraryFiles` for the export, with Node tests (`apps/web/tests/library.test.mjs`).

## 2. Website and plugin

- [x] 2.1 Notes list: folders, breadcrumb, new folder, rename, delete, move; new notes go into the folder shown; export writes folders and sidecars. Browser tests in `apps/web/tests/folders.test.mjs`.
- [x] 2.2 Plugin: sidecars beside notes are index notes whatever the folder setting; rename, delete and sync follow them. Tests in `apps/obsidian/tests/unit.test.mjs`.
- [x] 2.3 `specs.rs` also checks JavaScript tests cited with a `test-js` comment (file and test title), in living specs and open changes.
- [x] 2.4 Document the sidecar and the exported library in `docs/note-format.md` and the READMEs.
