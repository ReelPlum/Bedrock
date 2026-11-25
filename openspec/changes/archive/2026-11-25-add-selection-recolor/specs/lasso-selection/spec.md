# lasso-selection Specification

## ADDED Requirements

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
