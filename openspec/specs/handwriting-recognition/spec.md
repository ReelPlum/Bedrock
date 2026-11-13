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
<!-- test-js: apps/web/tests/app.test.mjs :: handwriting: words are recognised, misspellings get a red wavy underline, text is saved -->

#### Scenario: Names, weekdays, contractions and both spellings (regression)
- **GIVEN** the English dictionary shipped with the app
- **WHEN** words like "Tuesday", "Paris", "NASA", "don't", "can’t", "colour" and "color" are checked
- **THEN** none is underlined, while "tuesday", "paris" and "recieve" are
<!-- test: the_shipped_dictionary_knows_names_weekdays_and_contractions -->

#### Scenario: Suggestions for common mistakes
- **GIVEN** the English dictionary shipped with the app
- **WHEN** suggestions are asked for "recieve", "becuase", "untill" or "hendwriting"
- **THEN** the word meant comes first, and no suggestion splits the word in two
<!-- test: the_shipped_dictionary_suggests_the_word_meant -->

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

#### Scenario: One word at a time (regression)
A report from iPad Safari showed up to 10 `recognize` jobs at once, each
running 37 s to 92 s, and "recogniser stopped" several times. Every unread
word was sent at the same moment (after a lasso move or opening a note), and
the worker's message handler started each one straight away, so they all ran
together in one single-threaded WebAssembly runtime: each as slow as all of
them, with their memory added up until iPad Safari ran out. Now the app sends
one word at a time, words just written first, and the worker also runs its
requests (and model releases) one after another.
- **GIVEN** three unread words already seen by an earlier pass and one word just written
- **WHEN** two live passes are asked for at once
- **THEN** one pass runs, the recogniser reads one word at a time, the new word first, each word once, and only the word being read is timed as `recognize`
<!-- test-js: apps/web/tests/app.test.mjs :: recognition reads one word at a time, newest words first, and times each word from when the recogniser starts on it (regression) -->
- **GIVEN** the worker gets a request, a release, a request that fails and another request
- **WHEN** they arrive together
- **THEN** it runs them one at a time in order, answers in order, and importing it into a page leaves the page's messages alone
<!-- test-js: apps/web/tests/app.test.mjs :: the recogniser worker runs one request at a time, and a release waits its turn (regression) -->

#### Scenario: A stuck or stopped recogniser (regression)
The same report had one `recognize` job of 298 s and told the person only
"recogniser stopped". A worker that says nothing for 60 s (no answer, no
download progress) while a word waits is now stopped ("recogniser did not
answer") and a fresh one takes the next word. When a request runs out of
memory, that word's own error is given first, so the message names the
model and the reason; the words waiting behind it get "recogniser stopped:
out of memory". A model download is shown as such and the word is timed
from when its model is ready.
- **GIVEN** a worker that never answers, then one that runs out of memory with a second word waiting, then one that downloads its model first
- **WHEN** words are read
- **THEN** the silent one is stopped and a new worker answers; the out of memory error comes first; the download is not a long `recognize` job
<!-- test-js: apps/web/tests/app.test.mjs :: a recogniser that stops answering is restarted, the real reason for a stop is shown, and a model download is not timed as the word (regression) -->

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

## Open source used

| | spellbook | English Hunspell dictionary (SCOWL) |
|---|---|---|
| Version | [0.4](https://crates.io/crates/spellbook) | en_US and en_GB-ise, SCOWL size 60, 2020.12.07, from the npm packages `dictionary-en` 4.0.0 and `dictionary-en-gb` 3.0.0, merged (`apps/web/dict/README.md`) |
| Used for | Checking words and suggesting corrections (`crates/bedrock-core/src/spell.rs`). | The words and rules for English. |
| Why this one | Reads Hunspell dictionaries, the format of LibreOffice, Firefox and most spell checkers, so other languages need only a dictionary. Its rules fixed a real bug: the plain word list shipped before had no capitalised words and no apostrophes, so every weekday, month, name and contraction was underlined. Suggestions on common mistakes are as good as our own edit distance search, at about the same speed. Pure Rust and `no_std`, small in WebAssembly. Bedrock keeps a thin layer for handwriting (punctuation, numbers, single letters, hyphenated words) and drops suggestions that split a word in two. | The dictionary the old word list came from, now with its affix rules; both spellings pass, as before. |
| Why it is mature | Young and called alpha by its author: since 2023, about 380 000 downloads, released June 2026. Trusted because it is a port of Nuspell (the modern rewrite of Hunspell), passes almost all of the Hunspell test corpus that Nuspell tests with, is maintained by a Helix editor maintainer, and is used by `codebook` (Zed's spell checker) and `cargo-spellcheck`. A wrong answer costs a red underline, not data. The version is pinned and the shipped dictionary is tested. | SCOWL is maintained by Kevin Atkinson since 2000 and is the source of the English dictionaries in LibreOffice, Firefox and most Linux systems. |
| Licence | MPL-2.0: commercial use allowed; changes to spellbook's own files would have to be published (we make none). | SCOWL's permissive licence (`apps/web/dict/LICENSE-en_US.txt`): use, copying and selling allowed with the notice kept. |
| Considered | `zspell` (also Hunspell, less complete); Hunspell or Nuspell themselves (C and C++, harder to build for WebAssembly); keeping our own word list checker (no rules, so names and contractions failed unless listed one by one). | Keeping the plain SCOWL word list (no capitals or apostrophes in the packaged list). |
| Not Rust | No. | Data, not code. |
