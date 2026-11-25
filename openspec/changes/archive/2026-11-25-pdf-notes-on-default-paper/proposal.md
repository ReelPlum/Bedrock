# Notes made from PDFs start on the paper for new notes

## Why

Frederik: "And please make the paper for PDFs be the default paper style."

Notes made by importing a PDF were on plain paper, while new notes start on
grid (or the Obsidian plugin's "Paper for new notes").

## What changes

- The PDF reader (`crates/bedrock-core/src/pdf.rs`) puts imported notes on
  grid, the paper new notes start with, and `PdfPage::on_paper` puts them on
  another paper the app names.
- PDF import's WebAssembly (`import_pdf`, `import_pdf_as_one_note`) takes the
  paper as an optional last argument; left out, grid.
- The web app passes the paper for new notes (grid, or the host's
  `defaults().paper`). The Obsidian plugin's bulk import passes its "Paper
  for new notes" setting to the reader's worker (`paper` in its message).

## Data formats

None changed. `paper` in `note.json` keeps its values and meaning; imported
notes only get a different one of them (grid rather than plain). Notes
imported before keep the plain paper saved in them. The messages between
the plugin and its own PDF worker are inside one `main.js`, not stored.

## Open source used

None added.
