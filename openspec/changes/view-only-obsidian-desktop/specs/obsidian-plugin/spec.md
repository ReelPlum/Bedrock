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
- **THEN** the note does not change and its file keeps its bytes; the plugin refuses a write and a rename from a view-only canvas, so even a canvas that asked could not change the file (the one write it allows is below)
<!-- test-js: apps/obsidian/tests/host.test.mjs :: on a computer the note is view only: pen and mouse move the page, nothing is drawn, changed or saved, links still open -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a view-only session never renames the file, and writes it only once, for the starting links of a new note -->

#### Scenario: New notes are made on a computer, and written on the iPad
- **GIVEN** the plugin in Obsidian's desktop app
- **WHEN** it loads, and "New Bedrock note" (ribbon, folder menu, command) or "New handwritten note linking here" (note, PDF or editor menu, command) is chosen
- **THEN** the empty note is made as on the iPad and opens view only (`BEDROCK_VIEW_ONLY`); the header cannot rename it
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: on a desktop computer notes are view only, and new notes are still made; the iPad edits -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the canvas pages are written with their files handed over as blob: URLs, never loaded by address -->

#### Scenario: A note made about a page keeps its link on a computer
- **GIVEN** a note made on a computer with "New handwritten note linking here"
- **WHEN** its view-only canvas starts
- **THEN** it asks for the starting link and saves it at once into the empty file, as on the iPad (the plugin allows that one write, into an empty file, after handing out the link, and no other); after that the note is view only and nothing is saved
<!-- test-js: apps/obsidian/tests/host.test.mjs :: a note made on a computer about a page keeps its link, and is view only after that -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a view-only session never renames the file, and writes it only once, for the starting links of a new note -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the canvas pages are written with their files handed over as blob: URLs, never loaded by address -->
