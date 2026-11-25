# Tasks

## 1. View only on a computer

- [x] 1.1 Failing tests first: engine `view_only` (pen and mouse move the page, nothing draws; no undo, redo or eraser taps), the session refuses writes and renames, the plugin offers no new notes on a computer and opens the canvas view only, and the canvas in the harness changes and saves nothing.
- [x] 1.2 `bedrock-core` engine: `view_only`; `bedrock-web`: `set_view_only`.
- [x] 1.3 Web app: `host.js` reads `BEDROCK_VIEW_ONLY` and hides editing controls; `main.js` never saves and ignores edit keys, paste and drop; the word menu and "Tags and links" are read only.
- [x] 1.4 Plugin: `isViewOnly(Platform)`, view-only page and session, no new-note commands or menus on a computer.
- [x] 1.5 Spec, README.

## 2. Notes are still made on a computer

- [x] 2.1 Tests first: the desktop plugin offers the new-note button, commands and menus; a view-only session writes once, only the starting links of an empty note; a note made about a page on a computer keeps its link and is view only after.
- [x] 2.2 Plugin: new-note actions and "Folder for new notes" on every device; session allows the one starting-links write.
- [x] 2.3 Web app: a view-only canvas applies starting links and saves them once.
- [x] 2.4 Spec, README.

## 3. Tags, corrections and zoom on a computer

- [x] 3.1 Tests first: a view-only session writes only files with the same ink; on a computer scrolling zooms, a reading is corrected and tags edited and saved with the ink as it was.
- [x] 3.2 Session: `sameInk` guard in place of the one-time starting-links write.
- [x] 3.3 Web app: tags and corrections offered and saved (no autosave), `wheelZooms` in the input controller.
- [x] 3.4 Spec, README.
