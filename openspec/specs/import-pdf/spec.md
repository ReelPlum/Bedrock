# import-pdf Specification

## Purpose
Bringing handwritten PDFs (GoodNotes exports and similar) into Bedrock as real notes: pen strokes in writing order, pictures where they sit, and the PDF's own hidden reading of the handwriting. With consent, the imported words are sent for training. `docs/import-pdf.md` explains it for people; the reader is `crates/bedrock-core/src/pdf.rs`. Importing changes no data format.

## Requirements

### Requirement: PDF ink SHALL become note strokes in writing order

Each page of a PDF that has handwriting or pictures SHALL become a note whose strokes follow the pen paths in the order they were written.

#### Scenario: A GoodNotes-style page
- **GIVEN** a PDF page where each stroke is a filled outline made of pieces
- **WHEN** it is imported
- **THEN** each outline becomes one stroke along its centre line, with its colour and width, in page order, with increasing times
<!-- test: pdf_strokes_become_note_strokes_in_writing_order -->

#### Scenario: Stroked paths and form XObjects
- **GIVEN** a PDF whose ink is stroked lines, some inside a form XObject
- **WHEN** it is imported
- **THEN** each line becomes a stroke, placed by the form's matrix
<!-- test: pdf_stroked_paths_and_form_xobjects_are_read_too -->

#### Scenario: Damaged files
- **GIVEN** a file that is not a PDF, or a cut or damaged one
- **WHEN** it is imported
- **THEN** it is refused or read as far as it goes, never crashing
<!-- test: pdf_damaged_or_not_a_pdf_is_refused_without_panicking -->

### Requirement: Pictures SHALL come across where they sit on the page

Pictures on a page SHALL become pictures on the note, at the same place and size, under the ink.

#### Scenario: Screenshots and photos
- **GIVEN** a page with pictures stored as raw pixels (RGB, grey with a soft mask and a PNG predictor, a 1 bit palette) and as JPEG, one of them drawn upside down
- **WHEN** it is imported
- **THEN** each is placed where it sits on the page, raw pixels saved as PNG and JPEGs byte for byte as they are
- **AND** the upside down one is turned the right way up
- **AND** a page with only pictures is still imported
<!-- test: pdf_pictures_come_across_where_they_sit_on_the_page -->

#### Scenario: A picture that cannot be read
- **GIVEN** a picture in a format Bedrock does not read (JPEG 2000)
- **WHEN** the page is imported
- **THEN** the rest of the page comes across and the message after importing says one picture was left out
<!-- test: pdf_pictures_come_across_where_they_sit_on_the_page -->

### Requirement: The PDF's own reading SHALL be kept

Hidden text over the handwriting SHALL become the reading of the word under it.

#### Scenario: Text layer far off the page
- **GIVEN** invisible text placed with a large offset from the ink, as GoodNotes does
- **WHEN** the page is imported
- **THEN** each piece of text is matched to the word it covers, with engine `pdf-text`
<!-- test: pdf_hidden_text_becomes_the_words_reading -->

### Requirement: An imported page SHALL be an ordinary note

Importing SHALL NOT change the note format. Strokes, recognised text and pictures SHALL use the fields every note already has (`strokes`, `recognized.json`, `images` and files under `images/`), so an imported note opens in any version of Bedrock that opens notes with pictures.

#### Scenario: Saved and opened again
- **GIVEN** an imported page with pictures
- **WHEN** it is saved as `.bedrock` and opened again
- **THEN** it has the same pictures and picture files
<!-- test: pdf_pictures_come_across_where_they_sit_on_the_page -->

### Requirement: An imported note SHALL be on the paper for new notes

A note made from a PDF SHALL start on the same paper as a new note: grid on
the website, and the "Paper for new notes" setting in the Obsidian plugin
(importing into the open note and the bulk import in the settings). The
paper is saved in the note's `paper` field, so changing the setting later
leaves imported notes as they are. Before this, imported notes were on plain
paper. No data format changes: `paper` keeps its values and meaning, and the
reader only writes a different one of them.

#### Scenario: The reader's paper
- **GIVEN** a PDF with ink
- **WHEN** it is read as a note per page or as one note
- **THEN** each note is on grid paper, or on the paper the app names (grid, dots, lines or plain), and keeps it when saved and opened again; a name that is not a paper gives grid
<!-- test: pdf_notes_start_on_the_paper_for_new_notes -->

#### Scenario: On the website
- **GIVEN** a two page handwritten PDF
- **WHEN** it is imported on the website
- **THEN** each page's note is on grid paper
<!-- test-js: apps/web/tests/mirror-notes-app.test.mjs :: importing a PDF: each page becomes a note, and is mirrored, not sent as samples -->

#### Scenario: In Obsidian
- **GIVEN** "Paper for new notes" left alone, or set to dots or lines
- **WHEN** a PDF is imported into the open note, or PDFs are dropped on the settings' drop zone
- **THEN** the note is saved on grid, or on the paper the setting chose when the PDF was read
<!-- test-js: apps/obsidian/tests/host.test.mjs :: bug: a PDF imported into a vault note is saved into that file, and is there when the note is opened again -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: a PDF's pages are imported one below another into a note made about a page, which keeps its link; a note with writing is never replaced -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: PDFs dropped on the settings' drop zone become notes at the vault root that open with their handwriting -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bulk PDF import: a PDF the reader hangs or crashes on is given up, and the reader is started afresh -->

### Requirement: The app SHALL import a PDF as one note per page

#### Scenario: Importing from the menu or Open
- **GIVEN** a two page handwritten PDF
- **WHEN** it is imported with "Import PDF (GoodNotes)…" or Open
- **THEN** each page becomes its own note, named `<file> (page N)`
<!-- test-js: apps/web/tests/mirror-notes-app.test.mjs :: importing a PDF: each page becomes a note, and is mirrored, not sent as samples -->

#### Scenario: Saved, and still there after opening another note
- **GIVEN** a two page handwritten PDF imported on the website
- **WHEN** another note is opened, then each imported page, and again after the app is reloaded
- **THEN** each page opens with its strokes
<!-- test-js: apps/web/tests/collect.test.mjs :: bug: an imported PDF is saved, and is still there after opening another note and coming back -->

### Requirement: In Obsidian a PDF SHALL be imported into the open note

Inside a host (the Obsidian plugin) the open note is the vault file, the only
note the app may write. Importing SHALL put every page of the PDF that has
ink or pictures into that file, one below another in page order with a gap
of 40 page units, and save it, keeping the file's name and the note's links
and tags. Each page keeps its own readings, times run on from page to page,
and every stroke id is distinct. A note that already has writing or pictures
SHALL NOT be replaced. Before this, the import was saved under a new note id
that the host never writes, so it was lost when another note was opened (a
bug). The stacked note is an ordinary note: no data format changes.

#### Scenario: Importing into a new vault note
- **GIVEN** an empty `.bedrock` note open in Obsidian
- **WHEN** a two page PDF is imported, another note is opened, and the first is opened again
- **THEN** both pages' strokes are in the file and on the canvas, and the note keeps its file's name
<!-- test-js: apps/obsidian/tests/host.test.mjs :: bug: a PDF imported into a vault note is saved into that file, and is there when the note is opened again -->

#### Scenario: Pages one below another, in a note made about a page; a note with writing
- **GIVEN** a note made with "New handwritten note linking here", and a two page PDF
- **WHEN** the PDF is imported
- **THEN** page 2 sits below page 1, and the note keeps its link
- **AND** importing into a note that already has writing leaves the note as it was and says so
<!-- test-js: apps/obsidian/tests/host.test.mjs :: a PDF's pages are imported one below another into a note made about a page, which keeps its link; a note with writing is never replaced -->

#### Scenario: Stacking pages in the reader
- **GIVEN** a PDF of a page with ink, an empty page and another page with ink
- **WHEN** it is read as one note
- **THEN** the empty page is left out, the second page with ink sits a page height and the gap below the first, ids are distinct, times rise, each page keeps its readings, a warning is said once, and the note saves and opens again unchanged
<!-- test: pdf_pages_can_be_stacked_in_one_note -->

### Requirement: Imported pages SHALL be mirrored like any note

Since consent version 4 an imported page is a note like any other: with
"Mirror my notes" on, its handwriting is mirrored whole (the
`note-mirrors` spec), and no sample is sent. (Before, every word was sent
as a sample with the PDF's reading as `model_reading`.)

#### Scenario: Mirroring on
- **GIVEN** "Mirror my notes" is on
- **WHEN** a PDF is imported
- **THEN** each page's note is mirrored with all its handwriting, and nothing is sent as a sample
<!-- test-js: apps/web/tests/mirror-notes-app.test.mjs :: importing a PDF: each page becomes a note, and is mirrored, not sent as samples -->

#### Scenario: Saving not set up
- **GIVEN** saving is not set up
- **WHEN** a PDF is imported
- **THEN** the notes are made and nothing is queued or sent
<!-- test-js: apps/web/tests/collect.test.mjs :: importing a PDF without saving set up keeps it on the device -->

#### Scenario: Consent given to the older consent text
- **GIVEN** consent was given to consent text version 1, which did not mention imported PDFs
- **WHEN** the training page or the app checks whether saving is set up
- **THEN** saving is off until the writer agrees to the current text (version 2)
<!-- test-js: apps/web/tests/collect.test.mjs :: consent given to an older consent text is asked for again -->

### Requirement: Words SHALL be laid out for the note that is open

#### Scenario: Switching to a note with the same revision
- **GIVEN** two notes with the same revision number
- **WHEN** one is opened after the other
- **THEN** the words are those of the note now open
<!-- test: another_note_with_the_same_revision_is_laid_out_afresh (regression) -->

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

### Requirement: Strokes drawn as round pieces SHALL keep their line and widths

Pen apps draw a stroke as one fill of short overlapping pieces: GoodNotes
with flat ends, Apple Notes with round ends and a round dab at each pen
sample, each piece's outline starting anywhere. Each stroke SHALL follow
the middle of its pieces without crossing from side to side, SHALL be
drawn as wide as the PDF draws it at each point, and SHALL NOT be thinned
by taper or speed or smoothed as if its points were screen pixels.

#### Scenario: An Apple Notes stroke (regression)
- **GIVEN** a stroke drawn as round-ended pieces with dabs, thin at its ends and wider in the middle
- **WHEN** it is imported
- **THEN** every point lies on the pen's line, the stroke runs from end to end, the brush is as wide as the widest point and the ends are drawn narrow, with no taper or speed thinning and exact-point smoothing
<!-- test: pdf_strokes_drawn_as_round_pieces_keep_their_line_and_widths -->

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
