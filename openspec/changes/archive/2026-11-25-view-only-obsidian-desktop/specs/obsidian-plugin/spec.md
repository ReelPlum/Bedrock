# obsidian-plugin Specification

## ADDED Requirements

### Requirement: The ink SHALL be locked in Obsidian on a computer

In Obsidian's desktop app (Mac, Windows, Linux) a Bedrock note opens "view
only": it can be looked at, moved, zoomed and searched, its links followed,
its tags edited and what the recogniser read corrected, but its ink,
pictures and text boxes never change. On the iPad and phones notes are
edited as before.

#### Scenario: Pen, mouse and fingers move the page and never draw
- **GIVEN** a note open view only
- **WHEN** the pen, the mouse or a finger is dragged across it (with "Draw with finger" on too), or two or three fingers double-tap
- **THEN** the page moves and nothing is drawn, erased, selected, undone or redone
<!-- test: view_only_pen_and_mouse_move_the_page_and_never_draw -->
<!-- test: view_only_ignores_undo_redo_and_eraser_taps -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: on a computer the ink is locked: pen and mouse move the page, scrolling zooms, nothing is drawn; tags and readings are edited and saved -->

#### Scenario: Scrolling zooms
- **GIVEN** a note open view only
- **WHEN** the mouse wheel turns, or two fingers scroll on a trackpad
- **THEN** the page zooms around the pointer (in when scrolling up, about a fifth per wheel notch) instead of moving; a trackpad pinch zooms as before
<!-- test-js: apps/obsidian/tests/host.test.mjs :: on a computer the ink is locked: pen and mouse move the page, scrolling zooms, nothing is drawn; tags and readings are edited and saved -->

#### Scenario: Only what leaves the ink alone is offered
- **GIVEN** a note written on the iPad, with words, a tag and a link of the whole note, opened view only
- **WHEN** it is shown
- **THEN** the toolbar, undo, redo, inserting, pasting, importing and the pen's settings are hidden, the header says "View only" and its name cannot be edited; a word's menu says what the word was read as, corrects it ("This is right", "Correct the text…", maths or text, "Not a word") and copies a link to it, but does not link, group, recolour, duplicate or delete; "Tags and links…" adds and removes tags, and lists the links and opens one, with nothing to add or remove; "Show all ink" stays
<!-- test-js: apps/obsidian/tests/host.test.mjs :: on a computer the ink is locked: pen and mouse move the page, scrolling zooms, nothing is drawn; tags and readings are edited and saved -->

#### Scenario: Tags and corrections are saved; nothing else is
- **GIVEN** a note open view only
- **WHEN** keys for undo, redo, tools or delete are pressed, text is pasted, the recogniser reads, and the view saves and closes; then a reading is corrected and tags are added and removed
- **THEN** the first changes nothing and writes nothing (no autosave, so opening a note on a computer never writes it); each correction and tag change is saved at once with the ink exactly as it was, and reaches the index note
<!-- test-js: apps/obsidian/tests/host.test.mjs :: on a computer the ink is locked: pen and mouse move the page, scrolling zooms, nothing is drawn; tags and readings are edited and saved -->

#### Scenario: The plugin refuses changed ink
- **GIVEN** a view-only canvas asks to write its file
- **WHEN** the new file adds, removes or changes strokes (their samples or brush), pictures or text boxes, or cannot be read
- **THEN** the plugin refuses it and the file keeps its bytes; a file whose ink, pictures and text boxes are as they were (tags, readings, links of the whole note) is written, and a note from before `points.bin` may be written with its samples moved there; the file is never renamed
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a view-only session never renames the file, and writes it only with its ink exactly as it was -->

#### Scenario: New notes are made on a computer, and written on the iPad
- **GIVEN** the plugin in Obsidian's desktop app
- **WHEN** it loads, and "New Bedrock note" (ribbon, folder menu, command) or "New handwritten note linking here" (note, PDF or editor menu, command) is chosen
- **THEN** the empty note is made as on the iPad and opens view only (`BEDROCK_VIEW_ONLY`); the header cannot rename it
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: on a desktop computer notes are view only, and new notes are still made; the iPad edits -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the canvas pages are written with their files handed over as blob: URLs, never loaded by address -->

#### Scenario: A note made about a page keeps its link on a computer
- **GIVEN** a note made on a computer with "New handwritten note linking here"
- **WHEN** its view-only canvas starts
- **THEN** it asks for the starting link and saves it at once, as on the iPad; after that the ink is locked
<!-- test-js: apps/obsidian/tests/host.test.mjs :: a note made on a computer about a page keeps its link, and is view only after that -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a view-only session never renames the file, and writes it only with its ink exactly as it was -->
