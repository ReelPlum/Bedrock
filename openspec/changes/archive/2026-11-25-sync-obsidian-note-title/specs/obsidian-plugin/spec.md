# obsidian-plugin Specification

## ADDED Requirements

### Requirement: The note's name in the header SHALL be its file name

Inside Obsidian the canvas header shows the vault file's name without
`.bedrock`, and the two are kept the same in both directions.

#### Scenario: The header shows the file name
- **GIVEN** a new note `Handwritten note.bedrock`, and a note `Forces.bedrock` whose stored title is "Old title"
- **WHEN** each is opened in the view
- **THEN** the header shows "Handwritten note" and "Forces", and the next save stores the file name as the title
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the header shows the note's file name, and naming the note there renames the file -->

#### Scenario: Naming the note in the header renames the file
- **GIVEN** a note open in the view
- **WHEN** a new name is typed in the header and finished (Enter, or leaving the box)
- **THEN** the vault file is renamed once, in its folder, with Obsidian's `fileManager.renameFile` (so links to it are updated), and the index note or sidecar and the camera follow; typing alone renames nothing
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the header shows the note's file name, and naming the note there renames the file -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: naming a note in the header renames its file with Obsidian's file manager, in its folder -->

#### Scenario: Names a file cannot have
- **GIVEN** a name typed in the header
- **WHEN** it holds characters a file name or an Obsidian link cannot (`\ / : * ? " < > | # ^ [ ]`), is empty, or another file in the folder already has it
- **THEN** those characters become spaces; an empty name or a clash leaves the file as it is (a clash with a notice) and the header goes back to the file name
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a title becomes a file name Obsidian can link to -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the app can ask to rename the note; empty and unchanged names rename nothing -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: a header name another file already has renames nothing and says so -->

#### Scenario: Renaming the file in Obsidian updates the header
- **GIVEN** a note open in the view
- **WHEN** its file is renamed or moved in Obsidian
- **THEN** the view sends `renamed { name }` and the header shows the new name, which the next save stores as the title
<!-- test-js: apps/obsidian/tests/host.test.mjs :: renaming the file in Obsidian puts the new name in the header -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: the view tells the canvas when Obsidian renames its file -->

## MODIFIED Requirements

### Requirement: The plugin SHALL open .bedrock files and keep them safe

#### Scenario: Camera per file
- **GIVEN** two notes viewed at different places
- **WHEN** each is reopened, or one is renamed first (whether or not handwriting is searchable)
- **THEN** each comes back to its own view
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the camera is remembered per vault file -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: session camera is kept per file; the link picker and links get the note path -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: the camera follows a renamed note, even with search switched off -->

### Requirement: Every note SHALL have an index note that search and links can use

#### Scenario: Keeping index notes current
- **GIVEN** notes created, changed, renamed, deleted or written elsewhere
- **WHEN** the indexer runs
- **THEN** index notes are created, updated only on change, follow renames and deletes, and up-to-date ones are skipped; an empty new note is left alone, also when it is renamed
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: indexer creates, updates only on change, follows renames and deletes -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: indexer sync indexes notes written elsewhere and skips up-to-date ones -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: at start, an empty (new) note is left alone: nothing to index yet -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: correcting what the recogniser read updates the search index -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: renaming an empty note makes no index note -->
