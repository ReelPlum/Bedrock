# Fast PDF search, matching pages in the results, and pages drawn only in sight

## Why

Frederik (2026-11-24), after `search-and-zoom-pdf-in-link-picker`:

- "Please research good search algorithms for this usecase that are very
  fast. No need for OCR as it will be search in already OCR'ed PDFS". The
  research ("Fast PDF search in the link picker", a Claude doc) measured a
  500-page PDF: each search took 0.7 to 1.1 s, almost all of it reading the
  PDF's text again (772 ms) and folding it again (253 ms); matching text
  already read and folded takes 1 to 5 ms.
- "Also on the search view I want to see the pages where it found the
  matching text."
- "RN it loads everything from the top to bottom when I scroll fast. It
  should somehow only load the images for the pages visible at the moment
  supporting fast scrolling."

## What changes

- **Text read once.** The plugin reads a PDF's text once per opened file
  (again only when the file changes) and keeps it, folded, with the open
  PDF. The picker asks `pdf-find` with an empty query as the PDF opens, which
  starts that reading. One PDF.js find controller (Obsidian's viewer's) is
  kept per open PDF instead of one per search; it also reads the text once.
  Searches run one at a time; the same search again is answered from the
  last one. Opening the same PDF for another page no longer reads the file:
  the plugin's `read` hands the bytes as a function, called only when the PDF
  is opened.
- **Matching pages in the results.** Matches are grouped by page; each page
  shows its picture (drawn small, only when in sight) beside its matches.
  Tapping the picture or a match links the page.
- **Only pages in sight are drawn.** At most two pictures are asked of the
  plugin at once, the top page in sight first. While the pages fly by
  (faster than a screen and a half a second) nothing new is asked for; once
  the scrolling slows for 120 ms, the pages then in sight are drawn. Pages
  not drawn yet have the first page's shape, so the scroll bar and the
  pages' places are right from the start.

## Data format

No data format changes: the text is kept in memory only while the PDF is
open, links stay `#page=N`, and `pdf-find` keeps its answer. Saving the read
text so a PDF opens instantly next time would be new stored data and would
be asked about first.

## Open source used

No new library. The research compared a plain scan of kept text with
indexes and search libraries (MiniSearch, uFuzzy, fst, Tantivy, suffix
arrays, memchr): for one PDF of a few MB a scan of kept text answers in
milliseconds and an index costs more to build than hundreds of scans. PDF.js
(already used) still reads the text and its find controller still matches.
