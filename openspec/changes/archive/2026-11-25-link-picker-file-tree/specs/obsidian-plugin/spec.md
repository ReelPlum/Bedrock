# obsidian-plugin Specification

## MODIFIED Requirements

### Requirement: Search hits and links SHALL lead to the ink

#### Scenario: Links to and from words
- **GIVEN** a word's menu in the view
- **WHEN** a link is made, or a link to the word is copied
- **THEN** the canvas's own picker opens over the canvas (without focusing the link box, so no iPad keyboard) with the vault's folders and files as a tree (not index notes or the note itself) and a filter; the chosen link goes into the link box and Save makes the link, which reaches the file, `links.md`, the index note and Obsidian; closing the picker keeps the form; a copied link names a real stroke of the word
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the link picker shows the vault's folders and files; tapping a note puts its link in the box -->

#### Scenario: Linking to a page of a PDF or a word of another note
- **GIVEN** the link picker
- **WHEN** a PDF or a Bedrock note is tapped
- **THEN** a PDF opens as its pages (drawn by the plugin with Obsidian's PDF.js) and a page links as `[[File.pdf#page=N]]`; a Bedrock note opens as its picture with its words marked, and a word links as `[[Note.bedrock#^<stroke id>]]`; either can be linked whole instead
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the link picker opens a PDF to link one of its pages, or the whole file -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the link picker opens another Bedrock note to link one of its words, or the whole note -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: a PDF's pages are drawn for the link picker with Obsidian's PDF.js, and the open PDF is kept for the next page -->
