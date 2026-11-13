# note-format

## ADDED Requirements

### Requirement: Lines in the SVG export SHALL keep their round ends and turns

A line in the SVG export SHALL end in a round end however thin it is, and
where it turns back on itself it SHALL be drawn round, with no spike or cut,
as it is on screen.

#### Scenario: A thin line keeps its round ends (regression)
- **GIVEN** a line 1 wide
- **WHEN** its SVG outline is made
- **THEN** past its last point the outline is a half circle of at least six points
<!-- test: svg_outlines_of_thin_lines_keep_round_ends -->

#### Scenario: A line that turns back is round at the turn (regression)
- **GIVEN** a line that goes out and comes back the same way
- **WHEN** its SVG outline is made
- **THEN** no point of the outline pokes out of the line, and the outline reaches half the width past the turn
<!-- test: svg_outlines_turn_back_without_spikes -->
