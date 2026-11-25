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

### Requirement: The selection menu SHALL recolour the selected strokes with the writer's swatches

Color (in the selection's menu, when it holds strokes) SHALL show the
writer's swatches and the + for a new colour. Choosing a colour SHALL give
it to every selected stroke as one undo step, leave pictures and the brush's
own colour alone, and keep the strokes selected.

#### Scenario: Recolour with a swatch
- **GIVEN** two strokes, one of them selected with the lasso
- **WHEN** the writer holds the selection, taps Color and taps the red swatch
- **THEN** the menu shows the same swatches as the toolbar with the selection's colour marked, and the + inside it; after the tap the menu closes, only the selected stroke is red and still selected, the pen keeps its colour, and one undo brings the old colour back
<!-- test-js: apps/web/tests/app.test.mjs :: lasso: Color in the selection menu shows the swatches and the +, and gives the colour to the selected strokes in one undo -->

#### Scenario: Recolour with a new colour from the +
- **GIVEN** a selected stroke and its menu's Color view
- **WHEN** the writer opens the colour picker from the + and moves it around before closing it
- **THEN** nothing changes while it is open; when it closes, one swatch is added (in the toolbar too) and the stroke takes that colour
<!-- test-js: apps/web/tests/app.test.mjs :: lasso: Color in the selection menu shows the swatches and the +, and gives the colour to the selected strokes in one undo -->

#### Scenario: Highlighter ink gets the highlighter swatches
- **GIVEN** a selection of highlighter strokes only
- **WHEN** Color is tapped
- **THEN** the highlighter swatches are shown
<!-- test-js: apps/web/tests/app.test.mjs :: lasso: Color in the selection menu shows the swatches and the +, and gives the colour to the selected strokes in one undo -->

#### Scenario: Recolouring keeps what was said about the ink
- **GIVEN** linked, grouped strokes and one stroke that is not selected
- **WHEN** the linked strokes are recoloured
- **THEN** they keep their place in the stacking order, link and group, the other stroke is unchanged, recolouring again to the same colour adds no undo step, and undo and redo swap the colours back and forth
<!-- test: recoloring_keeps_place_text_link_and_group_in_one_undo -->

#### Scenario: Pictures and an empty selection
- **GIVEN** a stroke and a picture selected
- **WHEN** they are recoloured
- **THEN** only the stroke changes, both stay selected and nothing moves; with nothing selected nothing changes
<!-- test: recolor_selection_changes_only_selected_strokes_and_keeps_them_selected -->
