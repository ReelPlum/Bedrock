# import-pdf

## ADDED Requirements

### Requirement: Strokes drawn as round pieces SHALL keep their line and widths

Pen apps draw a stroke as one fill of short overlapping pieces: GoodNotes
with flat ends, Apple Notes with round ends and a round dab at each pen
sample, each piece's outline starting anywhere. Each stroke SHALL follow
the middle of its pieces without crossing from side to side, SHALL be
drawn as wide as the PDF draws it at each point, and SHALL NOT be thinned
by taper or speed or smoothed as if its points were screen pixels.

#### Scenario: An Apple Notes stroke (regression)
- **GIVEN** a stroke drawn as round-ended pieces with dabs, thin at its ends and wider in the middle
- **WHEN** it is imported
- **THEN** every point lies on the pen's line, the stroke runs from end to end, the brush is as wide as the widest point and the ends are drawn narrow, with no taper or speed thinning and exact-point smoothing
<!-- test: pdf_strokes_drawn_as_round_pieces_keep_their_line_and_widths -->
