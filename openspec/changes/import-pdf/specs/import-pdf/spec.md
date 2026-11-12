# Import handwritten PDFs

## ADDED Requirements

### Requirement: PDF ink becomes note strokes

Each page of a PDF that has handwriting becomes a note whose strokes follow
the pen paths in the order they were written.

#### Scenario: A GoodNotes-style page

- GIVEN a PDF page where each stroke is a filled outline made of pieces
- WHEN it is imported
- THEN each outline becomes one stroke along its centre line, with its colour and width, in page order, with increasing times

<!-- test: pdf_strokes_become_note_strokes_in_writing_order -->

#### Scenario: Stroked paths and form XObjects

- GIVEN a PDF whose ink is stroked lines, some inside a form XObject
- WHEN it is imported
- THEN each line becomes a stroke, placed by the form's matrix

<!-- test: pdf_stroked_paths_and_form_xobjects_are_read_too -->

#### Scenario: Damaged files

- GIVEN a file that is not a PDF, or a cut or damaged one
- WHEN it is imported
- THEN it is refused or read as far as it goes, never crashing

<!-- test: pdf_damaged_or_not_a_pdf_is_refused_without_panicking -->

### Requirement: The PDF's reading is kept

Hidden text over the handwriting becomes the reading of the word under it.

#### Scenario: Text layer far off the page

- GIVEN invisible text placed with a large offset from the ink, as GoodNotes does
- WHEN the page is imported
- THEN each piece of text is matched to the word it covers, with engine `pdf-text`

<!-- test: pdf_hidden_text_becomes_the_words_reading -->

### Requirement: Words are laid out for the open note

#### Scenario: Switching to a note with the same revision

- GIVEN two notes with the same revision number
- WHEN one is opened after the other
- THEN the words are those of the note now open

<!-- test: another_note_with_the_same_revision_is_laid_out_afresh -->
