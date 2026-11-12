# Import handwritten PDFs

## Why

Frederik's class notes are in GoodNotes. Their PDF exports keep every pen
stroke as a vector path in writing order, and a hidden text layer with
GoodNotes's reading of the handwriting. Importing them gives him his notes
in Bedrock and, with his consent, real handwriting with a first reading for
training.

## What changes

- `bedrock_core::pdf` turns each PDF page with ink into a note.
- The web app imports a PDF from Open or "Import PDF (GoodNotes)…".
- With saving set up, every imported word is sent as an unchecked sample
  with the PDF's reading. The consent text says so (consent version 2).
- Fix: the word layout cache was keyed by document revision only, so a note
  opened after another with the same revision showed the old note's words.
