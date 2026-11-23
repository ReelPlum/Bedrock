# note-format Specification

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Note files written by every earlier Bedrock SHALL keep opening

#### Scenario: Notes from before note links and tags
- **GIVEN** files written just before note links and tags existed (commit 8048376), with a word linked to a PDF page, pictures and text boxes
- **WHEN** each is opened, and saved and opened again
- **THEN** everything comes back as it was written, with no note links, no tags and nothing taken for an unknown field
<!-- test: notes_from_before_note_links_and_tags_still_open -->
