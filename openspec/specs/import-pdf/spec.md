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

### Requirement: The app SHALL import a PDF as one note per page

#### Scenario: Importing from the menu or Open
- **GIVEN** a two page handwritten PDF
- **WHEN** it is imported with "Import PDF (GoodNotes)…" or Open
- **THEN** each page becomes its own note, named `<file> (page N)`
<!-- test-js: apps/web/tests/collect.test.mjs :: importing a PDF: each page becomes a note, and every line is sent with the PDF's reading -->

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

### Requirement: Imported words SHALL be sent for training only with consent

Importing is the writer's own act, so with saving set up on `/train` every word of an imported page SHALL be sent at once, marked `unchecked`, with the PDF's reading as `model_reading` and `model_engine: "pdf-text"`. The training wire format (`bedrock-training` version 2) SHALL NOT change.

#### Scenario: Saving set up
- **GIVEN** saving is set up on `/train`, and "Send every word" is off
- **WHEN** a PDF is imported
- **THEN** every word is queued and sent once, with the PDF's reading where it has one
<!-- test-js: apps/web/tests/collect.test.mjs :: importing a PDF: each page becomes a note, and every line is sent with the PDF's reading -->

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
