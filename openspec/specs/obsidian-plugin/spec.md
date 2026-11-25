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
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: the camera follows a renamed note, even with search switched off -->

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
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: renaming an empty note makes no index note -->

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

#### Scenario: The iPad keyboard does not hide the word menu
- **GIVEN** a word's menu open low in the view on an iPad
- **WHEN** the on-screen keyboard comes up (Obsidian sets `--keyboard-height` and fires `keyboardWillShow` without resizing the view) or the visible part of the window shrinks
- **THEN** the view tells the canvas how much of its bottom is hidden (`inset { bottom }`), the menu moves above the keyboard with its text box in sight, and back when the keyboard goes
<!-- test-js: apps/obsidian/tests/host.test.mjs :: bug: the word menu moves above the iPad keyboard, and back when it goes -->

#### Scenario: Searching a PDF to link the page of a passage
- **GIVEN** a PDF open in the link picker
- **WHEN** text is typed in "Search in this PDF"
- **THEN** the matches are listed instead of the pages, each with its page and the words around it, found the way the search bar of Obsidian's PDF viewer finds them (any case, accents optional, over line breaks and hyphens at line ends); tapping a match links its page (`[[File.pdf#page=N]]`); no match says so; an empty search shows the pages again
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the link picker searches the text of an open PDF and links the page of a match -->

#### Scenario: The PDF search is Obsidian's
- **GIVEN** the plugin asked by the canvas to search a PDF (`pdf-find { path, query }`, a PDF and at most 200 letters only)
- **WHEN** Obsidian has loaded its PDF viewer (`window.pdfjsViewer`)
- **THEN** the viewer's PDF.js find controller finds the matches; before that the plugin's own matching, which finds the same; each match carries its page, the words around it and where it is in the page's text items (Obsidian's `selection=` numbers); at most 100 are listed, with the total
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the plugin searches a real PDF with the find controller of Obsidian's PDF viewer, and without it finds the same -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a PDF search's matches name the passage in the page's text items, as Obsidian's selection links count them -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the canvas may search PDFs only, for a short text -->

#### Scenario: Zooming a PDF in the link picker
- **GIVEN** a PDF open in the link picker, 3 pages across
- **WHEN** + or −, a pinch, or a trackpad pinch (ctrl + wheel) is used
- **THEN** the pages go to 2 and 1 across (bigger) or back to 3 and 4 (smaller), the page at the top stays in place, pages shown bigger are drawn again sharper, a page still links when tapped, and the next PDF opens as zoomed
<!-- test-js: apps/obsidian/tests/host.test.mjs :: an open PDF in the link picker zooms from 3 pages across to 2 and 1 and back, with buttons, a pinch or a trackpad -->

#### Scenario: Searching a PDF shows the pages it was found on
- **GIVEN** a PDF open in the link picker
- **WHEN** text is searched for
- **THEN** the matches are listed page by page, each page with its picture beside its matches, and tapping the picture or a match links the page
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the link picker searches the text of an open PDF and links the page of a match -->

#### Scenario: A PDF's text is read once for search
- **GIVEN** a PDF opened in the link picker
- **WHEN** it is searched again and again
- **THEN** the plugin reads each page's text once (starting as the PDF opens), and later searches only match the kept text; the file's bytes are read once per opened file, not for every page drawn
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a PDF's text is read once for search; later searches only match -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the plugin searches a real PDF with the find controller of Obsidian's PDF viewer, and without it finds the same -->

#### Scenario: Only the pages in sight are drawn
- **GIVEN** a long PDF open in the link picker
- **WHEN** it is scrolled fast to the end
- **THEN** pages that only flew by are not drawn (also on a slow device, with long frames), the pages in sight at the end are, at most two pictures are asked for at once, and pages not drawn yet already have their place
<!-- test-js: apps/obsidian/tests/host.test.mjs :: only the pages in sight are drawn: a fast scroll skips the pages passed on the way -->

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

### Requirement: Tags and paper SHALL be changed on many notes at once

Right-clicking (desktop) or holding (iPad) a handwritten note, several
selected ones, or a folder in Obsidian's file explorer SHALL offer "Add
tags…" and "Change paper…" (Obsidian's `file-menu` and `files-menu`). The
notes are changed without opening them, by bedrock-core exactly as the
canvas changes them ("Tags and links…", the paper menu): `tags` and `paper`
in `note.json`, with `bedrock_core::note_edit::edit_note` reading the note
with the same reader and saving it with the same writer. No data format
changes. Tags are not ink, so this works on a view-only desktop too.

#### Scenario: The menu
- **GIVEN** a vault with handwritten notes and Markdown notes
- **WHEN** one note, several selected files, or a folder is right-clicked or held
- **THEN** the menu has "Add tags…" and "Change paper…" (for several, "Add tags to 2 notes…"; for a folder, "…notes in this folder…", counting the notes in its folders too); only `.bedrock` files count, and a menu without any has neither item
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: right-clicking (or holding) one note, several selected notes or a folder offers to add tags and change the paper -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bulk edit: the notes picked are the .bedrock files selected and those in a folder and its folders, each once -->

#### Scenario: Adding tags to many notes
- **GIVEN** "Add tags to 3 notes…" chosen
- **WHEN** tags are typed (Enter or a comma adds each) or picked from the suggestions, and Add tags is pressed
- **THEN** the tag box suggests every tag in the vault as the canvas's tag box does (`suggestTags`, `vaultTags`), keeping focus when one is tapped; each tag is cleaned as the canvas cleans it (no `#`, spaces as `-`) and added to every note, keeping the tags a note has; a note that has them all is left untouched; each changed note's index note lists the tags; a notice says how many notes changed, already had them, or could not be changed and why
<!-- test-js: apps/obsidian/tests/host.test.mjs :: tags are added to many notes at once from the file menu, with tags in use suggested, and their paper is changed -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: right-clicking (or holding) one note, several selected notes or a folder offers to add tags and change the paper -->
<!-- test: edit_note_adds_tags_and_keeps_everything_else -->
<!-- test: edit_note_changing_nothing_leaves_the_file_alone -->

#### Scenario: Changing the paper of many notes
- **GIVEN** "Change paper of 2 notes…" chosen
- **WHEN** Grid, Dots, Lines or Plain is pressed
- **THEN** every note gets that paper, keeps its writing, tags and links, and opens on the new paper; a note already on it is left untouched; any other paper is refused
<!-- test-js: apps/obsidian/tests/host.test.mjs :: tags are added to many notes at once from the file menu, with tags in use suggested, and their paper is changed -->
<!-- test: edit_note_sets_the_paper -->
<!-- test: edit_note_refuses_an_unknown_paper_and_a_damaged_file -->

#### Scenario: Many notes, open notes and notes that fail
- **GIVEN** hundreds of notes, one of them open in a view, one damaged and one new (empty)
- **WHEN** tags are added to them
- **THEN** one note is read and changed at a time, in a worker, with Obsidian running between notes; the open note saves what was drawn last first and reloads with the change; the damaged and the empty note are listed with their reason and left as they were, and the others are still changed
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bulk edit: each note is changed one at a time, saved first if open, indexed, and one that fails is listed while the rest go on -->

#### Scenario: Notes saved by earlier versions
- **GIVEN** notes saved by every earlier version of Bedrock (`tests/fixtures/old-formats/`)
- **WHEN** tags are added and the paper is changed
- **THEN** they are read in full and keep all their strokes, as opening and saving them on the canvas does
<!-- test: edit_note_reads_a_note_saved_before_it -->

#### Open source used
No new library. Obsidian's own plugin API gives the menus (`file-menu`,
`files-menu`) and the window (`Modal`). The tag box reuses the canvas's
suggestions (`apps/web/src/tag-suggest.js`); Obsidian's `AbstractInputSuggest`
was looked at, but it shows its list under the box, where the iPad's keyboard
hides it, which is why the canvas's suggestions sit above the box. Vault-wide
tag plugins (Tag Wrangler, MIT; Multi Properties, MIT) edit Markdown front
matter, and a handwritten note's tags live in its `.bedrock` file: the index
note is rebuilt from it, so a front matter edit would be overwritten. The note
is read and written by bedrock-core, as everywhere else.

### Requirement: Many PDFs SHALL be imported at once from the settings

"Import PDFs" in the plugin's settings SHALL take PDFs dropped on it (folders
of PDFs too) or chosen with "Choose PDFs…", and make each a `.bedrock` note at
the vault's root, named after the PDF, as importing a PDF into an open note
makes it (every page with ink or pictures, one below another, with the PDF's
reading of the handwriting), on the "Paper for new notes" setting's paper.
No data format changes.

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

### Requirement: The plugin SHALL be released from this repository so BRAT and Obsidian can install it

#### Scenario: The manifest is at the repository root
- **GIVEN** the repository
- **WHEN** Obsidian or BRAT reads `manifest.json` at its root
- **THEN** it follows Obsidian's manifest rules and `versions.json` maps its version to its `minAppVersion`
<!-- test-js: apps/obsidian/tests/release.test.mjs :: manifest.json at the repository root follows Obsidian's rules and is listed in versions.json -->

#### Scenario: Tagging a version publishes it
- **GIVEN** a tag `0.2.0` equal to the manifest version, or a beta tag `0.2.0-beta.1`
- **WHEN** it is pushed
- **THEN** a GitHub release with that tag carries `main.js`, `manifest.json` (with the tag as its version) and `styles.css`, and a beta is a pre-release; a tag that is not the manifest version, or is not a plugin version, is refused before building
<!-- test-js: apps/obsidian/tests/release.test.mjs :: a release tag must be the manifest version; a beta tag gets its own version in the released manifest -->

#### Scenario: A broken manifest is not released
- **GIVEN** a manifest that breaks Obsidian's rules, or a version missing from `versions.json`
- **WHEN** a version is tagged
- **THEN** the release is refused and says why
<!-- test-js: apps/obsidian/tests/release.test.mjs :: a release is refused when the manifest breaks Obsidian's rules -->

### Requirement: Writing in Obsidian SHALL cost Obsidian's main thread little

The canvas shares Obsidian's main thread, so work done for each save there
holds up the pen.

#### Scenario: The index note waits for a pause in writing
- **GIVEN** a note being written in the view
- **WHEN** the canvas saves again and again while the writer keeps writing
- **THEN** every save reaches the file at once, the index note is written once writing has paused (2.5 s) with the latest text, a waiting index note is written as soon as the view closes, and nothing is written when nothing is waiting
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: while the writer keeps writing, the index note waits for a pause and is written once -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: saves hand the file to Obsidian without a copy, and the index note waits for writing to pause -->

#### Scenario: A saved file is handed over, not copied
- **GIVEN** the canvas saving its note
- **WHEN** it sends the file to the plugin
- **THEN** the file's buffer is transferred, and the session writes it to the vault without another copy
<!-- test-js: apps/obsidian/tests/host.test.mjs :: saves hand the file to Obsidian without a copy, and the index note waits for writing to pause -->

#### Scenario: The WebAssembly is compiled once while the plugin runs
- **GIVEN** the plugin running, with notes opened one after another
- **WHEN** each canvas starts
- **THEN** it asks the plugin for the compiled WebAssembly (`wasm`) and gets the module the plugin compiled soon after Obsidian started (or for the first note), compiles nothing itself, and passes it on to its save worker; with no module it compiles its own; a reloaded plugin compiles afresh
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the WebAssembly is compiled once while the plugin runs, and the session hands it to each canvas -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the WebAssembly is compiled once for all notes; each canvas and its save worker reuse it -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: soon after Obsidian starts, the WebAssembly is compiled once, ready for the first note -->

### Requirement: The note's name in the header SHALL be its file name

Inside Obsidian the canvas header shows the vault file's name without
`.bedrock`, and the two are kept the same in both directions.

#### Scenario: The header shows the file name
- **GIVEN** a new note `Handwritten note.bedrock`, and a note `Forces.bedrock` whose stored title is "Old title"
- **WHEN** each is opened in the view
- **THEN** the header shows "Handwritten note" and "Forces", and the next save stores the file name as the title
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the header shows the note's file name, and naming the note there renames the file -->

#### Scenario: Naming the note in the header renames the file
- **GIVEN** a note open in the view
- **WHEN** a new name is typed in the header and finished (Enter, or leaving the box)
- **THEN** the vault file is renamed once, in its folder, with Obsidian's `fileManager.renameFile` (so links to it are updated), and the index note or sidecar and the camera follow; typing alone renames nothing
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the header shows the note's file name, and naming the note there renames the file -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: naming a note in the header renames its file with Obsidian's file manager, in its folder -->

#### Scenario: Names a file cannot have
- **GIVEN** a name typed in the header
- **WHEN** it holds characters a file name or an Obsidian link cannot (`\ / : * ? " < > | # ^ [ ]`), is empty, or another file in the folder already has it
- **THEN** those characters become spaces; an empty name or a clash leaves the file as it is (a clash with a notice) and the header goes back to the file name
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a title becomes a file name Obsidian can link to -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the app can ask to rename the note; empty and unchanged names rename nothing -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: a header name another file already has renames nothing and says so -->

#### Scenario: Renaming the file in Obsidian updates the header
- **GIVEN** a note open in the view
- **WHEN** its file is renamed or moved in Obsidian
- **THEN** the view sends `renamed { name }` and the header shows the new name, which the next save stores as the title
<!-- test-js: apps/obsidian/tests/host.test.mjs :: renaming the file in Obsidian puts the new name in the header -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: the view tells the canvas when Obsidian renames its file -->

### Requirement: The link picker SHALL find the words of notes in every format version

#### Scenario: A note with its samples in points.bin
- **GIVEN** another Bedrock note saved as format version 2 (samples in `points.bin`), or an older one with every sample in `note.json`, or one that mixes both
- **WHEN** it is opened in the link picker
- **THEN** its words are marked in the same places either way, and a damaged `points.bin` marks no words instead of failing
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the link picker finds the words of notes with their samples in points.bin, and of older notes -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the link picker opens another Bedrock note to link one of its words, or the whole note -->

### Requirement: The ink SHALL be locked in Obsidian on a computer

In Obsidian's desktop app (Mac, Windows, Linux) a Bedrock note opens "view
only": it can be looked at, moved, zoomed and searched, its links followed,
its tags edited and what the recogniser read corrected, but its ink,
pictures and text boxes never change. On the iPad and phones notes are
edited as before.

#### Scenario: Pen, mouse and fingers move the page and never draw
- **GIVEN** a note open view only
- **WHEN** the pen, the mouse or a finger is dragged across it (with "Draw with finger" on too), or two or three fingers double-tap
- **THEN** the page moves and nothing is drawn, erased, selected, undone or redone
<!-- test: view_only_pen_and_mouse_move_the_page_and_never_draw -->
<!-- test: view_only_ignores_undo_redo_and_eraser_taps -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: on a computer the ink is locked: pen and mouse move the page, scrolling zooms, nothing is drawn; tags and readings are edited and saved -->

#### Scenario: Scrolling zooms
- **GIVEN** a note open view only
- **WHEN** the mouse wheel turns, or two fingers scroll on a trackpad
- **THEN** the page zooms around the pointer (in when scrolling up, about a fifth per wheel notch) instead of moving; a trackpad pinch zooms as before
<!-- test-js: apps/obsidian/tests/host.test.mjs :: on a computer the ink is locked: pen and mouse move the page, scrolling zooms, nothing is drawn; tags and readings are edited and saved -->

#### Scenario: Only what leaves the ink alone is offered
- **GIVEN** a note written on the iPad, with words, a tag and a link of the whole note, opened view only
- **WHEN** it is shown
- **THEN** the toolbar, undo, redo, inserting, pasting, importing and the pen's settings are hidden, the header says "View only" and its name cannot be edited; a word's menu says what the word was read as, corrects it ("This is right", "Correct the text…", maths or text, "Not a word") and copies a link to it, but does not link, group, recolour, duplicate or delete; "Tags and links…" adds and removes tags, and lists the links and opens one, with nothing to add or remove; "Show all ink" stays
<!-- test-js: apps/obsidian/tests/host.test.mjs :: on a computer the ink is locked: pen and mouse move the page, scrolling zooms, nothing is drawn; tags and readings are edited and saved -->

#### Scenario: Tags and corrections are saved; nothing else is
- **GIVEN** a note open view only
- **WHEN** keys for undo, redo, tools or delete are pressed, text is pasted, the recogniser reads, and the view saves and closes; then a reading is corrected and tags are added and removed
- **THEN** the first changes nothing and writes nothing (no autosave, so opening a note on a computer never writes it); each correction and tag change is saved at once with the ink exactly as it was, and reaches the index note
<!-- test-js: apps/obsidian/tests/host.test.mjs :: on a computer the ink is locked: pen and mouse move the page, scrolling zooms, nothing is drawn; tags and readings are edited and saved -->

#### Scenario: The plugin refuses changed ink
- **GIVEN** a view-only canvas asks to write its file
- **WHEN** the new file adds, removes or changes strokes (their samples or brush), pictures or text boxes, or cannot be read
- **THEN** the plugin refuses it and the file keeps its bytes; a file whose ink, pictures and text boxes are as they were (tags, readings, links of the whole note) is written, and a note from before `points.bin` may be written with its samples moved there; the file is never renamed
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a view-only session never renames the file, and writes it only with its ink exactly as it was -->

#### Scenario: New notes are made on a computer, and written on the iPad
- **GIVEN** the plugin in Obsidian's desktop app
- **WHEN** it loads, and "New Bedrock note" (ribbon, folder menu, command) or "New handwritten note linking here" (note, PDF or editor menu, command) is chosen
- **THEN** the empty note is made as on the iPad and opens view only (`BEDROCK_VIEW_ONLY`); the header cannot rename it
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: on a desktop computer notes are view only, and new notes are still made; the iPad edits -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the canvas pages are written with their files handed over as blob: URLs, never loaded by address -->

#### Scenario: A note made about a page keeps its link on a computer
- **GIVEN** a note made on a computer with "New handwritten note linking here"
- **WHEN** its view-only canvas starts
- **THEN** it asks for the starting link and saves it at once, as on the iPad; after that the ink is locked
<!-- test-js: apps/obsidian/tests/host.test.mjs :: a note made on a computer about a page keeps its link, and is view only after that -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a view-only session never renames the file, and writes it only with its ink exactly as it was -->

### Requirement: The plugin SHALL offer a graph filter that shows each note once, without the #bedrock tag

Obsidian gives plugins no way to set the graph's filters, so the plugin
hands the writer one to paste into the graph's "Search files":
`-file:/\.bedrock$/ -(#bedrock)`. `-file:/\.bedrock$/` hides the `.bedrock`
files, so each handwritten note is one node, its index note (sidecars end
in `.bedrock.md` and stay). `-(#bedrock)` hides the `#bedrock` tag node
and keeps the notes that carry the tag. With "Attachments" on, PDFs show,
and a note linking a PDF page is an edge from its index note to the PDF.

#### Scenario: What the filter hides and keeps
- **GIVEN** a handwritten note with a tag and a link to a PDF page, its index note, a sidecar and the PDF
- **WHEN** the graph's search is the plugin's filter
- **THEN** the `.bedrock` file matches `-file:/\.bedrock$/` and the index note, sidecar and PDF do not; the index note says `bedrock` only in its front matter tags, never `#bedrock` in its text, and keeps its link to the PDF page
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the graph filter hides .bedrock files and the #bedrock tag node, and keeps index notes, sidecars and PDFs -->

#### Scenario: Copying the filter
- **GIVEN** the plugin is loaded, on a computer or an iPad
- **WHEN** "Copy graph filter that hides .bedrock files and the #bedrock tag" is run, or "Copy filter" is pressed in the settings
- **THEN** the filter is on the clipboard and a notice says to turn on "Attachments" and paste it into "Search files"; where the clipboard is refused the notice shows the filter itself
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the graph filter goes on the clipboard, or is shown where the clipboard is refused -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: registers the .bedrock view, commands and settings, and writes nothing into the plugin folder -->

## Open source used

### Libraries and tools of the plugin

| | PDF.js | esbuild | BRAT, attest-build-provenance, GitHub CLI |
|---|---|---|---|
| Version | Obsidian's own copy (`loadPdfJs()`, `window.pdfjsViewer`); [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) 4.10.38 in the tests only | [esbuild](https://www.npmjs.com/package/esbuild) 0.28.2, build only | Used to install and release, not bundled |
| Used for | Drawing a PDF's pages in the link picker and searching them with its find controller. | Bundling the plugin and the web app's module graphs into `main.js`. | Installing beta builds (BRAT), signed provenance for the release files, publishing the release. |
| Why this one | Obsidian already ships it for its PDF viewer, so nothing is added to the plugin. Firefox's built-in viewer, maintained by Mozilla for over a decade. | The bundler Obsidian's sample plugin uses; fast and with no plugins needed. | The tools Obsidian's docs and release guide recommend. |
| Licence | Apache-2.0 | MIT | MIT (all three) |
| Not Rust | JavaScript, already inside Obsidian. | Go, build only. | Not shipped. |
