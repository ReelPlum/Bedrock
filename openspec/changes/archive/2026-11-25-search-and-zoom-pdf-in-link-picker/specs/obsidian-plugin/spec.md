# obsidian-plugin Specification

## MODIFIED Requirements

### Requirement: Search hits and links SHALL lead to the ink

#### Scenario: Searching a PDF to link the page of a passage
- **GIVEN** a PDF open in the link picker
- **WHEN** text is typed in "Search in this PDF"
- **THEN** the matches are listed instead of the pages, each with its page and the words around it, found the way the search bar of Obsidian's PDF viewer finds them (any case, accents optional, over line breaks and hyphens at line ends); tapping a match links its page (`[[File.pdf#page=N]]`); no match says so; an empty search shows the pages again
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the link picker searches the text of an open PDF and links the page of a match -->

#### Scenario: The PDF search is Obsidian's
- **GIVEN** the plugin asked by the canvas to search a PDF (`pdf-find { path, query }`, a PDF and at most 200 letters only)
- **WHEN** Obsidian has loaded its PDF viewer (`window.pdfjsViewer`)
- **THEN** the viewer's PDF.js find controller finds the matches; before that the plugin's own matching, which finds the same; each match carries its page, the words around it and where it is in the page's text items (Obsidian's `selection=` numbers); at most 100 are listed, with the total
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the plugin searches a real PDF with the find controller of Obsidian's PDF viewer, and without it finds the same -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a PDF search's matches name the passage in the page's text items, as Obsidian's selection links count them -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the canvas may search PDFs only, for a short text -->

#### Scenario: Zooming a PDF in the link picker
- **GIVEN** a PDF open in the link picker, 3 pages across
- **WHEN** + or −, a pinch, or a trackpad pinch (ctrl + wheel) is used
- **THEN** the pages go to 2 and 1 across (bigger) or back to 3 and 4 (smaller), the page at the top stays in place, pages shown bigger are drawn again sharper, a page still links when tapped, and the next PDF opens as zoomed
<!-- test-js: apps/obsidian/tests/host.test.mjs :: an open PDF in the link picker zooms from 3 pages across to 2 and 1 and back, with buttons, a pinch or a trackpad -->
