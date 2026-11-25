# ink-latency Specification

## ADDED Requirements

### Requirement: Editing a big note SHALL stay quick

Each of these is measured on a note of 100 000 handwriting strokes (10 000
for saving and exporting) by `cargo test --release -p bedrock-core --test perf -- --ignored`, which CI runs.

#### Scenario: Erasing in every mode
- **GIVEN** a note of 100 000 strokes
- **WHEN** a stroke, partial or trim eraser swipe crosses a few lines, and is undone
- **THEN** each eraser move takes under 16 ms, the redraw after it under 100 ms, and undoing it under 60 ms (400 ms for a partial swipe)
<!-- test: erasing_on_a_big_note -->

#### Scenario: Moving a big selection (regression)
- **GIVEN** 2000 strokes selected in a note of 100 000
- **WHEN** they are moved, the move is undone and redone, and they are duplicated
- **THEN** moving and duplicating each take under 150 ms, undo and redo under 100 ms, the strokes keep their place in the stacking order, and undo puts every stroke back where it was
<!-- test: moving_a_big_selection_on_a_big_note -->
<!-- test: moving_many_strokes_at_once_matches_one_by_one -->

#### Scenario: Grouping handwriting into words (regression)
- **GIVEN** a note of 20 000 strokes, and one of 100 000
- **WHEN** its handwriting is grouped into lines and words
- **THEN** it takes under 60 ms and under 500 ms
<!-- test: word_layout_on_a_big_note -->

#### Scenario: Saving, opening and exporting
- **GIVEN** a note of 10 000 strokes
- **WHEN** it is saved, opened again and exported as SVG
- **THEN** saving and opening each take under 1.5 s, exporting under 3 s, and nothing is lost; the minimap of a 100 000 stroke note takes under 300 ms and its sync check under 50 ms
<!-- test: saving_opening_and_exporting_a_big_note -->

#### Scenario: Eraser and lasso hit tests
- **GIVEN** a note of 100 000 strokes
- **WHEN** the eraser asks what it touches, and a lasso is drawn around a few words
- **THEN** the eraser's hit test takes under 2 ms and the lasso under 5 ms
<!-- test: eraser_and_lasso_hit_tests_on_a_big_note -->

## Open source used

None new. These are measurements and changes to Bedrock's own code: a
sorted list, a hash set and a single pass over a list need no library.
