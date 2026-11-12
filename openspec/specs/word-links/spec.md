# word-links Specification

## Purpose
Making handwritten words point somewhere: holding a word opens its menu,
where it can become a link to a website (or, in Obsidian, to a vault note).
Links are saved in `note.json` `links` and listed in `links.md` (see
`note-format`).

## Requirements

### Requirement: Holding a word SHALL open its menu, and only a word

#### Scenario: Holding a word, holding empty paper
- **GIVEN** a handwritten word and empty paper
- **WHEN** the pen holds still on each
- **THEN** on the word its menu opens, says what it was read as, and the hold leaves no ink; on empty paper there is no menu and the hold draws its dot
<!-- test-js: apps/web/tests/app.test.mjs :: holding a word opens its menu: make it a website link (saved, underlined, in links.md); writing and empty paper are unaffected -->

### Requirement: A word SHALL become a link that is saved with its text

#### Scenario: A website link
- **GIVEN** a word's menu
- **WHEN** "example.com/docs" is entered as its link, or something that is not a web address
- **THEN** the address is refused; otherwise the word is underlined, the menu says where it links, and the link is saved in the note and in `links.md` with the word's text
<!-- test: words_become_links_that_are_saved_with_their_text -->
<!-- test-js: apps/web/tests/app.test.mjs :: holding a word opens its menu: make it a website link (saved, underlined, in links.md); writing and empty paper are unaffected -->

#### Scenario: A link is saved only while its strokes exist
- **GIVEN** a linked word over several strokes
- **WHEN** strokes are moved or the word is long
- **THEN** the link follows the moved strokes and keeps all its words
<!-- test: not_a_word_is_never_read_and_long_links_keep_their_words -->
<!-- test: moving_strokes_keeps_their_text_link_and_group_through_undo -->
