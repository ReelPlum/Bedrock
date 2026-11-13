# erasing Specification

## ADDED Requirements

### Requirement: Scribbling out SHALL stay smooth on big notes

Working out what a scribble would erase, and fading that ink, runs over and
over while the pen is down. It SHALL fit easily in a frame however long the
scribble and however full the page.

#### Scenario: Scribbling out on a page of 1600 strokes (regression)
- **GIVEN** a page densely filled with 1600 handwriting strokes
- **WHEN** a five second scribble is drawn over a few lines of it (`cargo test --release --test perf -- --ignored`)
- **THEN** each pen sample is handled in under 1.5 ms, each update of the fading ink takes under 2 ms, each faded stroke is tessellated once, and lifting the pen erases the ink in under 5 ms
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
