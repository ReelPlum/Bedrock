# The link picker is the vault's file tree, inside the canvas

## Why

Frederik, after beta.3: "the searching / browsing when linking is still not
working… maybe add so it really is the file structure of the project where
files are then clickable. On pdf files and notes files the document is then
opened and we can move / scroll to the location of page we want to link to
or just create the link without location/page."

"Make a link…" opened Obsidian's own search popup over the canvas. It lives
in Obsidian's window, outside the canvas's frame, so focus and taps cross
between the two; on the iPad picking from it did not reach the link box. It
also only searched names: no folders, no pages, no places.

## What changes

- The link picker is drawn by the canvas itself (`apps/web/src/link-picker.js`),
  over the canvas: the vault's folders and files as a tree (folders open and
  close), with a filter box on top.
- Tapping a Markdown note or any other file puts its link into the link box.
- Tapping a PDF opens its pages (rendered by the plugin with Obsidian's own
  PDF.js). Tap a page to link to it (`[[Paper.pdf#page=3]]`, Obsidian's own
  page links) or "Link the whole file".
- Tapping a Bedrock note opens its picture (`preview.svg` from the file), with
  its words marked. Tap a word to link to it (`[[Physics.bedrock#^<stroke>]]`,
  the existing link to a word), or "Link the whole note".
- The chosen link goes into the link box and Save makes the link, as before.
- New requests from the canvas to the plugin, replacing `pick-note`:
  `list-files` (every vault file except this note and index notes, with its
  link text), `read-note { path }` (the bytes of another `.bedrock` file, for
  its picture) and `pdf-page { path, page, width }` (the page count and a PNG
  of one page). Obsidian's search popup (`NotePicker`) is gone.

## Data format

No data format changes. The links made are the link text Obsidian already
uses (`#page=N`, and `#^<stroke>`, the existing link to a word), saved in the
existing link field, `links.md` and the index note. The requests above are
between the plugin and the canvas it ships with, and nothing new is stored.

Pointing a link at any spot in a Bedrock note (not only a word) would need a
new link format. Frederik was asked and chose links to a word you tap
(2026-11-23), so no format changes.

## Open source used

- **PDF.js** (Apache-2.0, Mozilla), the PDF renderer in Firefox, used through
  Obsidian's `loadPdfJs()`: Obsidian already ships it for its own PDF viewer,
  so nothing is added to the plugin. Mature: the browser's built-in viewer for
  over a decade.
