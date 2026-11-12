# Importing handwritten PDFs

Notes written in GoodNotes (and apps that export the same way) can be
brought into Bedrock as real ink: **Open file…** or **Import PDF
(GoodNotes)…** in the menu, then pick the PDF. Each page with handwriting
becomes its own note, named after the file (`Lecture 7 (page 2)`).

In GoodNotes, export with **Share → Export → PDF**. Either "PDF Data
Format" setting works; what matters is that the page is not flattened into
a picture.

## What comes across

| From the PDF | In Bedrock |
|---|---|
| Each pen stroke | One stroke, in the order it was written, with its colour and width. Transparent strokes become highlighter strokes. |
| GoodNotes's own reading of the handwriting (hidden text in the page) | The reading of the word under it (engine `pdf-text`), shown like any recognised word. The recogniser keeps it rather than reading the word again. |
| Pictures, typed text, filled shapes | Left out; the message after importing says how many. |

A PDF keeps no timing or pressure. The strokes get times as if written at
an even speed, and a middle pressure, so stroke order is kept exactly.

## Training data

With saving set up on `/train`, every word of an imported PDF is sent for
training at once, marked unchecked, with the PDF's reading alongside (see
[training-data.md](training-data.md)). Nothing is sent without that consent.

## How it works

`crates/bedrock-core/src/pdf.rs` reads the page tree and content streams
(Flate or uncompressed, object streams and form XObjects included).
GoodNotes draws each stroke as a filled outline of short pieces, each going
out along one edge of the line and back along the other; the outward half
of each piece is the centre line, and the piece's area over its length is
the width. Stroked paths (other apps) are taken as they are. The hidden
text layer sits far off the page, so it is first lined up with the ink
(bounds, then nudged towards the ink under it until it settles) and each
piece of text is given to the word it lands on.
