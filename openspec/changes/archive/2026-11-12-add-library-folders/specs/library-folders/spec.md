# library-folders Specification

## ADDED Requirements

### Requirement: The website SHALL keep notes in folders saved on the device

Folders SHALL be saved in the same on-device storage as notes and SHALL
survive a reload. Folders can be nested, renamed and deleted, and a note can
be moved between them.

#### Scenario: Nested folders and a note in one survive a reload
- **GIVEN** the notes list
- **WHEN** the writer makes a folder "School", a folder "Physics" in it, and a new note "Forces" while "Physics" is shown
- **AND** the page is reloaded
- **THEN** the note reopens, the list still shows "Physics" with "Forces" in it, and "‹ School" leads back up
<!-- test-js: apps/web/tests/folders.test.mjs :: folders: make nested folders, write a note in one, and find it there after a reload -->

#### Scenario: Two folders with the same name are refused
- **GIVEN** a folder "Physics" in "School"
- **WHEN** the writer names another folder in "School" "physics"
- **THEN** it is refused with a message and the name can be changed
<!-- test-js: apps/web/tests/library.test.mjs :: a folder name must be new among its siblings, ignoring case -->

#### Scenario: Folder names work as directory names everywhere
- **GIVEN** a name with path characters, a leading dot or trailing dots
- **WHEN** it is used for a folder
- **THEN** those characters are removed
<!-- test-js: apps/web/tests/library.test.mjs :: folder names are kept to what every file system and Obsidian accept -->

#### Scenario: Move, rename and delete
- **GIVEN** an open note and a folder
- **WHEN** the note is moved into the folder and saved again, the folder is renamed, and then deleted after a confirmation naming how many notes are in it
- **THEN** the note keeps its folder across saves, and deleting the folder deletes the note and opens a new one
<!-- test-js: apps/web/tests/folders.test.mjs :: folders: move a note, rename a folder, and deleting a folder deletes what is in it -->

#### Scenario: Notes from before folders
- **GIVEN** notes saved by a version without folders
- **WHEN** the app opens
- **THEN** they are listed at the top and folders can be added
<!-- test-js: apps/web/tests/folders.test.mjs :: notes saved before folders existed are kept, at the top -->

#### Scenario: Nothing becomes unreachable
- **GIVEN** a note or folder whose folder no longer exists
- **WHEN** the list is shown
- **THEN** it is shown at the top
<!-- test-js: apps/web/tests/library.test.mjs :: folders nest: paths, contents and everything below a folder -->

#### Scenario: An autosave does not throw away a folder name being typed (regression)
- **GIVEN** the writer is typing a new folder's name
- **WHEN** the open note is saved in the background
- **THEN** the name field and what was typed stay
<!-- test-js: apps/web/tests/folders.test.mjs :: an autosave while a folder is being named keeps the name being typed -->
