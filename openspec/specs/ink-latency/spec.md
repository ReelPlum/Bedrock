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
