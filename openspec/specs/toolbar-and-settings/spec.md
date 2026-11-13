# toolbar-and-settings Specification

## Purpose
The tools and their settings: choosing tools, size and colour presets, where
the toolbar and the minimap sit, and the main menu. These are device
preferences kept in local storage, not part of any note.

The layout follows the hands: the writing palm rests below and to the side
of the Pencil, and the other hand holds the iPad at the opposite edge. So
the toolbar starts on the edge away from the writing hand, and both it and
the minimap can be dragged to wherever the person holds the iPad. The
design study (three directions and why this one) is the "Bedrock Canvas
Directions" page made in the project thread "Design the main canvas,
minimap and toolbar".

## Requirements

### Requirement: Tools SHALL be quick to switch

#### Scenario: Tapping the active tool again
- **GIVEN** the pen was used before the eraser
- **WHEN** the active eraser is tapped again
- **THEN** the pen is chosen again
<!-- test-js: apps/web/tests/app.test.mjs :: tapping the active tool again jumps back to the previous tool -->

#### Scenario: The pen family shares one slot
- **GIVEN** the pen, pencil, fountain pen and marker, which share one toolbar slot showing the pen used last (with a small corner mark)
- **WHEN** the active pen in that slot is tapped
- **THEN** all four show in its place; picking one selects it, closes them and puts it in the slot, which keeps it while another tool is active; the keys 1 to 4 still pick each directly
<!-- test-js: apps/web/tests/app.test.mjs :: the pen family shares one slot; tapping the active pen shows them all -->

### Requirement: Size and colour presets SHALL be kept per device

#### Scenario: Size presets
- **GIVEN** a brush, with three size presets on the toolbar and no size slider there
- **WHEN** a preset is held, which picks it and opens tool settings, and the size slider there moved
- **THEN** that preset changes, and picking it again brings back the edited size
<!-- test-js: apps/web/tests/app.test.mjs :: three size presets per brush; holding one opens the slider, which edits it -->

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

### Requirement: The toolbar and minimap SHALL go where the hands are

#### Scenario: The first layout
- **GIVEN** a writer who chose their writing hand on the welcome screen, or did not choose one (taken as right-handed)
- **WHEN** Bedrock opens with no layout saved
- **THEN** the toolbar is upright on the edge away from the writing hand, with undo and redo at its end, and the title bar and the minimap are in the top corner on the other side
<!-- test-js: apps/web/tests/app.test.mjs :: the toolbar starts on the side away from the writing hand, with the title and minimap on the other side -->
<!-- test-js: apps/web/tests/layout.test.mjs :: the toolbar starts on the edge away from the writing hand -->

#### Scenario: Docking the toolbar
- **GIVEN** the toolbar
- **WHEN** it is dragged by its grip (with a finger or the mouse, not the Pencil) and let go, or an edge is chosen in the menu, and the page reloaded
- **THEN** it lies along the nearest edge, turned to fit it, with its middle where it was let go along that edge (the middle when chosen in the menu), kept on screen
<!-- test-js: apps/web/tests/app.test.mjs :: the toolbar can be docked to any edge, where it is let go, and stays there -->
<!-- test-js: apps/web/tests/layout.test.mjs :: a dropped toolbar lands on the nearest edge, where it was let go -->

#### Scenario: Moving the minimap
- **GIVEN** the minimap
- **WHEN** the strip under the map (grip dots, zoom level, Fit) is dragged with a finger or the mouse and let go
- **THEN** the minimap moves and settles against the nearest edge, or into a corner when near one, and stays there after a reload; dragging the map itself still moves the camera, a short tap on Fit still fits, and a minimap that would cover the toolbar or the title bar steps aside
<!-- test-js: apps/web/tests/app.test.mjs :: the minimap moves when dragged by the strip under it, stays there, and steps aside from the toolbar; dragging the map moves the camera -->
<!-- test-js: apps/web/tests/layout.test.mjs :: a dropped minimap settles against the nearest edge, or into a corner -->
<!-- test-js: apps/web/tests/layout.test.mjs :: the minimap steps aside instead of covering the toolbar -->

#### Scenario: Portrait and landscape
- **GIVEN** the toolbar moved in landscape
- **WHEN** the iPad turns to portrait and back
- **THEN** portrait has its own places (from the first layout until moved) and landscape gets its own back
<!-- test-js: apps/web/tests/app.test.mjs :: the toolbar and minimap keep separate places for portrait and landscape -->
<!-- test-js: apps/web/tests/layout.test.mjs :: layouts are kept per orientation and broken values are ignored -->

#### Scenario: Settings from before layouts
- **GIVEN** settings saved by an earlier version, with only the toolbar's edge (`dock`)
- **WHEN** Bedrock opens
- **THEN** the toolbar stays on that edge, centred, in both orientations
<!-- test-js: apps/web/tests/layout.test.mjs :: settings saved before layouts existed keep their toolbar edge -->

#### Scenario: Reset
- **WHEN** "Reset toolbar and minimap positions" is chosen in the menu
- **THEN** both go back to the first layout
<!-- test-js: apps/web/tests/app.test.mjs :: the minimap moves when dragged by the strip under it, stays there, and steps aside from the toolbar; dragging the map moves the camera -->

#### Scenario: A resting palm
- **GIVEN** the Pencil touching the page
- **WHEN** a palm touches the toolbar, the title bar or the minimap, until 0.4 s after the Pencil lifts
- **THEN** nothing there is pressed
<!-- test-js: apps/web/tests/app.test.mjs :: a palm on the toolbar while the Pencil is on the glass does nothing -->

#### Scenario: The minimap rests
- **GIVEN** the minimap shown
- **WHEN** the view has not moved for 3 seconds
- **THEN** it fades back, and comes back fully as soon as the view moves or a finger or pointer reaches it
<!-- test-js: apps/web/tests/app.test.mjs :: the minimap fades back while the view is still and comes back when it moves -->

### Requirement: The toolbar and menu SHALL fit the screen

#### Scenario: A short screen
- **GIVEN** a screen shorter than the main menu
- **WHEN** the menu is opened
- **THEN** it ends on screen and scrolls to its last item
<!-- test-js: apps/web/tests/app.test.mjs :: the main menu fits a short screen and scrolls -->

## Open source used
None. The layout is a few lines of geometry (`apps/web/src/layout.js`):
nearest edge, a share along it, corner snapping and stepping aside. Drag and
snap libraries (interact.js, Draggable from GSAP, dnd-kit) were considered;
they solve free dragging and sortable lists, and would add a dependency that
still needs this same edge and corner logic on top, so building it is
smaller and clearer.
