# obsidian-plugin Specification

## Purpose
The Bedrock Obsidian plugin (`apps/obsidian`): opening `.bedrock` files in a
view that runs the web app, keeping an index note per handwritten note so
Obsidian search, links, the graph and backlinks see the handwriting, and
jumping from a search hit or a link to the ink. Sidecars beside notes are
`obsidian-sidecars`.

## Data formats

- **Index note**: Markdown made by `apps/web/src/sidecar.js`, described in
  `docs/note-format.md` ("Markdown sidecar"). With the default index folder
  it is `Bedrock index/<note path without .bedrock>.md`; with no folder, or
  for a sidecar the web app exported, it is `<note path>.md` beside the
  note. Its front matter `bedrock: "<note path>"` names the note.
- **Link to a word**: `[[<note link text>#^<stroke id>]]`, where the stroke id
  is a 16-hex-digit id of a stroke in that word.
- **Plugin data** (Obsidian's `data.json`): `{ ...settings, cameras }`: the settings
  (`index`, `indexFolder`, `newNoteFolder`) and the camera per vault file
  (only the most recent are kept).

## Requirements

### Requirement: The plugin SHALL open .bedrock files and keep them safe

#### Scenario: Registering the view
- **GIVEN** the plugin is enabled
- **WHEN** Obsidian loads it
- **THEN** the `.bedrock` view, commands and settings are registered, and the packed web app is unpacked once per version
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: registers the .bedrock view, commands and settings, and unpacks the web app -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the web app is unpacked once per version -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the plugin packs the current web app, host adapter and WebAssembly included -->

#### Scenario: New notes
- **GIVEN** an open file
- **WHEN** a new note is made
- **THEN** it is an empty `.bedrock` file next to it and never overwrites a file
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: new notes are empty .bedrock files next to the open file, never overwriting one -->

#### Scenario: Saving to the vault file
- **GIVEN** a note open in the view
- **WHEN** the writer draws, the file changes outside, and the view closes
- **THEN** strokes are saved into the file, outside changes reload, closing saves first, and opening never overwrites the file with an empty note
<!-- test-js: apps/obsidian/tests/host.test.mjs :: a new note in the vault: drawn, saved into the file, and indexed for search -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the note reopens from the vault file; outside changes reload; closing the view saves first -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: opening a note never overwrites the file with an empty note -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: the view shows the ink once the canvas is ready, and at once if it already is -->

#### Scenario: Saves and outside changes are told apart
- **GIVEN** the session for an open file
- **WHEN** it saves, a save is still being written, a save fails, or another program changes the file
- **THEN** its own saves are not taken for outside changes, a failed save does not stop later ones, and the index stays current
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: session reads and writes the open file and keeps its index current -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: session tells its own saves from changes made elsewhere -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a save that is still being written is never taken for an outside change -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: one failed save does not stop later saves -->

#### Scenario: Camera per file
- **GIVEN** two notes viewed at different places
- **WHEN** each is reopened
- **THEN** each comes back to its own view
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the camera is remembered per vault file -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: session camera is kept per file; picker and links get the note path -->

#### Scenario: The bridge to the web app
- **GIVEN** the web app running in the view
- **WHEN** messages arrive from it and from other windows
- **THEN** the bridge answers the app and ignores other windows
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bridge answers the app and ignores other windows -->

### Requirement: Every note SHALL have an index note that search and links can use

#### Scenario: Index note contents
- **GIVEN** a `.bedrock` file
- **WHEN** it is indexed
- **THEN** its index note holds the recognised text (Markdown link syntax in handwriting is escaped) and its links, and every word knows the strokes it came from
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: reads stored and deflated entries from a .bedrock archive -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a damaged or empty file gives no entries instead of throwing -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: index note holds the handwriting text and the links -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: handwriting that looks like Markdown links does not become a link -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: every word of the index note knows the strokes it was read from -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: index note paths, with and without an index folder -->

#### Scenario: Keeping index notes current
- **GIVEN** notes created, changed, renamed, deleted or written elsewhere
- **WHEN** the indexer runs
- **THEN** index notes are created, updated only on change, follow renames and deletes, and up-to-date ones are skipped; an empty new note is left alone
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: indexer creates, updates only on change, follows renames and deletes -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: indexer sync indexes notes written elsewhere and skips up-to-date ones -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: at start, an empty (new) note is left alone: nothing to index yet -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: correcting what the recogniser read updates the search index -->

### Requirement: Search hits and links SHALL lead to the ink

#### Scenario: Opening a search hit
- **GIVEN** a search hit in an index note
- **WHEN** it is opened, or the index note is opened some other way
- **THEN** the handwriting opens instead, centred on the words that matched and pointing them out, and the pen still writes
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a search hit in the index note names the ink it was read from -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a view is told which ink to show by a redirected search hit or a link to a word -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: a search result on an index note opens the handwriting at the words that matched -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: an index note opened some other way is swapped for the handwriting, at the cursor -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: a search hit takes the open note to the words that were found and points them out -->

#### Scenario: Links to and from words
- **GIVEN** a word's menu in the view
- **WHEN** a link is made, or a link to the word is copied
- **THEN** the vault note picker opens (not index notes or the note itself) and the link reaches the file, `links.md`, the index note and Obsidian; closing the picker keeps the form; a copied link names a real stroke of the word
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: the note picker lists vault notes, not index notes or the note itself, and gives link text -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: making a link opens the vault note picker, and the link reaches the file, the index and Obsidian -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: closing the picker leaves the link form open, with Browse to try again and the other kinds of link -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the word menu copies a link to the word, for pasting into a vault note -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the app can ask for a link to a word; only real stroke ids are accepted -->
