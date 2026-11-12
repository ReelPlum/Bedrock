# lasso-selection Specification

## ADDED Requirements

### Requirement: A lasso selection SHALL be duplicable, and the copy SHALL become the selection

Duplicate (in the selection's menu, or ⌘/Ctrl+D with the lasso) SHALL copy
every selected stroke, picture and text box 24 css px down and to the right,
on top of everything, as one undo step. The copy SHALL become the selection,
with its box, and the lasso SHALL be the tool, so the next drag moves the copy.

#### Scenario: Duplicate strokes and a picture from the menu, then drag the copy
- **GIVEN** a stroke and a picture selected with the lasso
- **WHEN** the writer holds the selection and taps Duplicate
- **THEN** there are two of each, the copies are selected 24 css px down and to the right, a drag moves the copies and leaves the originals, the copied picture shares its file, and undo takes it all back
<!-- test-js: apps/web/tests/app.test.mjs :: lasso: duplicate strokes and a picture from the selection menu; the copy is selected and drags away, one undo -->

#### Scenario: The copy is offset the same on screen at any zoom
- **GIVEN** a selection while zoomed in 2×
- **WHEN** it is duplicated
- **THEN** the copy is 12 world units (24 css px) away, selected, and dragging it moves the copy only; two undos leave the original alone
<!-- test: duplicate_selects_the_copy_offset_so_it_can_be_dragged_away -->

#### Scenario: A copied word reads, links and groups like the original
- **GIVEN** a word that was read, linked, made one word and said to be maths
- **WHEN** its strokes are duplicated
- **THEN** the copy has the same text, link, grouping and kind; a link that also covers ink that was not copied stays only on the original
<!-- test: duplicating_copies_on_top_with_text_link_and_group_and_one_undo -->

#### Scenario: Nothing selected
- **GIVEN** no selection
- **WHEN** Duplicate is asked for
- **THEN** nothing changes
<!-- test: duplicate_with_nothing_selected_does_nothing -->

### Requirement: Drawing a new loop, drawing or erasing SHALL let go of the selection

Dragging inside the selection's box SHALL move it. Starting a loop outside
it, or drawing or erasing with any pen, SHALL clear the selection.

#### Scenario: A new loop elsewhere lets go of a duplicate
- **GIVEN** a selected copy
- **WHEN** the writer starts a loop outside its box
- **THEN** nothing is selected
<!-- test-js: apps/web/tests/app.test.mjs :: lasso: duplicate strokes and a picture from the selection menu; the copy is selected and drags away, one undo -->

#### Scenario: A pen lets go of a selection made from a word's menu
- **GIVEN** a word selected while the pen is the tool
- **WHEN** the writer draws or erases
- **THEN** nothing is selected, and the pen still draws
<!-- test: drawing_with_a_pen_lets_go_of_the_selection -->
