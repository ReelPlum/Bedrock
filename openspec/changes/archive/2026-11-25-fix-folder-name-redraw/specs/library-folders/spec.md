# Library folders

## ADDED Requirements

### Requirement: A folder name being typed SHALL survive the notes list redrawing

The notes list redraws on its own (when it opens, after a save, when another window changes the notes). A folder row being named or renamed SHALL be kept as it is, with its focus and what was typed, and the rest of the list redrawn around it.

#### Scenario: A redraw while naming a new folder or renaming one (regression)
- **GIVEN** the writer has tapped "New folder" and typed part of a name
- **WHEN** the notes list redraws
- **THEN** the name field and what was typed stay, and the other folders are still listed
- **AND** a folder being renamed is kept in its place and not listed twice
<!-- test-js: apps/web/tests/folders.test.mjs :: the notes list redrawing while a folder is being named keeps the name being typed -->
