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
