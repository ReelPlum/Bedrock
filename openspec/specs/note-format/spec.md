# note-format Specification

## Purpose
A Bedrock note must outlive the app. The note format is open, documented in `docs/note-format.md` and `docs/note.schema.json`, keeps every raw pen sample, and is read forgivingly so a damaged or newer file still gives back as much ink as possible.

## Requirements

### Requirement: Saving and opening a note SHALL keep every stroke exactly

Bedrock SHALL write `.bedrock` (ZIP), `.svg` and `.json` files that open again to the same strokes, and saving a note that was just opened SHALL produce identical bytes.

#### Scenario: A `.bedrock` file round-trips
- **GIVEN** a note with strokes, recognised text, links and word groups
- **WHEN** it is saved as `.bedrock` and opened again
- **THEN** the archive holds `note.json`, `points.bin`, `recognized.json`, `links.md`, `preview.svg` and `README.txt`
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

### Requirement: Pen samples in a `.bedrock` SHALL be stored in `points.bin`, bit for bit

Inside a `.bedrock`, `note.json` is version 2 with `"pointsFile": "points.bin"`
and the samples of its strokes are in `points.bin` (`docs/note-format.md`):
each value as a whole number of its channel's step, the same rounding
`note.json` uses, so nothing is rounded further. The `.json` and `.svg`
exports stay version 1 with every sample in the JSON.

#### Scenario: Samples come back bit for bit
- **GIVEN** a note with strokes of every brush
- **WHEN** it is saved as `.bedrock` and opened again
- **THEN** `note.json` is version 2, its strokes have no `points`, `points.bin` is there, and the opened note writes exactly the JSON it was saved from
<!-- test: samples_are_kept_in_points_bin_and_come_back_bit_for_bit -->
<!-- test: values_come_back_bit_for_bit -->
<!-- test: any_rounded_values_round_trip -->

#### Scenario: A value the binary form cannot hold
- **GIVEN** a stroke with a value that is not a whole number of steps, or too large to hold exactly
- **WHEN** the note is saved
- **THEN** that stroke keeps its samples in `note.json` and the others go to `points.bin`, and the note opens unchanged
<!-- test: a_stroke_points_bin_cannot_hold_exactly_stays_in_note_json -->
<!-- test: values_that_are_not_exact_steps_are_refused -->

#### Scenario: A damaged or missing `points.bin`
- **GIVEN** a `.bedrock` whose `points.bin` is cut short, or missing
- **WHEN** it is opened
- **THEN** it opens with a warning naming `points.bin`, never a crash
<!-- test: a_damaged_points_bin_is_reported_and_never_panics -->
<!-- test: damaged_files_are_errors_not_panics -->

### Requirement: The preview SHALL be light, and a file that leaves the device SHALL be compressed harder

`preview.svg` is a picture made from the ink; its outline points are kept
to 0.1 units (the full SVG export keeps 0.01). Save to Files and the library
export deflate at level 6 instead of autosave's 2; entry contents are the
same bytes.

#### Scenario: Preview outlines
- **GIVEN** a note
- **WHEN** it is saved as `.bedrock`
- **THEN** every number in the preview's outlines has at most one decimal
<!-- test: the_preview_draws_outlines_to_a_tenth_of_a_unit -->

#### Scenario: Compressed for sharing
- **GIVEN** a note, or a saved `.bedrock`
- **WHEN** it is written for sharing, or repacked
- **THEN** it is smaller and holds exactly the same entries; an archive that cannot be repacked without loss is left as it is
<!-- test: a_note_for_sharing_holds_the_same_entries_and_is_smaller -->
<!-- test: repacking_keeps_every_entry_byte_for_byte_and_is_smaller -->
<!-- test: repacking_never_drops_what_it_cannot_read_back -->
<!-- test: notes_inside_a_library_export_are_stored_not_compressed_again -->

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
- **THEN** the picture and the text box are where they were, the pen tuning is kept, and the `.bedrock` and `.svg` files give back the picture's own bytes
<!-- test: notes_with_pictures_and_text_boxes_still_open -->

#### Scenario: Notes from before note links and tags
- **GIVEN** files written just before note links and tags existed (commit 8048376), with a word linked to a PDF page, pictures and text boxes
- **WHEN** each is opened, and saved and opened again
- **THEN** everything comes back as it was written, with no note links, no tags and nothing taken for an unknown field
<!-- test: notes_from_before_note_links_and_tags_still_open -->

#### Scenario: Notes from before `points.bin`
- **GIVEN** a `.bedrock` written by commit 90c0a6c, with every sample in `note.json`, and every older fixture
- **WHEN** each is opened, and saved again (now with `points.bin`) and opened
- **THEN** it opens without warnings with every sample, and comes back writing exactly the same JSON
<!-- test: notes_from_before_points_bin_still_open_and_resave_bit_for_bit -->
<!-- test: every_old_note_resaves_with_points_bin_bit_for_bit -->

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

#### Scenario: An SVG export gives its pictures back (regression)
- **GIVEN** a note with pictures exported as `.svg`, which embeds each picture's file
- **WHEN** the SVG is opened and saved as `.bedrock`
- **THEN** the picture files come back from the SVG unchanged and are saved; a damaged embedded picture is left out with a warning and the note still opens
<!-- test: an_svg_export_gives_its_pictures_back_when_opened -->

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

### Requirement: A note SHALL carry links and tags of its own, not tied to ink

`noteLinks` and `tags` in `note.json` SHALL be saved whatever ink the note
has, and `links.md` SHALL list the note links before the words' links.

#### Scenario: Note links and tags with no ink
- **GIVEN** a note with no strokes, two note links and tags typed as `#Exam prep` and `physics/forces`
- **WHEN** it is saved as `.bedrock`, `.json` and `.svg` and opened again
- **THEN** both links and the tags `Exam-prep` and `physics/forces` come back with no warnings, and `links.md` lists the links
- **AND** a blank or repeated link, a tag already there in another case and a tag of only digits are not added
<!-- test: note_links_and_tags_are_saved_without_any_ink -->
<!-- test: a_note_with_everything_matches_the_schema -->

#### Scenario: Note links come first in links.md
- **GIVEN** a note link and a linked word
- **WHEN** `links.md` is written
- **THEN** the note link is listed first
<!-- test: note_links_come_before_word_links_in_links_md -->

#### Scenario: Damaged note links and tags never cost ink
- **GIVEN** a `note.json` with a repeated and a blank note link, a tag with a space, a repeated tag, or lists that are not lists
- **WHEN** it is opened
- **THEN** every stroke loads, the good links and tags are kept (the space becomes `-`), and a warning says what was skipped
<!-- test: damaged_note_links_and_tags_never_cost_ink -->

#### Scenario: The background save keeps them
- **GIVEN** a note saved by the background save worker, which gets the note's fields without its strokes
- **WHEN** note links and tags are added
- **THEN** the saved note has them
<!-- test: stays_identical_through_draws_erases_undo_and_redo -->

### Requirement: Saved notes SHALL match the published schema

Every `note.json` Bedrock writes SHALL be valid against
`docs/note.schema.json`, so other tools can rely on the documented format.

#### Scenario: A note with everything in it
- **GIVEN** a note with strokes of every brush, pictures, text boxes, word groups and recognised text
- **WHEN** it is saved
- **THEN** its `note.json` matches the schema
<!-- test: a_note_with_everything_matches_the_schema -->

#### Scenario: Notes written by earlier versions
- **GIVEN** the note files kept from earlier versions of Bedrock
- **WHEN** they are checked against the schema
- **THEN** each one matches it
<!-- test: notes_written_by_earlier_versions_match_the_schema -->

#### Scenario: Any note
- **GIVEN** randomly made notes
- **WHEN** each is saved and opened again
- **THEN** it matches the schema and opens with the same strokes
<!-- test: any_note_matches_the_schema_and_opens_again -->

### Requirement: The ZIP container SHALL stay the same when its writer changes

#### Scenario: Same note, same file
- **GIVEN** the same note saved twice
- **WHEN** the two files are compared
- **THEN** they are byte for byte the same
<!-- test: the_same_files_give_the_same_bytes -->

#### Scenario: Pictures stored, text compressed
- **GIVEN** a note with a picture
- **WHEN** it is saved
- **THEN** the picture is stored as it is and the text entries are compressed
<!-- test: pictures_are_stored_and_text_is_deflated -->

#### Scenario: Folder entries from other tools
- **GIVEN** a `.bedrock` file repacked by another tool that adds folder entries
- **WHEN** it is opened
- **THEN** the folders are skipped and the note opens
<!-- test: a_folder_entry_is_kept_for_other_tools_and_skipped_when_reading -->

#### Scenario: Files from the earlier writer
- **GIVEN** a `.bedrock` file written by Bedrock's earlier hand-written ZIP writer
- **WHEN** it is opened
- **THEN** every entry reads back the same
<!-- test: archives_from_the_earlier_writer_still_open -->

### Requirement: An SVG export SHALL still open after another program re-saves it

A drawing program that re-saves a Bedrock SVG keeps its content but may
change how it is written. The note and its pictures SHALL still come back.

#### Scenario: Re-saved by a drawing program
- **GIVEN** an SVG export whose metadata uses other quotes and line breaks, whose note JSON is written as escaped text instead of CDATA, and whose pictures use `xlink:href` with their attributes in another order
- **WHEN** it is opened
- **THEN** the note opens with its title, strokes and pictures, and no warnings
<!-- test: an_svg_resaved_by_another_tool_still_opens -->

#### Scenario: An export cut short
- **GIVEN** an SVG export cut off after the note data, so it is not well formed XML
- **WHEN** it is opened
- **THEN** the note still opens from the data at the top of the file
<!-- test: an_svg_resaved_by_another_tool_still_opens -->

## Open source used

[leb128](https://crates.io/crates/leb128) 0.2 (MIT or Apache-2.0) reads and
writes the integers of `points.bin`: the LEB128 encoding of WebAssembly and
DWARF, so the format names a standard any language can read. gimli-rs
organisation, since 2016, about 90 million downloads, released June 2026.
Pcodec, Protocol Buffers, CBOR and zstd inside the ZIP were considered; the
reasons are in `openspec/changes/archive/2026-11-25-cut-bandwidth-and-storage/proposal.md`.

| | zip | crc32fast | base64 | jsonschema (tests) | proptest (tests) |
|---|---|---|---|---|---|
| Version | [9.5](https://crates.io/crates/zip), only `deflate-flate2` | [1](https://crates.io/crates/crc32fast) | [0.23](https://crates.io/crates/base64) | [0.61](https://crates.io/crates/jsonschema), default features off | [1](https://crates.io/crates/proptest), `std` only |
| Used for | Writing and reading the `.bedrock` ZIP container. | CRC-32 for picture file names. | Base64 of stroke channels in `note.json`. | Checking saved notes against `docs/note.schema.json`. | Random notes for the schema test, random damage for the never-crash test. |
| Why this one | Writes exactly what our writer wrote (fixed 1980 timestamp, pictures stored, text deflated) and reads every ZIP we have met; reports a bad entry without losing the others. | The CRC used by `zip` and `flate2` already. | Standard and no-padding alphabets, exactly as the format needs. | Full JSON Schema support; the schema is the published format, so testing against it catches drift between code and documents. | Shrinks a failing case to the smallest one, so a crash comes with a readable example. |
| Why it is mature | Since 2014, about 340 million downloads, maintained by the zip-rs organisation, released November 2026. | Since 2018, about 860 million downloads, a dependency of `flate2` and `zip`. | Since 2015, about 2 billion downloads, released August 2026. | Since 2020, about 120 million downloads, released November 2026. | Since 2017, about 240 million downloads, maintained by the proptest-rs organisation. |
| Licence | MIT: commercial use allowed. | MIT or Apache-2.0. | MIT or Apache-2.0. | MIT. | MIT or Apache-2.0. |
| Considered | `rc-zip` (read only), `async_zip` (async, not needed); keeping our own (worked, but only our tests). | `crc` (slower, same result). | Keeping our own (fine, but untested on odd input). | `valico`, `boon` (less used). | `quickcheck` (no shrinking of structured values as good). |
| Not Rust | No. | No. | No. | No. | No. |

The `zip` crate adds about 270 KB to the WebAssembly build before
compression.

| | roxmltree |
|---|---|
| Version | [0.21](https://crates.io/crates/roxmltree) |
| Used for | Reading SVG files back: the note JSON in `<metadata id="bedrock-note">` and the pictures embedded in `<image>`. |
| Why this one | A small, read-only XML parser that gives the whole document as a tree, which is all opening an SVG needs, and it decodes CDATA, escaped text and namespaced attributes the way any XML reader would. When a file is not well formed XML (cut short), Bedrock falls back to its earlier plain text search, so nothing that opened before stops opening. |
| Why it is mature | Since 2018, about 105 million downloads, released October 2026; used by `resvg`/`usvg`, the most used SVG renderer in Rust. One main maintainer (the author of resvg), trusted because of that wide use. |
| Licence | MIT or Apache-2.0: commercial use allowed. |
| Considered | `quick-xml` (very widely used, but a streaming reader that needs more code for the same lookups; a good choice if the SVG is ever read in one pass for speed); `xml-rs` (slower, less maintained). |
| Not Rust | No. |

Writing the SVG stays Bedrock's own: it is a fixed template with a
twelve line escape function, and the exact output is part of the format.

| | serde, serde_json |
|---|---|
| Version | [serde](https://crates.io/crates/serde) 1, [serde_json](https://crates.io/crates/serde_json) 1 (with `float_roundtrip`) |
| Used for | Reading and writing `note.json`, `recognized.json` and every other JSON in a note. |
| Why this one | The standard for JSON in Rust. `float_roundtrip` keeps every number exactly as written. |
| Licence | MIT or Apache-2.0 |
