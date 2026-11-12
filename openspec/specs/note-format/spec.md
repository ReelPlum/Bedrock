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
