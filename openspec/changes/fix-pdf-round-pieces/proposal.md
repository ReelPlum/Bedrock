# Read PDF strokes drawn as round pieces correctly

## Why

Frederik imported a lecture written in Apple Notes ("Forelæsning 22").
Every stroke zigzagged from one side of its outline to the other, so lines
looked joined up and scribbled, all lines were thinner than drawn, and small
writing was smoothed out of shape. Apple shows the same PDF correctly, so
the ink is all there.

Apple Notes draws a stroke as one fill of many short capsules (round ends
drawn with curves), one per stretch between pen samples, with a round dab
at each sample, each capsule's outline starting at an arbitrary corner. The
importer assumed GoodNotes's four-cornered pieces, which go out along one
edge and back along the other, and took the first half of each outline as
the line: on a capsule that half crosses from one side to the other. It
also gave each stroke one width with the pen's normal pressure, taper and
speed thinning (thinner than drawn), and the smoothing meant for whole
screen pixels, which at a PDF's scale is larger than a letter's strokes.

## What changes

- Each piece's two ends are found along its longest direction; the line is
  halfway between its two sides; its width is measured across its middle.
  Round ends are cut off where pieces meet, a dab is a point, the pieces
  are turned to follow on from each other, and kinks where they meet are
  evened out.
- Curves in paths are followed with six straight pieces instead of two.
- The brush is as wide as the stroke's widest point; each point's pressure
  gives the width drawn there. Imported strokes have no taper or speed
  thinning, and are smoothed as exact points (`input_scale` 0.05).
- An imported highlighter is given a quarter of the width, since a
  highlighter draws four times its size.
- Regression test `pdf_strokes_drawn_as_round_pieces_keep_their_line_and_widths`.

## Data formats

None change. Imported strokes use fields every stroke already has: brush
`pressure`, `speed`, `taper_start`, `taper_end`, per-point `pressure`, and
`input_scale`.

## Open source used

None added. Bedrock's own PDF reader (`pdf.rs`) stays: PDF libraries such
as `lopdf` or `pdf` hand back the same path operators, and none of them
turns a pen app's filled outlines back into centre lines with widths, which
is the part this fixes.
