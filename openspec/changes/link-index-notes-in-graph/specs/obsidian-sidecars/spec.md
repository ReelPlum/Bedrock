# obsidian-sidecars Specification

## ADDED Requirements

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
