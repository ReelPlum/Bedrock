# obsidian-plugin Specification

## MODIFIED Requirements

### Requirement: Search hits and links SHALL lead to the ink

#### Scenario: Searching a PDF shows the pages it was found on
- **GIVEN** a PDF open in the link picker
- **WHEN** text is searched for
- **THEN** the matches are listed page by page, each page with its picture beside its matches, and tapping the picture or a match links the page
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the link picker searches the text of an open PDF and links the page of a match -->

#### Scenario: A PDF's text is read once for search
- **GIVEN** a PDF opened in the link picker
- **WHEN** it is searched again and again
- **THEN** the plugin reads each page's text once (starting as the PDF opens), and later searches only match the kept text; the file's bytes are read once per opened file, not for every page drawn
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a PDF's text is read once for search; later searches only match -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the plugin searches a real PDF with the find controller of Obsidian's PDF viewer, and without it finds the same -->

#### Scenario: Only the pages in sight are drawn
- **GIVEN** a long PDF open in the link picker
- **WHEN** it is scrolled fast to the end
- **THEN** pages that only flew by are not drawn, the pages in sight at the end are, at most two pictures are asked for at once, and pages not drawn yet already have their place
<!-- test-js: apps/obsidian/tests/host.test.mjs :: only the pages in sight are drawn: a fast scroll skips the pages passed on the way -->
