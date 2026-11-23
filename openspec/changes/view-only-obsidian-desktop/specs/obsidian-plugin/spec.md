# obsidian-plugin Specification

## ADDED Requirements

### Requirement: Notes SHALL be view only in Obsidian on a computer

In Obsidian's desktop app (Mac, Windows, Linux) a Bedrock note can be looked
at, moved around and searched, and its links followed, but nothing changes
it. On the iPad and phones notes are edited as before.

#### Scenario: Pen, mouse and fingers move the page and never draw
- **GIVEN** a note open view only
- **WHEN** the pen, the mouse or a finger is dragged across it (with "Draw with finger" on too), or two or three fingers double-tap
- **THEN** the page moves and nothing is drawn, erased, selected, undone or redone
<!-- test: view_only_pen_and_mouse_move_the_page_and_never_draw -->
<!-- test: view_only_ignores_undo_redo_and_eraser_taps -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: on a computer the note is view only: pen and mouse move the page, nothing is drawn, changed or saved, links still open -->

#### Scenario: Only what changes nothing is offered
- **GIVEN** a note written on the iPad, with words, a tag and a link of the whole note, opened view only
- **WHEN** it is shown
- **THEN** the toolbar, undo, redo, inserting, pasting, importing and the pen's settings are hidden, the header says "View only" and its name cannot be edited; a word's menu says what the word was read as and copies a link to it, and nothing else; "Tags and links…" lists the tags and links and opens a link, with nothing to add or remove; "Show all ink" stays
<!-- test-js: apps/obsidian/tests/host.test.mjs :: on a computer the note is view only: pen and mouse move the page, nothing is drawn, changed or saved, links still open -->

#### Scenario: The file is never written
- **GIVEN** a note open view only
- **WHEN** keys for undo, redo, tools or delete are pressed, text is pasted, and the view saves and closes
- **THEN** the note does not change and its file keeps its bytes; the plugin refuses a write, a rename and starting links from a view-only canvas, so even a canvas that asked could not change the file
<!-- test-js: apps/obsidian/tests/host.test.mjs :: on a computer the note is view only: pen and mouse move the page, nothing is drawn, changed or saved, links still open -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a view-only session never writes or renames the file and hands out no starting links -->

#### Scenario: No new notes on a computer
- **GIVEN** the plugin in Obsidian's desktop app
- **WHEN** it loads
- **THEN** there is no "New Bedrock note" button or folder item, no "New handwritten note" or "New handwritten note linking here" command or menu item, the canvas page is told it is view only (`BEDROCK_VIEW_ONLY`), and the header cannot rename the note; on the iPad all of them are there
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: on a desktop computer notes are view only, and no new notes are offered; the iPad edits -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the canvas pages are written with their files handed over as blob: URLs, never loaded by address -->
