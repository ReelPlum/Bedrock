# obsidian-plugin Specification

## ADDED Requirements

### Requirement: A handwritten note SHALL be made from a note or PDF, linking to it

"New handwritten note linking here" SHALL be offered in the editor menu of a
Markdown note, in the file menu of a Markdown note or PDF, in a right-click
inside a PDF that Obsidian leaves unanswered, and in the command palette.

#### Scenario: From a note or a PDF page
- **GIVEN** a Markdown note and a PDF scrolled to its fourth page
- **WHEN** the item is chosen in the note's editor menu, the PDF's ⋯ menu, a right-click on the PDF's second page, the file explorer, or the command palette
- **THEN** an empty note is made next to the page, named after it (`Lecture 3 notes`, `Week 3 page 4 notes`) without overwriting a file, and opened; it starts with a link of the whole note to the note, the page in view (`#page=4`), the page right-clicked, or the whole PDF when it is not open
- **AND** it is not offered for index notes, handwritten notes, or a right-click Obsidian answered with its own menu
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: a note or PDF offers "New handwritten note linking here": named after the page, it starts with a link to it -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: registers the .bedrock view, commands and settings, and writes nothing into the plugin folder -->

#### Scenario: The canvas saves the link at once
- **GIVEN** a note made this way
- **WHEN** its canvas starts
- **THEN** it asks for the starting link once (`start`), adds it, and saves straight away with no ink; the link reaches the file, `links.md` and the index note, and is not added again when the note reopens
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a new note's starting link is handed to its canvas once -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: a note made about a page starts with its link, saved at once; tags and links of the whole note reach the file and the index -->

### Requirement: The canvas SHALL show and edit the note's tags and links

#### Scenario: Tags and links… in the menu
- **GIVEN** a note open in the canvas
- **WHEN** "Tags and links…" is chosen in the menu and tags, a PDF page from the vault picker and a website are added, and a tag and a link are removed
- **THEN** the panel shows them, stays open over the picker, refuses a tag already there, opens a link with Obsidian, and the file and the index note get the tags and links
<!-- test-js: apps/obsidian/tests/host.test.mjs :: a note made about a page starts with its link, saved at once; tags and links of the whole note reach the file and the index -->
<!-- test-js: apps/web/tests/app.test.mjs :: tags and links of the whole note: added and removed from the menu, with no ink, and kept when the note reopens -->
