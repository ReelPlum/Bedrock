# obsidian-sidecars Specification

## ADDED Requirements

### Requirement: An exported library SHALL drop into an Obsidian vault as it is

"Export all notes" SHALL write the folders as directories, each note as
`Name.bedrock`, and beside it the Markdown sidecar `Name.bedrock.md` with
the same bytes the Bedrock Obsidian plugin writes for that note.

#### Scenario: Folders, notes and sidecars in the ZIP
- **GIVEN** notes in nested folders, an empty folder, two notes with the same title and a note without a title
- **WHEN** the library is exported
- **THEN** every folder is a directory entry, each note is followed by its `.bedrock.md` sidecar, same names are told apart by id
- **AND** the sidecar names the note's path in its front matter, links to it, and holds its recognised text and links
<!-- test-js: apps/web/tests/library.test.mjs :: an exported library is a folder tree with a Markdown sidecar beside every note -->

#### Scenario: Exporting from the website
- **GIVEN** a folder with a note and an empty folder inside it
- **WHEN** "Export all notes" is chosen
- **THEN** the download holds `School/`, `School/Empty/`, `School/Forces.bedrock` and `School/Forces.bedrock.md`
<!-- test-js: apps/web/tests/folders.test.mjs :: export: the library becomes folders of notes, each with its Obsidian sidecar -->

### Requirement: The plugin SHALL use a sidecar beside a note as its index note

#### Scenario: Dropped into the vault's root
- **GIVEN** an exported library dropped into the vault's root, with the default index folder setting
- **WHEN** the plugin indexes the vault
- **THEN** nothing is written and no index note is made in the index folder; a later change to the note updates its sidecar
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a library exported by the website drops into the vault root and is already indexed -->

#### Scenario: Dropped into a subfolder
- **GIVEN** an exported library dropped into `Imports/Bedrock notes`
- **WHEN** a sidecar is opened, and the plugin indexes the vault
- **THEN** the sidecar opens the note beside it, and is rewritten once to name the note's new path
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a library dropped into a subfolder: sidecars open their note and are fixed to the new path -->

#### Scenario: Renaming and deleting a note
- **GIVEN** a note with a sidecar
- **WHEN** the note is renamed, then deleted
- **THEN** the sidecar follows the new name, then is deleted
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a sidecar moves with its note when the note is renamed, and goes when it is deleted -->
