# erasing Specification

## Purpose
Taking ink away: the stroke eraser, the partial eraser, the trim eraser, the
pen's eraser end, and scribbling over a word to erase it. Erased ink also
takes its recognised text with it (see `handwriting-recognition`).

## Requirements

### Requirement: The eraser SHALL remove ink in the mode chosen in its settings

The eraser's mode (whole strokes, partial, trim) lives in the eraser's own
settings. One erasing gesture is one undo step.

#### Scenario: Stroke eraser
- **GIVEN** strokes on the page
- **WHEN** the eraser touches one, even between its samples
- **THEN** the whole stroke is removed, and one undo brings everything the gesture removed back
<!-- test: whole_stroke_hit_test -->
<!-- test: eraser_between_samples_still_hits -->
<!-- test: stroke_eraser_is_one_undo_step -->
<!-- test-js: apps/web/tests/app.test.mjs :: the eraser removes strokes and can be undone -->
<!-- test-js: apps/web/tests/app.test.mjs :: tool settings: eraser mode lives in the settings of the eraser -->

#### Scenario: Partial eraser
- **GIVEN** a stroke
- **WHEN** the partial eraser crosses its middle, misses it, or covers all of it
- **THEN** it is split in two, left alone, or removed; the pieces record the stroke they came from
<!-- test: partial_erase_splits_in_two -->
<!-- test: partial_erase_untouched_is_none -->
<!-- test: partial_erase_everything_leaves_nothing -->
<!-- test: partial_eraser_splits -->

#### Scenario: Trim eraser
- **GIVEN** a line that overshoots where it crosses another
- **WHEN** the trim eraser touches the overshoot
- **THEN** it is cut back to the crossing and the rest is kept
<!-- test: trimmer_cuts_between_crossings -->
<!-- test: trimmer_cuts_back_to_crossings -->
<!-- test-js: apps/web/tests/app.test.mjs :: trim eraser cuts an overshoot back to the crossing, keeps the rest -->

#### Scenario: The pen's eraser end
- **GIVEN** the pen or lasso tool is chosen
- **WHEN** the pen's eraser end touches ink
- **THEN** it erases
<!-- test: pen_eraser_end_erases_even_in_draw_mode -->
<!-- test: pen_eraser_end_still_erases_with_the_lasso -->

### Requirement: Scribbling over a word SHALL erase it

With the setting on, a scribble mostly over ink erases that ink and is not
kept; elsewhere, or with the setting off, it is ink.

#### Scenario: Scribble to erase
- **GIVEN** a written word
- **WHEN** a scribble is drawn over it
- **THEN** the word fades while the pen is down, is erased when it lifts, the scribble is not kept, and one undo brings the word back
<!-- test: scribbles_are_recognised_and_writing_is_not -->
<!-- test: tight_scribbles_are_recognised_wherever_they_start -->
<!-- test: loops_are_not_scribbles -->
<!-- test: erases_only_ink_mostly_under_the_scribble -->
<!-- test: scribbling_over_a_word_erases_it_in_one_undo_step -->
<!-- test: a_scribble_shows_what_it_will_erase_before_the_pen_lifts -->
<!-- test-js: apps/web/tests/app.test.mjs :: a scribble fades the ink it will erase before the pen lifts -->

#### Scenario: Not a scribble
- **GIVEN** empty paper, or the setting turned off
- **WHEN** a scribble is drawn
- **THEN** it is ink
<!-- test-js: apps/web/tests/app.test.mjs :: scribbling over a word erases it (one undo brings it back); over empty paper, or with the setting off, it is ink -->
