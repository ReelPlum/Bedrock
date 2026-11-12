# saving-and-opening Specification

## Purpose
Keeping notes safe on the device and moving them in and out: autosave to
IndexedDB, saving in a background worker, reopening where the writer left
off, opening files and exporting them (including to iCloud Drive through
the Files app, see `docs/icloud.md`). The file format itself is
`note-format`; folders are `library-folders`.

## Data formats

The on-device library is IndexedDB database `bedrock`, version 2:

| Store | Record |
|---|---|
| `notes` (key `id`, index `modified`) | `{ id, title, created, modified, folder, data }`; `data` is the note's `.bedrock` bytes; `folder` is a folder id, or null or missing for the top. |
| `folders` (key `id`, added in version 2) | `{ id, name, parent, created }`; `parent` is a folder id or null. |
| `kv` | Small app state, keyed by name, such as `camera:<note id>` (the view of each note). |

A record without `folder` (written before version 2) is a note at the top.

## Requirements

### Requirement: Notes SHALL save on the device by themselves and reopen where the writer left off

#### Scenario: Autosave and reopen
- **GIVEN** a note with a title and strokes
- **WHEN** the page is reloaded
- **THEN** the same note reopens with its strokes, title and view
<!-- test-js: apps/web/tests/app.test.mjs :: notes autosave locally and reopen where you left off -->

#### Scenario: An opened note shows its ink at once
- **GIVEN** saved notes
- **WHEN** one is opened
- **THEN** its ink is drawn straight away, without touching the canvas
<!-- test-js: apps/web/tests/app.test.mjs :: an opened note shows its ink straight away, without touching the canvas -->

### Requirement: Saving SHALL happen in the background and match the note exactly

The save worker keeps a mirror of the note from the change feed and writes
the `.bedrock` file itself, so the main thread never serialises the note.

#### Scenario: Background save
- **GIVEN** a large note being edited
- **WHEN** it is saved
- **THEN** the worker writes it from its mirror, the saved file holds exactly the strokes on screen, and the main thread is not held up
<!-- test: stays_identical_through_draws_erases_undo_and_redo -->
<!-- test: duplicate_or_clashing_strokes_are_rejected -->
<!-- test: hash_notices_a_difference -->
<!-- test: bad_input_is_an_error_not_a_panic -->
<!-- test-js: apps/web/tests/app.test.mjs :: saving happens in the background and the saved note matches exactly -->

### Requirement: Notes SHALL leave and come back as files without loss

#### Scenario: Export and open again
- **GIVEN** a note
- **WHEN** it is exported as `.bedrock` and opened again
- **THEN** the strokes are identical
<!-- test-js: apps/web/tests/app.test.mjs :: a .bedrock export opens again with identical strokes -->
<!-- test: bedrock_container_roundtrip -->

#### Scenario: A damaged file
- **GIVEN** a damaged note file
- **WHEN** it is opened
- **THEN** what can be read is recovered and the app does not fail
<!-- test: corrupt_entry_is_reported_not_fatal -->
<!-- test: garbage_is_rejected -->
<!-- test: crc_known_value -->
<!-- test-js: apps/web/tests/app.test.mjs :: opening a damaged note recovers what it can instead of failing -->

### Requirement: The library SHALL keep opening records written by earlier versions

#### Scenario: Notes from before folders
- **GIVEN** notes saved by a version without folders (no `folder` field)
- **WHEN** the app opens
- **THEN** they are listed at the top and nothing is lost
<!-- test-js: apps/web/tests/folders.test.mjs :: notes saved before folders existed are kept, at the top -->
