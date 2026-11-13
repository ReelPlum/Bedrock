# Import handwritten PDFs

## ADDED Requirements

### Requirement: Streams in any standard PDF filter SHALL be read

Content streams, forms and pictures stored with any of the standard
non-image filters (Flate, LZW, ASCII85, ASCII hex, run length, with or
without predictors, alone or chained) SHALL be read.

#### Scenario: ASCII hex around Flate
- **GIVEN** a page whose content stream is Flate data written out as ASCII hex
- **WHEN** it is imported
- **THEN** its ink becomes a stroke
<!-- test: pdf_streams_in_any_standard_filter_are_read -->

### Requirement: A stream that would unpack too large SHALL be left out

A stream SHALL NOT be unpacked when it would come to more than 128 MB, so a
small crafted file cannot fill the memory of the browser tab.

#### Scenario: A compressed bomb
- **GIVEN** a page whose content stream is a few hundred kilobytes that unpack to more than 128 MB
- **WHEN** it is imported
- **THEN** the stream is left out without being unpacked, and the import finishes
<!-- test: pdf_stream_that_unpacks_too_large_is_left_out -->

## Open source used

| | hayro-syntax | png |
|---|---|---|
| Version | [0.9](https://crates.io/crates/hayro-syntax), default features off (`std` only) | [0.18](https://crates.io/crates/png) |
| Used for | Reading the PDF file: cross-reference tables (and repairing damaged ones), objects, object streams, the page tree, stream filters and predictors, content stream operators, inline images. | Writing raw pixel pictures as PNG files. |
| Why this one | Read only, lenient with damaged files, small, and builds for WebAssembly with no C code. It does everything the hand-written reader did and more (all standard filters, damaged cross-reference tables). It sets no limit on how far a stream unpacks, so Bedrock measures each stream first (see the requirement above). Image decoding (the `images` feature) is left off: JPEGs are kept as they are. | The standard PNG crate of the Rust image project. Writes exactly the PNG files we need (8 bit grey, grey with alpha, RGB, RGBA). |
| Why it is mature | Young: first release June 2025, 12 releases since, the last in November 2026; 6.5 million downloads. Trusted because Typst (`typst-library`) uses it to read PDF files placed in documents, its author maintains Typst's PDF crates (krilla, hayro). On Frederik's GoodNotes exports it gives the same strokes, points, readings and picture places as the hand-written reader. | Since 2015, about 310 million downloads, maintained by the image-rs organisation, used by the `image` crate and most Rust programs that read or write PNG. |
| Licence | MIT or Apache-2.0: commercial use allowed. | MIT or Apache-2.0: commercial use allowed. |
| Considered | `lopdf` (mature, but pulls in encryption, parsing and threading crates we do not need, and is built to edit files rather than read damaged ones); `pdf` (pdf-rs, less active); pdf.js (not Rust, and runs only in the browser); keeping our own reader (it only knew Flate and had only our tests). | Keeping our own writer (a few lines on `miniz_oxide`, but every chunk and checksum was ours to get right). |
| Not Rust | No. | No. |

What stays Bedrock's own: turning filled outlines and stroked paths into
strokes, giving them times, matching the hidden text layer to words, and
placing pictures. No library does these; they are what the importer is for.
