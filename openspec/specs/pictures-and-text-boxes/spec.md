# pictures-and-text-boxes Specification

## Purpose
Putting pictures and typed text on the page: inserting and pasting them,
moving, resizing and deleting them. How they are stored is in `note-format`
(plain image files under `images/`, and `texts` in `note.json`).

## Requirements

### Requirement: A picture SHALL be inserted under the ink and saved as a plain file

#### Scenario: Inserting a picture
- **GIVEN** an open note
- **WHEN** a picture is inserted
- **THEN** it is placed in the middle of the view, under the ink, never larger than its pixels or the view, and is selected so it can be moved at once
- **AND** it is saved as a plain file in the note and shows again after a reload
<!-- test: a_picture_is_never_inserted_larger_than_its_pixels_or_the_view -->
<!-- test-js: apps/web/tests/app.test.mjs :: pictures: inserted in the middle under the ink, saved as a plain file in the note, and back after a reload -->

#### Scenario: Resize, move and delete
- **GIVEN** a selected picture
- **WHEN** its corner is dragged, it is dragged, and it is deleted
- **THEN** it resizes keeping its shape, moves, and is deleted; each undo brings back one step
<!-- test: pictures_insert_select_move_resize_delete_undo -->
<!-- test: pictures_follow_through_meta_and_assets -->
<!-- test-js: apps/web/tests/app.test.mjs :: pictures: drag the corner to resize, drag to move, delete; undo brings each back -->

#### Scenario: A missing picture file
- **GIVEN** a note whose picture file is missing
- **WHEN** it is opened
- **THEN** it opens with a warning and a placeholder
<!-- test: a_missing_picture_file_is_reported_and_the_note_still_opens -->

#### Scenario: Pictures in an SVG export
- **GIVEN** a note with pictures exported as `.svg`
- **WHEN** the SVG is opened in Bedrock
- **THEN** the pictures show, and saving keeps their files
<!-- test: an_svg_export_gives_its_pictures_back_when_opened -->

### Requirement: Paste SHALL work as the system does

#### Scenario: Pasting a picture or text
- **GIVEN** a picture or text on the clipboard
- **WHEN** it is pasted onto the page
- **THEN** a picture pastes as a picture, text pastes as a selected text box with its lines, and text fields keep their own paste
<!-- test: text_boxes_round_trip_and_export_as_svg_text -->
<!-- test-js: apps/web/tests/app.test.mjs :: paste works as the system does: a picture pastes a picture, text pastes a text box; text fields keep their paste -->
