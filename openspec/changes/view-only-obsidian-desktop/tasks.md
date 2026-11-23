# Tasks

## 1. View only on a computer

- [x] 1.1 Failing tests first: engine `view_only` (pen and mouse move the page, nothing draws; no undo, redo or eraser taps), the session refuses writes and renames, the plugin offers no new notes on a computer and opens the canvas view only, and the canvas in the harness changes and saves nothing.
- [x] 1.2 `bedrock-core` engine: `view_only`; `bedrock-web`: `set_view_only`.
- [x] 1.3 Web app: `host.js` reads `BEDROCK_VIEW_ONLY` and hides editing controls; `main.js` never saves and ignores edit keys, paste and drop; the word menu and "Tags and links" are read only.
- [x] 1.4 Plugin: `isViewOnly(Platform)`, view-only page and session, no new-note commands or menus on a computer.
- [x] 1.5 Spec, README.
