# note-format Specification

## ADDED Requirements

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
