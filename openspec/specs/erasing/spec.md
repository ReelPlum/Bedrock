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

### Requirement: Scribbling out SHALL stay smooth on big notes

Working out what a scribble would erase, and fading that ink, runs over and
over while the pen is down. It SHALL fit easily in a frame however long the
scribble and however full the page.

#### Scenario: Scribbling out on a page of 1600 strokes (regression)
- **GIVEN** a page densely filled with 1600 handwriting strokes
- **WHEN** a five second scribble is drawn over a few lines of it (`cargo test --release --test perf -- --ignored`)
- **THEN** pen samples are handled in under 1.5 ms and updates of the fading ink take under 2 ms (99th percentile, so a CI runner losing the CPU for a moment does not count), none takes a whole 120 Hz frame (8 ms), each faded stroke is tessellated once, and lifting the pen erases the ink in under 5 ms
<!-- test: scribbling_out_on_a_big_note_stays_smooth -->

#### Scenario: The fast lookup erases the same ink
- **GIVEN** dense random ink: dots, short marks and long lines, thick and thin
- **WHEN** scribbles of many sizes are drawn over it
- **THEN** exactly the strokes the full comparison of every segment would pick are erased
<!-- test: indexed_targets_match_the_full_scan -->

#### Scenario: Fading ink a scribble is about to erase
- **GIVEN** a scribble over ink, the set of strokes it would erase growing as it is drawn
- **WHEN** the fading veil is updated each frame
- **THEN** each stroke is tessellated once while the scribble lasts, many joining at once fade in over a few frames, and a change to the note starts over
<!-- test: veil_tessellates_each_stroke_once_while_it_grows -->

## Open source used

| | rstar |
|---|---|
| Version | [0.14](https://crates.io/crates/rstar) |
| Used for | An R-tree of the scribble's own segments, so checking whether a stroke touches the scribble looks only at the scribble segments near it. |
| Why this one | It does exactly this: bulk loading a few hundred boxes and asking which ones meet a box. Pure Rust, no unsafe code needed from us, builds for WebAssembly. Earlier (see `ink-latency`) it was turned down for finding the strokes under the eraser, because scanning the note's stored bounds is already fast and must keep stacking order; that scan stays here too. The R-tree is used only for the scribble's segments, built fresh for each check, so it never has to follow edits, undo or redo. |
| Why it is mature | Since 2018, about 56 million downloads, maintained by the GeoRust organisation (also behind `geo`), released November 2026. |
| Licence | MIT or Apache-2.0: commercial use allowed. |
| Considered | A hand-written uniform grid of the scribble's segments: would work, but needs a cell size tuned to the scribble and is code we would own; `kiddo` (k-d tree of points, not segments); a quadtree crate (`quadtree_rs`: about 50 000 downloads, last released 2023). |
| Not Rust | No. |
