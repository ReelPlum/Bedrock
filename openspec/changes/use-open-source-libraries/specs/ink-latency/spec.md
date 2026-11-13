# ink-latency Specification

## ADDED Requirements

### Requirement: Erasing and selecting SHALL stay quick in a very big note

#### Scenario: Erasing and lassoing among 100 000 strokes
- **GIVEN** a note with 100 000 handwriting-sized strokes
- **WHEN** the eraser moves over it and a lasso is drawn around a few words (`cargo test --release --test perf -- --ignored`)
- **THEN** one eraser move takes under 2 ms and one lasso under 5 ms
<!-- test: hundred_thousand_strokes -->

## Open source used

None. Kept our own on purpose, with the reason:

| | rstar (considered for the eraser and lasso, not used there) |
|---|---|
| Version | [0.14](https://crates.io/crates/rstar) |
| Would be used for | A spatial index (R-tree) to find the strokes under the eraser or inside a lasso without looking at every stroke. |
| Why not | Measured first: on 100 000 strokes, checking every stroke's stored bounds takes about 0.7 ms per eraser move and 0.7 ms per lasso (about 0.03 ms on a typical note), well inside a 120 Hz frame. The eraser and lasso must give strokes back in stacking order, and the note keeps strokes in a list in that order, so turning the index's answer back into that order costs as much as the scan; and the index would have to follow every change, undo and redo. Drawing already culls by chunk (0.07 ms per frame). The budget above is now tested, so if notes outgrow it, this is the library to use. Scribbling out does use it, for the scribble's own segments (see `erasing`). |
| Why it is mature | Since 2018, about 56 million downloads, maintained by the GeoRust organisation, released November 2026. |
| Licence | MIT or Apache-2.0: commercial use allowed. |
