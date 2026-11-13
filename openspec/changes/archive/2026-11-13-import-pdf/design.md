# Design: import handwritten PDFs

## Context

GoodNotes exports a page as a Quartz PDF: Flate compressed content streams,
often inside object streams, with a damaged or missing cross-reference
table in some exports. Each pen stroke is one filled path (`f`) made of
closed pieces, each going out along one edge of the line and back along the
other, in the order the strokes were written. GoodNotes hides its own
handwriting recognition as invisible text (`3 Tr`), placed far off the page
(about 136 000 units in Frederik's exports). Pictures (screenshots) are
image XObjects of raw pixels, Flate compressed, ICC based RGB.

## Decisions

- **Own reader in `bedrock-core`, no PDF crate.** Only a small part of PDF
  is needed: objects, object streams, the page tree, content streams, form
  and image XObjects. A forgiving reader that scans for `n g obj` survives
  damaged cross-reference tables, adds no dependency (miniz_oxide is already
  used for `.bedrock` files) and compiles to WebAssembly.
- **Centre line from the outline.** The outward half of each piece is the
  centre line; the piece's area over its length is the width. The pen is
  thin next to the letters, so the edge is close enough to the centre.
  Stroked paths from other apps are taken as they are.
- **Synthesised timing.** A PDF has no timing or pressure. Strokes get times
  at an even 0.1 units/ms with 150 ms between strokes, and pressure 0.5, so
  stroke order (all the recogniser and training use) is exact.
- **Readings matched by place.** The text layer is lined up with the ink by
  bounds, then moved by the median distance to the nearest ink until it
  settles; each span goes to the word it lands on, engine `pdf-text`.
- **Pictures as files the browser opens.** JPEGs (`DCTDecode`) are kept byte
  for byte. Raw pixels (1 to 16 bits, grey, RGB, CMYK, palette, PNG
  predictors, `/Decode` arrays, a soft mask as transparency) are written as
  PNG by a small encoder. Placement is the bounds of the unit square under
  the current matrix; a mirrored picture is mirrored back. JPEG 2000,
  stencil masks and inline images are left out and reported. A picture
  drawn on many pages is decoded once. Pictures over 16 megapixels are left
  out, to keep WebAssembly memory in bounds.
- **No data format change.** Imported notes use existing note fields; the
  `pdf-text` engine is a value in the existing free text `engine` field.
  Training samples use the existing `bedrock-training` version 2 fields.
  The consent text changed (it now names imported PDFs), so its version
  went from 1 to 2; that is a value, and samples sent under version 1 stay
  valid.

## Risks

- Other apps may draw ink differently (for example as many short stroked
  segments). Those come across as more, shorter strokes; still usable.
- Rotated pictures are placed by their bounds but not rotated.
