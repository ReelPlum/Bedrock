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
  (`index`, `indexFolder`, `newNoteFolder`, `newNotePaper`) and the camera per vault file
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

#### Scenario: Paper for new notes
- **GIVEN** the plugin's settings
- **WHEN** "Paper for new notes" is left alone, or set to grid, dots, lines or plain, and a new note is opened
- **THEN** it is grid by default, the choice is saved with the settings (settings saved before it existed get grid, anything else is never kept), the canvas asks the plugin for it (`defaults`, answered `{ paper }`) and the new note starts on it; notes already saved keep their own paper
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: new notes start on grid paper; the settings choose another paper for new notes, and it is remembered -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: a new note starts on the paper chosen in the settings, grid unless changed; a saved note keeps its own -->

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
- **THEN** its index note holds the recognised text (Markdown link syntax and `#` in handwriting are escaped, so it makes no links, tags or headings) and its links, and every word knows the strokes it came from
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

### Requirement: The tag box SHALL suggest tags already in use

Typing in "Tags and links…"'s tag box suggests tags that are already in use,
so an existing tag is found and picked instead of typed again with another
spelling. In Obsidian these are every tag in the vault, as Obsidian's tag
pane sees them (`#tags` and front matter `tags` of every Markdown note,
handwritten notes' tags through their index notes), asked of the plugin with
`list-tags` (`apps/obsidian/src/tags.js`). In the web app they are the tags
of the other notes in the library on the device, read from each note's
`note.json` and remembered while the app runs. Nothing new is saved: no data
format changes.

#### Scenario: Suggestions while typing
- **GIVEN** tags in use in other notes
- **WHEN** the panel opens, and a tag is typed
- **THEN** with nothing typed the most used tags are offered (at most eight); typing narrows them, case-insensitively and ignoring a leading `#`: tags that start with it first, then tags with a part that does (after `/`, `-` or `_`, so `forc` finds `physics/forces`), then tags that hold it; the most used first; tags the note already has are not offered; tags that differ only in case are one tag, in the spelling used most; `bedrock` is never offered
<!-- test-js: apps/web/tests/tag-suggest.test.mjs :: tags in use are counted per note, case-insensitively, in the spelling used most, without bedrock -->
<!-- test-js: apps/web/tests/tag-suggest.test.mjs :: suggestions match the start of the tag, then a part of it, then inside it; the most used first; not the tags the note has -->
<!-- test-js: apps/web/tests/app.test.mjs :: the tag box suggests tags used in other notes of the library, above the box, picked by tap or keys -->

#### Scenario: Picking a suggestion
- **GIVEN** suggestions shown
- **WHEN** one is tapped or clicked, or chosen with the arrow keys and Enter
- **THEN** it is added in its spelling, the box is emptied and keeps focus (on the iPad the keyboard stays up), and the suggestions follow; a typed tag that matches nothing is added with Enter as before
<!-- test-js: apps/web/tests/app.test.mjs :: the tag box suggests tags used in other notes of the library, above the box, picked by tap or keys -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the tag box suggests every tag in the vault, from Markdown notes too, and a tap adds one -->

#### Scenario: Where they come from
- **GIVEN** the web app with a library, or Obsidian with a vault
- **WHEN** the panel opens
- **THEN** the web app reads each other note's tags once until it changes, never the open note's; the plugin answers `list-tags` with every vault tag and how many notes have it; a plugin without `list-tags` (older) suggests nothing and the tag box works as before
<!-- test-js: apps/web/tests/tag-suggest.test.mjs :: the tags of the library are read from the note.json of each note once, leaving out the open note -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: every tag in the vault is offered for the tag box: Markdown notes and index notes, counted per note, without bedrock -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: a plugin without list-tags suggests nothing and the tag box works as before -->

#### Scenario: Never under the iPad's keyboard
- **GIVEN** an iPad, the on-screen keyboard up for the tag box
- **WHEN** suggestions are shown
- **THEN** they sit above the box, inside the panel at the top of the screen, so the keyboard covering the bottom never hides them
<!-- test-js: apps/web/tests/app.test.mjs :: on an iPad the tag suggestions sit above the tag box, where the keyboard never covers them -->

#### Open source used
None. Looked at: Awesomplete (MIT, no release since 2020), Tom Select
(Apache-2.0, maintained, but replaces the box with its own widget and
styles), @tarekraafat/autocomplete.js (Apache-2.0) and fuzzy matchers Fuse.js
(Apache-2.0) and uFuzzy (MIT). Built our own because the widgets float a
dropdown under the box, where the iPad keyboard hides it (the reason the
suggestions sit above it here), and each brings its own styles and events
that fight the panel's tap handling; the matching needed (start, part of a
nested tag, inside) is a few lines that a fuzzy matcher would make less
predictable for short tags. Obsidian's own `getAllTags` (its plugin API)
reads the vault's tags.

### Requirement: Many PDFs SHALL be imported at once from the settings

"Import PDFs" in the plugin's settings SHALL take PDFs dropped on it (folders
of PDFs too) or chosen with "Choose PDFs…", and make each a `.bedrock` note at
the vault's root, named after the PDF, as importing a PDF into an open note
makes it (every page with ink or pictures, one below another, with the PDF's
reading of the handwriting). No data format changes.

#### Scenario: Dropping a GoodNotes library
- **GIVEN** PDFs exported from GoodNotes, and a file that is not a PDF
- **WHEN** they are dropped on the drop zone in the settings
- **THEN** each PDF becomes a note at the vault's root named after it, which opens with its handwriting and has its index note, and the other file is listed as not a PDF
<!-- test-js: apps/obsidian/tests/host.test.mjs :: PDFs dropped on the settings' drop zone become notes at the vault root that open with their handwriting -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: the settings have a place to drop PDFs, which imports them at the vault root -->

#### Scenario: Dropping folders
- **GIVEN** a folder of PDFs with folders inside it, and a loose PDF
- **WHEN** they are dropped together
- **THEN** every PDF in the folders is found and imported at the vault's root (the folders are not kept), and other files are listed as not a PDF
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bulk PDF import: a dropped folder is searched for its files, in its folders too -->

#### Scenario: Names already taken
- **GIVEN** a note `Physics.bedrock` at the root, and PDFs `Physics.pdf`, `physics.PDF` and `Term 1/Physics.pdf` (from a dropped folder)
- **WHEN** they are imported
- **THEN** they become `Physics 1.bedrock`, `physics 2.bedrock` and `Physics 3.bedrock` at the root (names are compared ignoring case), and no file is overwritten
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bulk PDF import: each PDF becomes a note at the vault root named after it, and never overwrites a file -->

#### Scenario: A PDF that cannot be imported
- **GIVEN** a batch with a locked PDF, a PDF without handwriting or pictures, a file that cannot be read and a note that cannot be written
- **WHEN** it is imported
- **THEN** each of those is listed with its reason, and every other PDF is still imported
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bulk PDF import: a PDF that fails is listed with its reason, and the others are still imported -->

#### Scenario: Hundreds of PDFs
- **GIVEN** 300 PDFs dropped at once
- **WHEN** they are imported
- **THEN** only one file is read and held at a time, progress counts up one by one, and Obsidian gets to run between files; the import goes on when the settings are closed, and a notice says when it is done
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bulk PDF import: hundreds of PDFs are read one at a time, with progress, letting Obsidian run between files -->

#### Scenario: Stop
- **GIVEN** an import under way
- **WHEN** Stop is pressed
- **THEN** the notes already made stay, the PDF being read is finished, and the rest are listed as not imported
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bulk PDF import: Stop keeps the notes already made and lists the rest as not imported -->

#### Scenario: A PDF the reader hangs or crashes on
- **GIVEN** the PDF reader, which runs in a worker so Obsidian never freezes
- **WHEN** it does not answer for 2 minutes, or crashes, on one PDF
- **THEN** that PDF is listed as not imported, the worker is stopped and a new one reads the next PDF; a worker is also started afresh every 25 PDFs so its memory is given back
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bulk PDF import: a PDF the reader hangs or crashes on is given up, and the reader is started afresh -->

#### Open source used
No new library. Looked at: Dropzone.js, FilePond and Uppy (all MIT) for the
drop zone, and p-queue (MIT) for the queue. The drop zones are built around
uploading to a server, bring their own widgets and styles, and add 30 to
150 kB to a plugin whose settings use Obsidian's look; the browser's own drag
and drop (`DataTransfer`, and `webkitGetAsEntry` for dropped folders, in
Obsidian's Electron and iPadOS's WebKit) is about 60 lines. With one file at
a time the queue is a loop, and p-queue would not give the timeout and
restart of a stuck worker, which is the part that takes care. PDFs are read
by the existing `bedrock-pdf` WebAssembly (`hayro-syntax`, see `import-pdf`).
