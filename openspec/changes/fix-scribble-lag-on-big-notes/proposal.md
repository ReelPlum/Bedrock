# Keep scribbling out smooth on big notes

## Why

On notes with 1500+ strokes, scribbling out stuttered badly as soon as the
scribble was recognised over ink. Measured on a dense page of 1600 strokes
with a five second scribble (native, release; an iPad running the web app
is several times slower):

- While the pen is down, the strokes the scribble would erase are worked out
  again every 12 samples. Each time, every segment of the scribble was
  compared with every segment of each nearby stroke: about 3 ms per check,
  growing with the length of the scribble.
- The veil that fades that ink was tessellated again from scratch, every
  stroke of it, whenever one more stroke joined: about 11 ms each time.

Looking up the nearby strokes themselves was not the problem: checking every
stroke's stored bounds takes microseconds here (and about 0.7 ms on 100 000
strokes, see `ink-latency`).

## What changes

- `scribble::targets` puts the scribble's own segments in an R-tree
  (`rstar`) and, for each nearby stroke, looks only at the scribble segments
  near each of its segments. The cheap "mostly under the scribble" count now
  runs before the exact test. Result: about 0.25 ms per check. A test checks
  it erases exactly what the old full scan did, on 60 scribbles over dense
  random ink.
- `scene::Veil` keeps each faded stroke's mesh while the scribble lasts, so
  each stroke is tessellated once. When many strokes join at once (the
  moment a scribble is recognised) at most 600 samples are tessellated per
  frame and the rest fade in over the next few frames (under 1 ms each).
- Perf test `scribbling_out_on_a_big_note_stays_smooth` (CI runs it with
  the 100 000 stroke budget): each pen sample under 1.5 ms, each veil update
  under 2 ms, lifting the pen under 5 ms, on a 1600-stroke page.

## Data formats

None change.
