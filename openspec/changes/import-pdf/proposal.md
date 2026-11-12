# Import handwritten PDFs

## Why

Frederik's class notes are in GoodNotes. Their PDF exports keep every pen
stroke as a vector path in writing order, and a hidden text layer with
GoodNotes's reading of the handwriting. Importing them gives him his notes
in Bedrock and, with his consent, real handwriting with a first reading for
training.

## What changes

- `bedrock_core::pdf` turns each PDF page with ink into a note.
- Pictures on the page (screenshots, photos) come across where they sit.
- The web app imports a PDF from Open or "Import PDF (GoodNotes)…".
- With saving set up, every imported word is sent as an unchecked sample
  with the PDF's reading. The consent text says so (consent version 2).
- Fix: the word layout cache was keyed by document revision only, so a note
  opened after another with the same revision showed the old note's words.

## Data formats

None change. Imported notes use the note fields every note has: strokes,
`recognized.json` (engine `pdf-text`, a value in the existing free text
`engine` field), `images` and files under `images/`. Training samples use
the existing `bedrock-training` version 2 fields (`model_reading`,
`model_engine`). The consent text names imported PDFs now, so
`CONSENT_VERSION` goes from 1 to 2: writers who agreed to the old text are
asked again, and samples already sent under version 1 stay valid.

## Impact

- `crates/bedrock-core/src/pdf.rs` (new), `crates/bedrock-web` (`import_pdf`).
- `apps/web`: menu item, import flow, `share-words.js`, `collect.js`.
- Docs: `docs/import-pdf.md` (new), `docs/training-data.md`.
