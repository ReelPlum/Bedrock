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

- Each piece's two ends are found along its longest direction. For a
  round-ended piece, each point along one side gives the largest round dab
  inside the piece that touches it there: its centre is on the line and its
  size is the width there, and on a round end every point gives the end's
  own dab, centred where the pen was. So pieces meet exactly, with no jump
  back or bulge (Frederik saw letters come in lumpy and pointy where pieces
  met). Four-cornered pieces take the line halfway between their sides. A
  dab is a point, the pieces are turned to follow on from each other, and
  small kinks where they meet are evened out. Points that add nothing (within
  0.01) are left out, so notes stay as small as before.
- Curves in paths are followed with six straight pieces instead of two.
- The brush is as wide as the stroke's widest point; each point's pressure
  gives the width drawn there. Imported strokes have no taper or speed
  thinning, and are smoothed as exact points (`input_scale` 0.05).
- An imported highlighter is given a quarter of the width, since a
  highlighter draws four times its size.
- The SVG export keeps the round ends of thin lines (it dropped most of
  their points as too close together) and draws a line that turns back on
  itself in parts with round ends (one outline cannot go round the turn,
  and made a spike or a cut).
- Regression tests `pdf_strokes_drawn_as_round_pieces_keep_their_line_and_widths`,
  `pdf_strokes_in_long_round_pieces_are_smooth_where_the_pieces_meet`,
  `svg_outlines_of_thin_lines_keep_round_ends` and
  `svg_outlines_turn_back_without_spikes`.

## Data formats

None change. Imported strokes use fields every stroke already has: brush
`pressure`, `speed`, `taper_start`, `taper_end`, per-point `pressure`, and
`input_scale`. The SVG export draws the same lines with more exact
outlines; the note it embeds and how it is read back do not change.

## Open source used

None added. Bedrock's own PDF reader (`pdf.rs`) stays: PDF libraries such
as `lopdf` or `pdf` hand back the same path operators, and none of them
turns a pen app's filled outlines back into centre lines with widths, which
is the part this fixes.
