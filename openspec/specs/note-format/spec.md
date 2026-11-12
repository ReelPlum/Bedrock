# note-format Specification

## Purpose
A Bedrock note must outlive the app. The note format is open, documented in `docs/note-format.md` and `docs/note.schema.json`, keeps every raw pen sample, and is read forgivingly so a damaged or newer file still gives back as much ink as possible.

## Requirements

### Requirement: Saving and opening a note SHALL keep every stroke exactly

Bedrock SHALL write `.bedrock` (ZIP), `.svg` and `.json` files that open again to the same strokes, and saving a note that was just opened SHALL produce identical bytes.

#### Scenario: A `.bedrock` file round-trips
- **GIVEN** a note with strokes, recognised text, links and word groups
- **WHEN** it is saved as `.bedrock` and opened again
- **THEN** the archive holds `note.json`, `recognized.json`, `links.md`, `preview.svg` and `README.txt`
- **AND** the opened note has the same strokes and no warnings
<!-- test: bedrock_container_roundtrip -->

#### Scenario: Save, open, save is stable
- **GIVEN** a stroke whose start time has sub-millisecond digits
- **WHEN** the note is saved, opened and saved again
- **THEN** both saved `note.json` texts are identical
<!-- test: save_load_save_is_stable (regression) -->

#### Scenario: Every format opens through one entry point
- **GIVEN** the same note exported as `.svg` and as `.json`
- **WHEN** either file's bytes are opened
- **THEN** the note opens with all its strokes
<!-- test: svg_and_json_files_load_through_load_bytes -->

### Requirement: Recognised text SHALL live apart from ink and SHALL never cost ink

`recognized.json` SHALL be a separate archive entry, and `note.json` SHALL NOT contain recognition results.

#### Scenario: A damaged `recognized.json`
- **GIVEN** a `.bedrock` file with a valid `note.json` and a `recognized.json` that is not valid JSON
- **WHEN** the file is opened
- **THEN** every stroke is loaded
- **AND** the recognition is empty and one warning says why
<!-- test: damaged_recognition_never_loses_ink -->

### Requirement: Readers SHALL recover what they can instead of failing

#### Scenario: Damaged strokes are skipped, not fatal
- **GIVEN** a `note.json` with an incomplete trailing sample, a duplicate stroke id, an unknown brush kind and a negative brush size
- **WHEN** the note is opened
- **THEN** the unknown-brush stroke is skipped and the other three are kept
- **AND** the incomplete sample is dropped, the duplicate id is replaced, the size is made positive
- **AND** four warnings report what was repaired
<!-- test: damaged_strokes_are_skipped_not_fatal -->

#### Scenario: Corrupted bytes never crash the app
- **GIVEN** a saved note in each of the three formats
- **WHEN** bytes are flipped, inserted or the file is truncated at random positions
- **THEN** opening either succeeds with warnings or returns an error, and never panics
<!-- test: corrupted_files_never_panic -->

#### Scenario: A file that is not a note
- **GIVEN** an SVG without a Bedrock note, JSON whose `format` is not `bedrock-note`, broken JSON, or random bytes
- **WHEN** it is opened
- **THEN** an error is returned and no empty note is created
<!-- test: rejects_files_that_are_not_notes -->

#### Scenario: A picture file is missing
- **GIVEN** a `.bedrock` file whose `images` entry names a file that is not in the archive
- **WHEN** it is opened
- **THEN** the note opens, a warning names the missing picture, and a placeholder is shown
<!-- test: a_missing_picture_file_is_reported_and_the_note_still_opens -->

### Requirement: The format SHALL stay forward compatible

#### Scenario: A newer version opens with a warning
- **GIVEN** a `note.json` with `version` 99
- **WHEN** it is opened
- **THEN** it loads, with exactly one warning
<!-- test: newer_version_loads_with_warning -->

#### Scenario: Unknown fields survive a save
- **GIVEN** a `note.json` with a field this version does not know (`layers`)
- **WHEN** it is opened and saved again
- **THEN** the field is written back unchanged
<!-- test: unknown_fields_are_preserved -->

#### Scenario: Channels in any order, some missing
- **GIVEN** a stroke whose `channels` are `["t","y","x"]`
- **WHEN** it is opened
- **THEN** positions and times are read by name, and pressure falls back to 0.5
<!-- test: custom_channel_order_and_missing_channels -->

### Requirement: Word groups SHALL be saved only while all their strokes exist

#### Scenario: Erasing a grouped stroke drops the group
- **GIVEN** two strokes the writer grouped into one word
- **WHEN** the note is saved, the group is kept; when one stroke is erased and the note is saved again
- **THEN** the saved note has no `groups` entry for it
<!-- test: word_groups_are_saved_while_their_strokes_exist -->

### Requirement: Note files written by every earlier Bedrock SHALL keep opening

A note file is a promise that outlives the app, so a change to Bedrock SHALL
NOT stop an older file opening with all of its content. Files written by
earlier versions are kept, never regenerated, in
`crates/bedrock-core/tests/fixtures/old-formats/`, and each format change adds
one written by the version just before it (see the `data-format-changes` spec).

#### Scenario: The first note format
- **GIVEN** a `.bedrock`, `.json` and `.svg` file written by the first Bedrock (commit dc1b86b)
- **WHEN** each is opened, and saved and opened again
- **THEN** it opens without warnings, with every stroke, every raw sample, each brush and device, and the recognised text
<!-- test: the_first_note_format_still_opens -->

#### Scenario: Notes from before pictures
- **GIVEN** files written before pictures existed, with links, a word group, a maths override, a dashed line and a stabiliser
- **WHEN** each is opened, and saved and opened again
- **THEN** all of those come back as they were written
<!-- test: notes_from_before_pictures_still_open -->

#### Scenario: Notes with pictures and text boxes
- **GIVEN** files with a picture, a text box and per-stroke pen tuning
- **WHEN** each is opened
- **THEN** the picture and the text box are where they were, the pen tuning is kept, and a `.bedrock` file gives back the picture's own bytes
<!-- test: notes_with_pictures_and_text_boxes_still_open -->

### Requirement: Pictures and text boxes SHALL be stored as plain files and plain text

A picture SHALL be stored in the `.bedrock` archive as the original image
file under `images/`, named by its content, and placed by `images` in
`note.json`; a text box SHALL be its text in `texts`. A file no picture uses
SHALL NOT be saved.

#### Scenario: A picture round-trips as a plain image file
- **GIVEN** a note with a PNG picture and an unused picture file
- **WHEN** it is saved as `.bedrock` and opened again
- **THEN** the archive holds the PNG unchanged and not the unused file, and the picture is at the same place and size
- **AND** the `.svg` export embeds the picture and `preview.svg` refers to the file
<!-- test: pictures_round_trip_in_a_bedrock_file_as_plain_image_files -->

#### Scenario: Text boxes
- **GIVEN** a note with a two-line text box holding `<`
- **WHEN** it is saved and opened again
- **THEN** `texts` holds the text, `images` does not, and the `.svg` export shows it as escaped SVG text
<!-- test: text_boxes_round_trip_and_export_as_svg_text -->

### Requirement: Positions SHALL survive saving at full zoom precision

#### Scenario: Fine positions
- **GIVEN** samples a hundredth of a unit apart at the far edge of the page
- **WHEN** the note is saved and opened again
- **THEN** every sample is back within a fraction of a screen pixel at the highest zoom
<!-- test: positions_survive_saving_at_full_zoom_precision -->

### Requirement: The SVG export SHALL be a viewable picture that opens again

#### Scenario: SVG export
- **GIVEN** a note with highlighter and pen strokes and text holding `]]>`
- **WHEN** it is exported as `.svg`
- **THEN** the SVG is a valid picture with highlighters drawn first, the embedded note is escaped, and opening the SVG gives the same strokes
<!-- test: svg_roundtrip_and_is_viewable -->
<!-- test: highlighter_paths_come_first -->
<!-- test: cdata_terminator_in_text_is_escaped -->
<!-- test: number_formatting -->
