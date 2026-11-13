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
| Each pen stroke | One stroke, in the order it was written, with its colour and its width along the line (thin and thick parts as drawn). Transparent strokes become highlighter strokes. |
| GoodNotes's own reading of the handwriting (hidden text in the page) | The reading of the word under it (engine `pdf-text`), shown like any recognised word. The recogniser keeps it rather than reading the word again. |
| Pictures (screenshots, photos) | The same picture, at the same place and size on the page, under the ink. JPEGs are kept as they are; other pictures are saved as PNG. |
| Typed text, filled shapes, JPEG 2000 pictures | Left out; the message after importing says how many. |

A PDF keeps no timing or pressure. The strokes get times as if written at
an even speed, and a middle pressure, so stroke order is kept exactly.

## Training data

With saving set up on `/train`, every word of an imported PDF is sent for
training at once, marked unchecked, with the PDF's reading alongside (see
[training-data.md](training-data.md)). Nothing is sent without that consent.

## How it works

`crates/bedrock-core/src/pdf.rs` reads the page tree and content streams
(Flate or uncompressed, object streams and form XObjects included).
Pen apps draw each stroke as one filled shape made of short overlapping
pieces, each an outline around a stretch of the line: GoodNotes with flat
ends, Apple Notes with round ends drawn as curves, plus a round dab at each
pen sample. The importer finds each piece's two ends (along its longest
direction). Along a round-ended piece, each point of one side gives the
largest round dab inside the piece that touches it there: its centre is on
the line and its size is the line's width there, and on a round end every
point gives the end's own dab, centred where the pen was, so the pieces
meet exactly. A four-cornered piece takes the line halfway between its two
sides. A dab is a point as wide as the circle. The pieces are joined
in order into one stroke. The brush is as wide as the stroke's widest point
and narrower points press lighter, so the line keeps the widths the PDF
drew; taper and speed thinning are off for imported strokes, and the exact
PDF points are not smoothed as if they were screen pixels, so small
handwriting keeps its shape. Stroked paths (other apps) are taken as they
are. The hidden
text layer sits far off the page, so it is first lined up with the ink
(bounds, then nudged towards the ink under it until it settles) and each
piece of text is given to the word it lands on.

Pictures are placed by the matrix in force when they are drawn (their
bounds, so a mirrored picture is mirrored back). Raw pixels in any bit
depth, grey, RGB, CMYK or palette colours, with or without PNG
predictors, are written as PNG, with a soft mask as transparency. A
picture drawn on every page (a paper template, say) is decoded once.
