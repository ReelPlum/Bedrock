# import-pdf

## ADDED Requirements

### Requirement: Strokes drawn as round pieces SHALL keep their line and widths

Pen apps draw a stroke as one fill of short overlapping pieces: GoodNotes
with flat ends, Apple Notes with round ends and a round dab at each pen
sample, each piece's outline starting anywhere. Each stroke SHALL follow
the middle of its pieces without crossing from side to side, SHALL be
drawn as wide as the PDF draws it at each point, and SHALL NOT be thinned
by taper or speed or smoothed as if its points were screen pixels. Where
one piece meets the next, the line SHALL run on smoothly, without going
back or bulging: a piece's round ends are not part of the line.

#### Scenario: An Apple Notes stroke (regression)
- **GIVEN** a stroke drawn as round-ended pieces with dabs, thin at its ends and wider in the middle
- **WHEN** it is imported
- **THEN** every point lies on the pen's line, the stroke runs from end to end, the brush is as wide as the widest point and the ends are drawn narrow, with no taper or speed thinning and exact-point smoothing
<!-- test: pdf_strokes_drawn_as_round_pieces_keep_their_line_and_widths -->

#### Scenario: Long round pieces meet smoothly (regression)
- **GIVEN** a curved stroke drawn as round-ended pieces over several pen samples each, every other one outlined the other way round
- **WHEN** it is imported
- **THEN** every point lies within 0.05 of the pen's line, the line never goes back, each point is drawn within a tenth of the width the PDF drew there, and the stroke runs from end to end
<!-- test: pdf_strokes_in_long_round_pieces_are_smooth_where_the_pieces_meet -->
