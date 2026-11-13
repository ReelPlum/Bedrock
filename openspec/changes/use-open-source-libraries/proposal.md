# Use proven open source libraries in place of hand-written code

## Why

The open source survey of 12 November 2026 found hand-written code in
Bedrock that well known, tested libraries already do: the ZIP container,
Base64, the PDF reader and the PNG writer among them. Our own versions only
get the testing we give them; the libraries are used and fixed by thousands
of projects. Frederik asked for the survey's suggestions to be put in place
(docs/open-source-first.md).

## What changes

- The `.bedrock` ZIP container is written and read with the `zip` crate,
  CRC-32 with `crc32fast`, and Base64 with `base64`.
- Saved notes are checked against the published schema
  (`docs/note.schema.json`) with `jsonschema`, and random notes and damaged
  files are generated with `proptest` (test only).
- SVG exports are read back with `roxmltree`, so one re-saved by a drawing
  program still opens.
- The PDF importer reads the file with `hayro-syntax` and writes PNG files
  with `png`. Bedrock's own part (turning pen paths into strokes, the hidden
  text layer, placing pictures) stays.

## Open source

Each library is recorded with why it was chosen, why it is mature, its
licence and what was turned down, in the "Open source used" section of the
spec it belongs to: `note-format` (zip, crc32fast, base64, roxmltree, jsonschema,
proptest) and `import-pdf` (hayro-syntax, png).

## Data formats

None change. A `.bedrock` file written by the new code has the same entries,
names, compression and contents as before, and files written by the old
writer still open (`archives_from_the_earlier_writer_still_open`). PDF import
gives the same notes as before on Frederik's real GoodNotes exports: the same
strokes, points, readings and picture places, PNG pixels identical and files
a little smaller.

## Impact

- `crates/bedrock-core`: `zip.rs`, `format.rs`, `pdf.rs`, `Cargo.toml`, new
  `tests/schema.rs`.
- The WebAssembly build grows by about 270 KB before compression (mostly the
  `zip` crate).
