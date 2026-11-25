# ink-latency Specification

## Purpose
Ink must keep up with the pen however large the note is. This covers the
per-sample work budget, what is drawn while the pen is down, the stroke
geometry cache, and the 100 000-stroke budget.

## Requirements

### Requirement: Handling and drawing a pen sample SHALL fit in half a frame

#### Scenario: Latency budget
- **GIVEN** a pen writing
- **WHEN** samples are handled and drawn
- **THEN** the 95th percentile work per sample is within half a frame
<!-- test-js: apps/web/tests/app.test.mjs :: ink latency: handling and drawing a pen sample fits in half a frame -->

#### Scenario: Only ink while the pen is down
- **GIVEN** a stroke being written
- **WHEN** frames are drawn
- **THEN** only the live ink layer is redrawn, not the underlines or the minimap, and everything is redrawn once the stroke is on the page
<!-- test: drawing_only_dirties_live_layer -->
<!-- test: render_flag -->
<!-- test-js: apps/web/tests/app.test.mjs :: while the pen is down, frames draw the ink and nothing else -->

#### Scenario: A long live stroke
- **GIVEN** a long stroke, solid or dashed, still being drawn
- **WHEN** each frame adds samples
- **THEN** the cost of a frame does not grow with the stroke, and the result looks like a full rebuild
<!-- test: a_long_live_stroke_looks_like_a_full_rebuild -->
<!-- test: a_dashed_live_stroke_is_built_whole -->
<!-- test: the_cost_of_a_live_frame_does_not_grow_with_the_stroke -->

### Requirement: Big notes SHALL stay smooth

#### Scenario: Scene caching and culling
- **GIVEN** many strokes
- **WHEN** the scene is synced and panned
- **THEN** opaque strokes are batched, syncing is incremental, finishing a stroke reuses its chunk, the cache stays bounded, and only visible chunks are drawn
<!-- test: opaque_strokes_are_batched -->
<!-- test: sync_is_incremental -->
<!-- test: finishing_a_stroke_reuses_the_rest_of_its_chunk -->
<!-- test: cache_stays_bounded -->
<!-- test: culling -->

#### Scenario: 100 000 strokes
- **GIVEN** a note with 100 000 strokes
- **WHEN** it is built and panned (`cargo test --release --test perf -- --ignored`)
- **THEN** memory per stroke and culling per frame stay within budget
<!-- test: hundred_thousand_strokes -->

### Requirement: Latency SHALL be measurable in the app

#### Scenario: Show latency
- **GIVEN** "Show latency" is on
- **WHEN** the pen writes
- **THEN** the frame rate is reported and a pen trace can be recorded
<!-- test-js: apps/web/tests/app.test.mjs :: “Show latency” reports the frame rate, and a pen trace can be recorded -->

### Requirement: Erasing and selecting SHALL stay quick in a very big note

#### Scenario: Erasing and lassoing among 100 000 strokes
- **GIVEN** a note with 100 000 handwriting-sized strokes
- **WHEN** the eraser moves over it and a lasso is drawn around a few words (`cargo test --release --test perf -- --ignored`)
- **THEN** one eraser move takes under 2 ms and one lasso under 5 ms
<!-- test: hundred_thousand_strokes -->

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

None. Kept our own on purpose, with the reason:

| | rstar (considered for the eraser and lasso, not used there) |
|---|---|
| Version | [0.14](https://crates.io/crates/rstar) |
| Would be used for | A spatial index (R-tree) to find the strokes under the eraser or inside a lasso without looking at every stroke. |
| Why not | Measured first: on 100 000 strokes, checking every stroke's stored bounds takes about 0.7 ms per eraser move and 0.7 ms per lasso (about 0.03 ms on a typical note), well inside a 120 Hz frame. The eraser and lasso must give strokes back in stacking order, and the note keeps strokes in a list in that order, so turning the index's answer back into that order costs as much as the scan; and the index would have to follow every change, undo and redo. Drawing already culls by chunk (0.07 ms per frame). The budget above is now tested, so if notes outgrow it, this is the library to use. Scribbling out does use it, for the scribble's own segments (see `erasing`). |
| Why it is mature | Since 2018, about 56 million downloads, maintained by the GeoRust organisation, released November 2026. |
| Licence | MIT or Apache-2.0: commercial use allowed. |

None new. These are measurements and changes to Bedrock's own code: a
sorted list, a hash set and a single pass over a list need no library.
