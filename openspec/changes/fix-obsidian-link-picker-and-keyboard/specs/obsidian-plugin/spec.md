# obsidian-plugin Specification

## MODIFIED Requirements

### Requirement: Search hits and links SHALL lead to the ink

#### Scenario: Links to and from words
- **GIVEN** a word's menu in the view
- **WHEN** a link is made, or a link to the word is copied
- **THEN** the vault note picker opens (not index notes or the note itself), without focusing the link box (no iPad keyboard); the chosen note goes into the link box and Save makes the link, which reaches the file, `links.md`, the index note and Obsidian; closing the picker keeps the form; a copied link names a real stroke of the word
<!-- test-js: apps/obsidian/tests/host.test.mjs :: bug: the note chosen in Obsidian's picker goes into the link box, and Save makes the link -->

#### Scenario: The iPad keyboard does not hide the word menu
- **GIVEN** a word's menu open low in the view on an iPad
- **WHEN** the on-screen keyboard comes up (Obsidian sets `--keyboard-height` and fires `keyboardWillShow` without resizing the view) or the visible part of the window shrinks
- **THEN** the view tells the canvas how much of its bottom is hidden (`inset { bottom }`), the menu moves above the keyboard with its text box in sight, and back when the keyboard goes
<!-- test-js: apps/obsidian/tests/host.test.mjs :: bug: the word menu moves above the iPad keyboard, and back when it goes -->
