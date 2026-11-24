# Search and zoom a PDF in the link picker

## Why

Frederik (2026-11-23): "Can you somehow add in pdf searching for when you
want to link to a specific file. Try to use the default search in pdfs
obsidian uses. It works great." And: "Also make it so you can zoom on the
view changing it from 3 pages on a horizontal to 2 and 1 etc."

The link picker opens a PDF as small pictures of its pages. In a long PDF
the page with the passage you want is hard to find, and the pictures are too
small to read.

## What changes

- An open PDF in the picker has a search box ("Search in this PDF"). The
  matches are listed instead of the pages, each with its page and the words
  around it; tapping one links that page (`[[File.pdf#page=N]]`, as tapping
  the page does). Clearing the box shows the pages again.
- The search is the one of Obsidian's own PDF viewer: the plugin runs the
  viewer's PDF.js find controller (`window.pdfjsViewer.PDFFindController`)
  on the PDF, headless, so the same passages are found as with Obsidian's
  search bar (any case, accents optional, spaces and hyphens at line ends
  forgiven). Obsidian loads its viewer the first time a PDF is opened in
  it; before that the plugin matches with the same rules itself
  (`findInText`), and a test shows both find the same.
- Zoom: − and + beside the search box, a pinch, or a pinch on a trackpad
  (ctrl + wheel) change the pages from 3 across to 2 and 1 (or 4). Pages
  shown bigger are drawn again at their new size, so they stay sharp. The
  page at the top stays in place, and the picker keeps the zoom for the next
  PDF. The picker is wider (up to 900px) while a PDF is open.
- A new request from the canvas to the plugin: `pdf-find { path, query }`
  answers `{ count, total, hits: [{ page, before, match, after, selection }] }`
  (at most 100 hits; `selection` is where the match is in the page's text
  items, the numbers of Obsidian's `#page=N&selection=…` links).

### Why not Obsidian's PDF view itself

The picker is drawn by the canvas inside its iframe; Obsidian's PDF view
(with its find bar) lives in Obsidian's window, and Obsidian does not offer
it to plugins as an embeddable component. Putting Obsidian's own UI over the
canvas is what broke the old picker on the iPad (taps and focus crossing
between the two windows; see `link-picker-file-tree`). So the plugin reuses
the part that does the finding, the find controller, and the canvas draws
the results.

## Data format

No data format changes. The links made are `#page=N`, Obsidian's page links
already used. `pdf-find` is between the plugin and the canvas it ships with,
and nothing new is stored. Linking the exact passage (Obsidian's
`#page=N&selection=…`) would put a new kind of link text in notes; Frederik
was asked and chose links to the page (2026-11-24). `selection` is still
returned, so passage links would be a small change later.

## Open source used

- **PDF.js** (Apache-2.0, Mozilla): already used through Obsidian's
  `loadPdfJs()` to draw the pages. Its find controller (`PDFFindController`,
  `web/pdf_find_controller.js`) is the search of Firefox's PDF viewer and of
  Obsidian's; the plugin uses the copy Obsidian ships (`window.pdfjsViewer`),
  so nothing is added to the plugin. Mature: Firefox's built-in viewer for
  over a decade, maintained by Mozilla, and among the most downloaded
  PDF libraries on npm.
- **pdfjs-dist 4.10.38** (Apache-2.0), test only (`devDependencies`): the
  same find controller and PDF.js, so a browser test runs the plugin's
  search on a real PDF as Obsidian's viewer would. Not shipped.

Built here: `findInText`, the matching used before Obsidian has loaded its
viewer (about 30 lines). The alternative was bundling a second copy of
PDF.js's viewer (several hundred kB, and possibly a different version from
the PDF.js Obsidian hands the plugin). It follows the find controller's
rules, and a test compares the two on the same PDF.
