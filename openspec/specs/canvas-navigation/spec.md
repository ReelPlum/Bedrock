# canvas-navigation Specification

## Purpose
Moving around the page and the touch gestures that are not ink: panning,
pinch zoom, the bounded page, paper patterns, the minimap, multi-finger taps
for undo and redo, and palm rejection.

## Requirements

### Requirement: Fingers SHALL move the page and the pen SHALL draw

#### Scenario: One finger pans, a palm is ignored
- **GIVEN** the pen tool
- **WHEN** a finger drags, or a palm rests while the pen writes
- **THEN** the finger pans without drawing, the palm neither pans nor draws, and only the pen leaves ink
<!-- test: one_finger_pans_and_does_not_draw -->
<!-- test: palm_is_ignored_while_pen_is_down -->
<!-- test: pan_moves_content_with_finger -->
<!-- test-js: apps/web/tests/app.test.mjs :: fingers pan the canvas and do not draw; a resting palm is ignored -->

#### Scenario: Finger drawing mode
- **GIVEN** finger drawing is turned on
- **WHEN** one finger drags
- **THEN** it draws
<!-- test: finger_drawing_mode_draws_with_one_finger -->

#### Scenario: The pen cancels a finger stroke
- **GIVEN** a finger stroke in progress
- **WHEN** the pen touches down, or the system cancels the touch
- **THEN** the finger stroke is discarded
<!-- test: pen_cancels_finger_stroke -->
<!-- test: cancel_discards_stroke -->

#### Scenario: Pinch zoom
- **GIVEN** two fingers on the page
- **WHEN** they pinch
- **THEN** the page zooms around the fingers, within 25% to 250%, on a bounded page
<!-- test: pinch_zooms_around_fingers -->
<!-- test: zoom_keeps_anchor_fixed -->
<!-- test: zoom_and_position_are_bounded -->
<!-- test: roundtrip -->
<!-- test-js: apps/web/tests/app.test.mjs :: pinch with two fingers zooms -->

### Requirement: Multi-finger taps SHALL undo and redo

#### Scenario: Two fingers undo, three redo
- **GIVEN** some strokes
- **WHEN** two fingers double tap, then three fingers double tap
- **THEN** the last stroke is undone, then redone; single taps, slow holds, mixed or far-apart taps do nothing
<!-- test: two_finger_double_tap_undoes -->
<!-- test: three_finger_double_tap_redoes -->
<!-- test: mixed_taps_do_not_count_as_double -->
<!-- test: slow_two_finger_hold_does_not_undo -->
<!-- test: two_finger_taps_too_far_apart_do_not_undo -->
<!-- test-js: apps/web/tests/app.test.mjs :: two-finger double tap undoes and three-finger double tap redoes; single taps do nothing -->

#### Scenario: One finger double tap toggles the eraser
- **GIVEN** the pen or lasso tool
- **WHEN** one finger double taps
- **THEN** the app is asked to switch to the eraser and back, and the taps draw nothing
<!-- test: one_finger_double_tap_asks_to_toggle_the_eraser -->
<!-- test-js: apps/web/tests/app.test.mjs :: a lassoed paragraph becomes one link but stays separate words; "Not a word" is never read; a one-finger double tap toggles the eraser -->

#### Scenario: Undo history
- **GIVEN** strokes added, replaced and grouped into one gesture
- **WHEN** undo and redo are used
- **THEN** each gesture is one step, z-order is kept, and a new action clears redo
<!-- test: add_undo_redo_with_change_feed -->
<!-- test: grouped_changes_undo_together -->
<!-- test: new_action_clears_redo -->
<!-- test: replace_keeps_z_order_and_undoes -->
<!-- test: revision_increases -->
<!-- test: ids_are_unique_and_deterministic_per_seed -->

### Requirement: The paper SHALL stay fixed to the page

#### Scenario: Grid paper while zooming
- **GIVEN** grid paper
- **WHEN** the page is zoomed to 100%, 150% and 225%
- **THEN** the grid lines are 32, 48 and 72 pixels apart, and the paper is light
<!-- test-js: apps/web/tests/app.test.mjs :: grid paper stays fixed to the page when zooming -->
<!-- test-js: apps/web/tests/app.test.mjs :: starts without errors and renders the paper -->

### Requirement: A new note SHALL start on grid paper, and a note SHALL keep its own paper

New notes start on grid paper; in Obsidian the plugin's "Paper for new
notes" setting chooses it instead (see `obsidian-plugin`). The paper is
saved in the note (`paper`, see `note-format`), so changing the default
never changes a note that already exists. A file that names no paper still
opens with dots, as it did before grid became the default.

#### Scenario: New and existing notes
- **GIVEN** a note saved on dots paper
- **WHEN** the app starts with no note, a new note is made, and the dots note is opened again
- **THEN** the first and the new note are on grid paper, and the dots note is on dots
<!-- test-js: apps/web/tests/folders.test.mjs :: a new note starts on grid paper; a note that is opened again keeps its own paper -->

#### Scenario: A file that names no paper
- **GIVEN** a note file without `paper`
- **WHEN** it is opened
- **THEN** it is on dots paper, as before
<!-- test: a_note_that_names_no_paper_opens_with_dots -->

### Requirement: The minimap SHALL show the drawing and the view and move the camera

#### Scenario: Minimap
- **GIVEN** ink on the page
- **WHEN** the minimap is shown, the view moves, the minimap is tapped, or "fit" is chosen
- **THEN** it shows the ink and the view, grows with them and shrinks back, shows the zoom, moves the camera without drawing, and fit shows all ink
<!-- test: region_follows_ink_and_view_and_shrinks_back -->
<!-- test: polylines_are_16_bit_simplified_and_keep_ends -->
<!-- test: fit_shows_rect -->
<!-- test: reveal_centres_a_rect_and_keeps_the_zoom_when_it_can -->
<!-- test-js: apps/web/tests/app.test.mjs :: the minimap shows the drawing and the view, follows them, shows zoom, fits, and moves the camera -->

#### Scenario: Pictures and text boxes on the minimap
- **GIVEN** pictures and text boxes on the page, with ink over them
- **WHEN** the minimap is shown
- **THEN** each shows in its place and size, under the ink as on the page, from a small copy made once (at most 256 px on its long side); until that copy is ready it shows as a light card
<!-- test-js: apps/web/tests/app.test.mjs :: the minimap shows pictures and text boxes under the ink -->
