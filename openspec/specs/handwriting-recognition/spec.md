# handwriting-recognition Specification

## Purpose
Reading handwriting as text and maths on the device: finding words on the
page, running the recognisers (TrOCR for text, Pix2Text MFR for formulas)
in one worker, spell checking, the word menu, and the writer's corrections.
Results are saved in `recognized.json` (see `note-format`); a correction is
stored with `engine: "user"` and what was read kept in `alternatives`.

## Requirements

### Requirement: The page SHALL be split into words and lines, and the writer's split SHALL win

#### Scenario: Words and lines
- **GIVEN** handwriting on several lines, with dots and crossbars, and a word added later
- **WHEN** the page is laid out
- **THEN** letters are grouped into words and lines, dots and crossbars join their word, the later word joins its line, and drawings and highlights are not words
<!-- test: groups_letters_into_words_and_lines -->
<!-- test: dots_and_crossbars_join_their_word -->
<!-- test: a_word_added_later_joins_its_line -->
<!-- test: drawings_and_highlights_are_not_words -->
<!-- test: word_ids_are_stable_and_lookup_works -->
<!-- test: one_stroke_names_its_whole_word -->
<!-- test: layout_of_a_full_page_is_fast -->

#### Scenario: The writer's groups
- **GIVEN** strokes the writer made into one word
- **WHEN** the page is laid out
- **THEN** they are one word whatever the gaps say
<!-- test: writers_groups_override_the_word_split -->

### Requirement: Words SHALL be read, kept with their strokes and spell checked

#### Scenario: Reading and spell checking
- **GIVEN** a correct and a misspelled handwritten word
- **WHEN** they are read
- **THEN** both texts are saved with the note, only the misspelled one gets a red wavy underline, and a word whose strokes change is read again
<!-- test: stores_text_marks_misspellings_and_forgets_changed_words -->
<!-- test: checks_words_with_the_usual_allowances -->
<!-- test: suggests_close_words_best_first -->
<!-- test: edit_distance_is_damerau -->
<!-- test-js: apps/web/tests/app.test.mjs :: handwriting: words are recognised, misspellings get a red wavy underline, text is saved -->

#### Scenario: Erasing takes the text away
- **GIVEN** a word with recognised text
- **WHEN** one of its strokes is erased
- **THEN** its text is dropped so it never points at missing ink
<!-- test: erasing_ink_drops_its_recognised_text -->

#### Scenario: Maths
- **GIVEN** a fraction or a tall formula
- **WHEN** it is read
- **THEN** it counts as maths, goes to the formula model, is saved as LaTeX and is not spell checked
<!-- test: fractions_and_tall_formulas_count_as_math_and_are_not_spell_checked -->
<!-- test-js: apps/web/tests/app.test.mjs :: the formula recogniser runs Pix2Text MFR through Transformers.js (one runtime): files at the repo root, greedy decoding to LaTeX -->

### Requirement: Recognition SHALL run in one worker and never block writing

#### Scenario: One worker for every model
- **GIVEN** the fast and careful text models and the formula model
- **WHEN** they are used, and one runs out of memory
- **THEN** all run in one worker with one WebAssembly runtime; the error names the model, that worker is stopped, and a fresh one takes the next request
<!-- test-js: apps/web/tests/app.test.mjs :: all recognition models share one worker (one WebAssembly runtime); out of memory restarts it -->

#### Scenario: Careful reading
- **GIVEN** careful reading is on
- **WHEN** the writer pauses
- **THEN** the larger model re-reads words and its answer replaces the quick one, a word it read is not read again, it stops when writing resumes, and the mode is remembered
<!-- test-js: apps/web/tests/app.test.mjs :: careful reading: the larger model re-reads words after a pause, stops when writing resumes, and follows the menu mode -->

#### Scenario: The recogniser view
- **GIVEN** written words
- **WHEN** the recogniser view is opened from the menu
- **THEN** each word is shown as the recogniser sees it with what it read or why not, and it closes from its button
<!-- test-js: apps/web/tests/app.test.mjs :: the recogniser view shows each word as the recogniser sees it, with what it read or why not -->

### Requirement: The writer SHALL be able to correct a reading and say what a word is

#### Scenario: Correcting a reading
- **GIVEN** a word read as "helo"
- **WHEN** the writer types the real text, picks a suggestion, or ticks it as right
- **THEN** the text is kept as the truth with what was read beside it, saved, and not spell checked or read again
<!-- test: corrections_are_kept_with_what_was_read_and_not_spell_checked -->
<!-- test-js: apps/web/tests/app.test.mjs :: correcting a reading: type the real text, pick a suggestion or tick it; it is kept with what was read and saved -->

#### Scenario: Text, maths or not a word
- **GIVEN** a word
- **WHEN** the writer switches it between text and maths, or says it is not a word
- **THEN** it is read again by the right model, or never read by either model
<!-- test: the_writer_can_say_a_word_is_maths_or_text -->
<!-- test: not_a_word_is_never_read_and_long_links_keep_their_words -->
<!-- test-js: apps/web/tests/app.test.mjs :: word menu: says when a word is still waiting to be read, and switches a word between text and maths -->
<!-- test-js: apps/web/tests/app.test.mjs :: a lassoed paragraph becomes one link but stays separate words; "Not a word" is never read; a one-finger double tap toggles the eraser -->
