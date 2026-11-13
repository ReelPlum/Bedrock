# toolbar-and-settings Specification

## Purpose
The tools and their settings: choosing tools, size and colour presets, where
the toolbar sits, and the main menu. These are device preferences kept in
local storage, not part of any note.

## Requirements

### Requirement: Tools SHALL be quick to switch

#### Scenario: Tapping the active tool again
- **GIVEN** the pen was used before the eraser
- **WHEN** the active eraser is tapped again
- **THEN** the pen is chosen again
<!-- test-js: apps/web/tests/app.test.mjs :: tapping the active tool again jumps back to the previous tool -->

### Requirement: Size and colour presets SHALL be kept per device

#### Scenario: Size presets
- **GIVEN** a brush
- **WHEN** one of its three size presets is picked and the slider moved
- **THEN** that preset changes, and picking it again brings back the edited size
<!-- test-js: apps/web/tests/app.test.mjs :: three size presets per brush; the slider edits the selected one -->

#### Scenario: Colour presets
- **GIVEN** the colour presets
- **WHEN** a colour is added and one deleted, and the page reloaded
- **THEN** the presets are as left
<!-- test: parse_and_format -->
<!-- test-js: apps/web/tests/app.test.mjs :: colour presets can be added and deleted, and are remembered -->

#### Scenario: The + opens the colour picker
- **GIVEN** the dashed + after the colour presets (the only way to pick a new colour; there is no separate colour wheel)
- **WHEN** it is tapped and a colour chosen in the system colour picker
- **THEN** the brush takes that colour as it is chosen, and when the picker closes it is added as a new preset and selected; a colour already in the presets is only selected, and closing the picker without choosing adds nothing
<!-- test-js: apps/web/tests/app.test.mjs :: the + opens the colour picker and adds the chosen colour; there is no colour wheel -->

#### Scenario: One opening of the picker makes one swatch
- **GIVEN** the colour picker opened from the +
- **WHEN** the colour is moved around many times (Safari reports every move as a finished choice)
- **THEN** no swatch is added while it is open, and exactly one is added when it closes; if the picker is left open and still, the swatch appears and later moves in that opening change it rather than add more
<!-- test-js: apps/web/tests/app.test.mjs :: bug: the colour picker adds one swatch when it closes, not one per move -->

#### Scenario: The + keeps its shape
- **GIVEN** a toolbar full of colours, docked at the bottom of a narrow screen or at the side
- **THEN** the + stays a circle the size of the other swatches
<!-- test-js: apps/web/tests/app.test.mjs :: bug: the + stays a circle when the toolbar is full -->

### Requirement: The toolbar and menu SHALL fit the screen

#### Scenario: Docking the toolbar
- **GIVEN** the toolbar
- **WHEN** it is docked to the left edge and the page reloaded
- **THEN** it is on the left
<!-- test-js: apps/web/tests/app.test.mjs :: the toolbar can be docked to any edge and stays there -->

#### Scenario: A short screen
- **GIVEN** a screen shorter than the main menu
- **WHEN** the menu is opened
- **THEN** it ends on screen and scrolls to its last item
<!-- test-js: apps/web/tests/app.test.mjs :: the main menu fits a short screen and scrolls -->
