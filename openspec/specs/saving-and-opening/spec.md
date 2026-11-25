# saving-and-opening Specification

## Purpose
Keeping notes safe on the device and moving them in and out: autosave to
IndexedDB, saving in a background worker, reopening where the writer left
off, opening files and exporting them (including to iCloud Drive through
the Files app, see `docs/icloud.md`). The file format itself is
`note-format`; folders are `library-folders`.

## Data formats

The on-device library is IndexedDB database `bedrock`, version 3:

| Store | Record |
|---|---|
| `notes` (key `id`, index `modified`) | `{ id, title, created, modified, folder, data }`; `data` is the note's `.bedrock` bytes; `folder` is a folder id, or null or missing for the top. |
| `folders` (key `id`, added in version 2) | `{ id, name, parent, created }`; `parent` is a folder id or null. |
| `meta` (key `id`, added in version 3) | `{ id, title, created, modified, folder }` of each note in `notes`, written with it in one transaction, so the list never reads note files. |
| `kv` | Small app state, keyed by name, such as `camera:<note id>` (the view of each note). |

A record without `folder` (written before version 2) is a note at the top.
Opening a version 2 database copies every note's metadata into `meta`.

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
After each save the page and the worker compare a fingerprint of their
copies (`content_hash`): a BLAKE3 hash of every stroke's id and sample
count, in order, and of the pictures. It does not read the samples, which
is sound because a stroke never changes under its id (moving, recolouring
and erasing give new ids). On a mismatch the page sends the whole note
again. The fingerprint is never stored, so it is not a data format.

#### Scenario: Background save
- **GIVEN** a large note being edited
- **WHEN** it is saved
- **THEN** the worker writes it from its mirror, the saved file holds exactly the strokes on screen, and the main thread is not held up
<!-- test: stays_identical_through_draws_erases_undo_and_redo -->
<!-- test: duplicate_or_clashing_strokes_are_rejected -->
<!-- test: hash_notices_a_difference -->
<!-- test: hash_notices_a_moved_or_recoloured_stroke -->
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

### Requirement: The notes list SHALL read only metadata, and databases from before SHALL keep working

#### Scenario: A version 2 database
- **GIVEN** a database written before the `meta` store, with notes in a folder and at the top
- **WHEN** the app opens it, lists, moves and deletes
- **THEN** every note is listed with its metadata, its record and bytes are untouched, and moving and deleting keep the list and the notes in step
<!-- test-js: apps/web/tests/folders.test.mjs :: notes saved before the metadata store (database version 2) are listed, moved and deleted with their files untouched -->

### Requirement: The app SHALL ask the browser to keep its storage

After the first save of a page load (never at start, where Firefox would
show a prompt), the app asks for persistent storage once, so the notes and
the cached recognition models are not cleared under storage pressure or by
Safari's seven-day rule.

#### Scenario: Persistent storage
- **GIVEN** a browser that has, or has not, kept storage already, or has no storage manager
- **WHEN** the app asks
- **THEN** it asks only when not kept yet, and never throws
<!-- test-js: apps/web/tests/storage.test.mjs :: the browser is asked to keep storage, once kept it is not asked again, and nothing throws -->

### Requirement: Notes that leave the device SHALL be compressed harder, without changing them

#### Scenario: The library export
- **GIVEN** notes in folders
- **WHEN** the library is exported
- **THEN** each note inside is stored as a whole `.bedrock` (with `points.bin`), not deflated a second time
<!-- test-js: apps/web/tests/folders.test.mjs :: export: the library becomes folders of notes, each with its Obsidian sidecar -->

### Requirement: The save worker SHALL reuse the page's compiled WebAssembly

#### Scenario: One compile for the page and its save worker
- **GIVEN** the app starting
- **WHEN** it compiles its WebAssembly and starts the save worker
- **THEN** the WebAssembly is fetched and compiled once, the worker is sent the compiled module first and saves with it, and a worker sent no module compiles its own
<!-- test-js: apps/web/tests/app.test.mjs :: the WebAssembly is fetched and compiled once; the save worker gets the module the page compiled -->

### Requirement: A pen SHALL write on the paper while a note opens

While the app starts and while a note opens, the canvas SHALL be covered by
the paper with a single-colour pen (the ink colour) writing a loopy line,
hopping at its end and starting again, and "Opening note…" for screen
readers. It SHALL show from the first paint, before the scripts and
WebAssembly have loaded, wait a moment before fading in so a quick open
shows nothing, and go once the note is open. The nib SHALL stay on the end
of the line as it is drawn. With reduced motion nothing SHALL move; the
short wait before it shows SHALL still apply.

#### Scenario: Starting up
- **GIVEN** the app's WebAssembly is slow to arrive
- **WHEN** the page loads
- **THEN** the pen covers the canvas and writes, with "Opening note…" as a status; once the note is open it goes
<!-- test-js: apps/web/tests/note-loading.test.mjs :: the pen writes while the app starts, and goes once the note is open -->

#### Scenario: Opening a note that takes a moment
- **GIVEN** a saved note that takes 700 ms to read
- **WHEN** it is opened
- **THEN** the pen shows while it opens and goes at once when it has, so the ink shows straight away; it only fades in after a moment, so a note that opens at once shows nothing
<!-- test-js: apps/web/tests/note-loading.test.mjs :: a note that takes a moment to open shows the pen while it opens, and its ink as soon as it has; a quick one shows nothing -->

#### Scenario: The nib stays on the line
- **GIVEN** the pen is writing
- **WHEN** it is looked at any moment while it writes
- **THEN** the nib is on the end of the drawn line
<!-- test-js: apps/web/tests/note-loading.test.mjs :: the nib stays on the end of the line while the pen writes -->

#### Scenario: Reduced motion
- **GIVEN** the device asks for reduced motion
- **WHEN** a note opens
- **THEN** after the same short wait as with motion (so a quick open shows nothing and nothing flickers), the finished line is shown at once, without a fade, with the pen resting at its end, and nothing moves
<!-- test-js: apps/web/tests/note-loading.test.mjs :: with reduced motion the pen rests at the end of a finished line, still -->

#### Scenario: In Obsidian
- **GIVEN** the Obsidian plugin
- **WHEN** a note opens in a view, or a change made elsewhere reloads it
- **THEN** the pen is in the view's page from the start and shows while the note is reloaded
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the pen writes while a note opens in Obsidian, and while an outside change reloads it -->

## Open source used

[blake3](https://crates.io/crates/blake3) 1.8 (CC0-1.0 or Apache-2.0)
computes the save fingerprint (`crates/bedrock-core/src/mirror.rs`), as
`docs/security.md` asks for every hash. It replaced a hand-written FNV
hash. Chosen because it is the official implementation by the BLAKE3
authors, is pure Rust on WebAssembly (no C compiler needed there), and
hashes the 1.6 MB of ids of a 100 000-stroke note in about 2 ms. Mature:
maintained by the BLAKE3 authors since 2020, one of the most downloaded
hashing crates, and tested against the official BLAKE3 test vectors. Considered: `twox-hash` and
`ahash` (fast, but not BLAKE3, which the security rules name), keeping FNV
(hand-written, which the rules forbid).
