# Performance tests for big notes, and the slow paths they found

## Why

Frederik asked for performance tests. Until now only drawing (the scene
cache and culling), the live stroke and scribbling out had a speed budget.
Every other path that grows with the note was measured on a note of
100 000 handwriting strokes (10 000 for saving and exporting), and three
were far too slow:

| Path | Before | After |
|---|---|---|
| Grouping handwriting into words (runs again after each change, for search and links) | 140 ms at 10 000 strokes, 540 ms at 20 000, 23 s at 100 000: quadratic | 7 ms at 20 000, 55 ms at 100 000 |
| Moving 2000 selected strokes in a 100 000 stroke note | 3.6 s | 20 ms |
| Undoing that move | 2.9 s | 10 ms |

## What changes

- `words::layout`: each line keeps its letter heights sorted, so their
  median is read instead of sorting a copy for every stroke against every
  line; stroke bounds are looked up by index instead of searched for.
  Same words as before (the word tests are unchanged and pass).
- `Document::next_ids`: a batch of new ids is checked against a set of the
  note's ids made once, instead of searching the note for each one. Gives
  exactly the ids `next_id` would, one by one.
- `Document::apply`: more than 16 strokes removed and added at once are
  done in one pass over the list instead of one by one. A unit test checks
  it matches one by one: ids, places, change list, undo and redo.
- New perf tests (`crates/bedrock-core/tests/perf.rs`, run by CI with
  `--ignored` in release):
  - `erasing_on_a_big_note`: stroke, partial and trim eraser swipes.
  - `moving_a_big_selection_on_a_big_note`: move, undo, redo, duplicate.
  - `word_layout_on_a_big_note`.
  - `saving_opening_and_exporting_a_big_note`: save, open, SVG export,
    minimap, sync check.
  - `eraser_and_lasso_hit_tests_on_a_big_note`.

## Found but left as they are (budgeted, so they cannot get worse)

- Undoing a long partial eraser swipe on 100 000 strokes: about 180 ms.
  Each eraser move is its own small step and each shifts the whole list.
- Saving a 10 000 stroke note takes about 0.7 s, and exporting it as SVG
  about 1.2 s.
- An eraser move on 100 000 strokes: 4 to 10 ms, which is up to a full
  120 Hz frame.

## Data formats

None change. New stroke ids are made exactly as before.
