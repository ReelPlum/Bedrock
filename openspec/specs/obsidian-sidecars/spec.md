# obsidian-sidecars Specification

## Purpose
An exported library drops into an Obsidian vault as it is: each note has its Markdown sidecar (`Name.bedrock.md`) beside it, written by the same code as the Obsidian plugin's index notes, and the plugin uses those sidecars wherever they are dropped.

## Requirements

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

### Requirement: A handwritten # SHALL make no tag or heading in a sidecar

#### Scenario: Handwriting with #
- **GIVEN** a note whose recognised text has `#` in it (`# Forces #physics C#`)
- **WHEN** its sidecar (index note) is written
- **THEN** each `#` in the text section is written `\#`, so Obsidian sees no tag and no heading and shows a plain `#`; a search for `physics` or `#physics` still finds it, and a hit on it leads to its ink
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a handwritten # makes no tag or heading in the index note, and search still finds it -->

#### Scenario: Sidecars from before # was escaped
- **GIVEN** an index note written before `#` was escaped, newer than its note
- **WHEN** it is opened, searched, and the vault is indexed
- **THEN** it still opens its note and a hit finds the ink, and it is written again once, with each `#` escaped
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: index notes from before # was escaped: they still open their note, and are rewritten without tags -->

### Requirement: A sidecar SHALL carry the note's tags and the links of the whole note

#### Scenario: Tags and note links in the sidecar
- **GIVEN** a note with tags, a note link and a linked word
- **WHEN** its sidecar (index note) is written
- **THEN** the front matter says `tags: [bedrock, <the note's tags>]`, with only real tags, each once, quoted where YAML would misread them, and `## Links` lists the note link before the word's link
- **AND** a damaged tag list costs the tags and nothing else
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the index note carries the note's tags and the links of the whole note -->

#### Scenario: Sidecars from before tags
- **GIVEN** an index note written before tags existed, and the note it was written for
- **WHEN** the note is indexed again, and the old index note is opened
- **THEN** the index note is byte for byte the same, and the old one still names its note
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: index notes from before tags: an untagged note indexes the same, and old index notes still open their note -->

### Requirement: An index note SHALL link the index notes of the handwritten notes it links

A link to a handwritten note leads to its `.bedrock` file, which a tidy
graph hides. So an index note or sidecar whose links lead to other
handwritten notes ends with `## Linked handwritten notes`, linking each
one's index note once, and the graph draws the edge between the two
notes.

#### Scenario: In the vault
- **GIVEN** a note linking a word of another note, that note whole, a note with a sidecar, a word of itself, a note that does not exist and a PDF page
- **WHEN** the plugin indexes it
- **THEN** its index note ends with `## Linked handwritten notes` linking the other note's index note in the index folder and the sidecar of the note that has one, each once, and nothing for itself or the missing note; a search hit still finds its words; a note linking no handwritten note gets no section
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: an index note links the index notes of the handwritten notes its note links, so the graph shows the edge -->

#### Scenario: In an exported library
- **GIVEN** an exported note linking another exported note and a note not in the export
- **WHEN** the library is exported
- **THEN** its sidecar links the other note's sidecar only
<!-- test-js: apps/web/tests/library.test.mjs :: an exported sidecar links the sidecars of the exported notes its note links -->

#### Scenario: Index notes from before the section
- **GIVEN** an index note written before this section (`apps/obsidian/tests/fixtures/index-before-linked-notes.md`), newer than its note
- **WHEN** it is opened, searched, and the vault is indexed
- **THEN** it opens its note at the words found, and is rewritten once, the same with the section added
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: index notes from before linked notes: they still open their note, and are rewritten with the section -->
