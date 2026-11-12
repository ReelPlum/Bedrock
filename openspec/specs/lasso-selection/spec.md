# lasso-selection Specification

## Purpose
Selecting ink and pictures to act on them: drawing a lasso, moving what it
holds, the selection menu (one word, link, delete), and holding a stroke to
lift it with its menu, which blurs the rest of the page. Copying a selection
(Duplicate) is being added as a change to this capability.

## Requirements

### Requirement: A lasso SHALL select the strokes and pictures mostly inside it

#### Scenario: Drawing a lasso
- **GIVEN** two neighbouring words
- **WHEN** a loop is drawn around the first with the lasso tool
- **THEN** the loop is shown while drawing and is not ink, the first word is selected and outlined, and its neighbour is not
<!-- test: point_in_polygon -->
<!-- test: takes_strokes_mostly_inside -->
<!-- test: a_line_is_not_a_loop -->
<!-- test-js: apps/web/tests/app.test.mjs :: lasso: draw around ink to select it, drag to move it (text and link go along), hold it to make it one word, link it, delete it -->

#### Scenario: Moving a selection
- **GIVEN** a selected word with recognised text, a link and a word group
- **WHEN** it is dragged
- **THEN** it moves as one undo step, and its text, link and group go along through undo and redo
<!-- test: lasso_selects_and_drag_moves_as_one_undo_step -->
<!-- test: moving_strokes_keeps_their_text_link_and_group_through_undo -->

#### Scenario: Letting go of a selection
- **GIVEN** a selection
- **WHEN** the page outside it is tapped, or a drag is cancelled
- **THEN** the selection is cleared, and a cancelled drag moves nothing
<!-- test: tapping_outside_the_selection_clears_it_and_a_cancelled_drag_moves_nothing -->

#### Scenario: Deleting a selection
- **GIVEN** a selection
- **WHEN** Delete is chosen in its menu
- **THEN** its strokes are removed as one undo step
<!-- test: delete_selection -->

### Requirement: The selection menu SHALL make the selection one word or one link

#### Scenario: Make it one word
- **GIVEN** a selection the recogniser split into several words
- **WHEN** the selection is held and "one word" is chosen
- **THEN** holding moves nothing, the strokes are one word and it is read again; grouping takes strokes out of older groups
<!-- test: grouping_moves_strokes_out_of_older_groups -->
<!-- test: writers_groups_override_the_word_split -->
<!-- test-js: apps/web/tests/app.test.mjs :: lasso: draw around ink to select it, drag to move it (text and link go along), hold it to make it one word, link it, delete it -->

#### Scenario: A lassoed paragraph becomes one link
- **GIVEN** a lassoed paragraph of two words
- **WHEN** it is linked
- **THEN** it is one link but still two words, underlined word by word
<!-- test-js: apps/web/tests/app.test.mjs :: a lassoed paragraph becomes one link but stays separate words; "Not a word" is never read; a one-finger double tap toggles the eraser -->

### Requirement: Holding a stroke SHALL lift it and open its menu

The held stroke grows around its middle and casts a shadow, and the rest of
the page is blurred a little ("stroke menu blur"). The menu itself appears
without animating.

#### Scenario: Lifting a stroke
- **GIVEN** a stroke on the paper
- **WHEN** the pen holds still on it
- **THEN** it is drawn on the ink layer, grows around its middle and casts a drop shadow, the rest of the page is blurred, and the menu appears without animating
- **AND** closing the menu puts the stroke back at its own size and the page is sharp again
<!-- test: lifted_strokes_float_grown_around_their_middle -->
<!-- test-js: apps/web/tests/app.test.mjs :: holding a stroke lifts it: it grows around its middle and casts a shadow; its menu just appears -->
