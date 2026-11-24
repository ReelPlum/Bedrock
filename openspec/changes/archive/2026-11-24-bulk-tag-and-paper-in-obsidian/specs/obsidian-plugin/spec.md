# obsidian-plugin Specification

## ADDED Requirements

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
