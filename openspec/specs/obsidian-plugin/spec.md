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
- **Note links and tags**: `noteLinks` and `tags` in `note.json`
  (`note-format`); the index note's front matter lists the tags.
- **Plugin data** (Obsidian's `data.json`): `{ ...settings, cameras }`: the settings
  (`index`, `indexFolder`, `newNoteFolder`) and the camera per vault file
  (only the most recent are kept).

## Requirements

### Requirement: The plugin SHALL open .bedrock files and keep them safe

#### Scenario: Registering the view
- **GIVEN** the plugin is enabled
- **WHEN** Obsidian loads it
- **THEN** the `.bedrock` view, commands and settings are registered, the web app's pages travel inside `main.js` (with both WebAssembly modules, the app's and PDF import's, which the web app downloads only when a PDF is opened), and nothing is written into the plugin folder
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: registers the .bedrock view, commands and settings, and writes nothing into the plugin folder -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the plugin packs the current web app, host adapter and WebAssembly included -->

#### Scenario: The canvas loads no files (Obsidian refuses them)
- **GIVEN** Obsidian refuses every file request made from a page inside a view
- **WHEN** a note or the launch gate is opened
- **THEN** the page is written into the iframe with its stylesheet and scripts inline, its module, workers, WebAssembly and word list are handed over as `blob:` URLs, and the canvas starts, saves and reads the word list without one request
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the canvas starts inside Obsidian without loading a single file (Obsidian refuses them) -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the canvas pages are written with their files handed over as blob: URLs, never loaded by address -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: at start, the plugin asks for the invite code and consent in a window, and closes it once agreed -->

#### Scenario: New notes
- **GIVEN** an open file
- **WHEN** a new note is made
- **THEN** it is an empty `.bedrock` file next to it and never overwrites a file
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: new notes are empty .bedrock files next to the open file, never overwriting one -->

#### Scenario: A new note from a folder's menu
- **GIVEN** a folder in Obsidian's file explorer
- **WHEN** the writer holds it (iPad, iPhone) or right-clicks it (desktop) and picks "New Bedrock note"
- **THEN** an empty `.bedrock` file is made in that folder (the vault's top folder too), whatever the "Folder for new notes" setting says, never overwriting a file, and it opens; a file's menu gets no such item
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: holding (or right-clicking) a folder offers a new Bedrock note in that folder -->

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
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: session camera is kept per file; the link picker and links get the note path -->

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
- **THEN** the canvas's own picker opens over the canvas (without focusing the link box, so no iPad keyboard) with the vault's folders and files as a tree (not index notes or the note itself) and a filter; the chosen link goes into the link box and Save makes the link, which reaches the file, `links.md`, the index note and Obsidian; closing the picker keeps the form; a copied link names a real stroke of the word
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: the link picker is offered every vault file but the note itself and index notes, with its link text -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: making a link opens the vault note picker, and the link reaches the file, the index and Obsidian -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the link picker shows the vault's folders and files; tapping a note puts its link in the box -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: closing the picker leaves the link form open, with Browse to try again and the other kinds of link -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the word menu copies a link to the word, for pasting into a vault note -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the app can ask for a link to a word; only real stroke ids are accepted -->

#### Scenario: Linking to a page of a PDF or a word of another note
- **GIVEN** the link picker
- **WHEN** a PDF or a Bedrock note is tapped
- **THEN** a PDF opens as its pages (drawn by the plugin with Obsidian's PDF.js) and a page links as `[[File.pdf#page=N]]`; a Bedrock note opens as its picture with its words marked, and a word links as `[[Note.bedrock#^<stroke id>]]`; either can be linked whole instead; the canvas may read other `.bedrock` files and nothing else
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the link picker opens a PDF to link one of its pages, or the whole file -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the link picker opens another Bedrock note to link one of its words, or the whole note -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: a PDF's pages are drawn for the link picker with Obsidian's PDF.js, and the open PDF is kept for the next page -->

#### Scenario: The iPad keyboard hides no text box
- **GIVEN** a word's menu, or any other text box, low in the view on an iPad
- **WHEN** the on-screen keyboard comes up (Obsidian sets `--keyboard-height` and fires `keyboardWillShow` without resizing the view) or the visible part of the window shrinks
- **THEN** the view tells the canvas how much of its bottom is hidden (`inset { bottom }`); the word menu moves above the keyboard, any other text box being typed in slides into sight with the page (`keep-in-view.js`), and both go back when the keyboard goes
<!-- test-js: apps/obsidian/tests/host.test.mjs :: bug: the word menu moves above the iPad keyboard, and back when it goes -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: bug: any text box being typed in slides into sight above the iPad keyboard, and back after -->

### Requirement: A handwritten note SHALL be made from a note or PDF, linking to it

"New handwritten note linking here" SHALL be offered in the editor menu of a
Markdown note, in the file menu of a Markdown note or PDF, in a right-click
inside a PDF that Obsidian leaves unanswered, and in the command palette.

#### Scenario: From a note or a PDF page
- **GIVEN** a Markdown note and a PDF scrolled to its fourth page
- **WHEN** the item is chosen in the note's editor menu, the PDF's ⋯ menu, a right-click on the PDF's second page, the file explorer, or the command palette
- **THEN** an empty note is made next to the page, named after it (`Lecture 3 notes`, `Week 3 page 4 notes`) without overwriting a file, and opened; it starts with a link of the whole note to the note, the page in view (`#page=4`), the page right-clicked, or the whole PDF when it is not open
- **AND** it is not offered for index notes, handwritten notes, or a right-click Obsidian answered with its own menu
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: a note or PDF offers "New handwritten note linking here": named after the page, it starts with a link to it -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: registers the .bedrock view, commands and settings, and writes nothing into the plugin folder -->

#### Scenario: The canvas saves the link at once
- **GIVEN** a note made this way
- **WHEN** its canvas starts
- **THEN** it asks for the starting link once (`start`), adds it, and saves straight away with no ink; the link reaches the file, `links.md` and the index note, and is not added again when the note reopens
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a new note's starting link is handed to its canvas once -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: a note made about a page starts with its link, saved at once; tags and links of the whole note reach the file and the index -->

### Requirement: The canvas SHALL show and edit the note's tags and links

#### Scenario: Tags and links… in the menu
- **GIVEN** a note open in the canvas
- **WHEN** "Tags and links…" is chosen in the menu and tags, a PDF page from the vault picker and a website are added, and a tag and a link are removed
- **THEN** the panel shows them, stays open over the picker, refuses a tag already there, opens a link with Obsidian, and the file and the index note get the tags and links
<!-- test-js: apps/obsidian/tests/host.test.mjs :: a note made about a page starts with its link, saved at once; tags and links of the whole note reach the file and the index -->
<!-- test-js: apps/web/tests/app.test.mjs :: tags and links of the whole note: added and removed from the menu, with no ink, and kept when the note reopens -->
