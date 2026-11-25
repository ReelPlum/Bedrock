# saving-and-opening Specification

## ADDED Requirements

### Requirement: A pen SHALL write on the paper while a note opens

While the app starts and while a note opens, the canvas SHALL be covered by
the paper with a single-colour pen (the ink colour) writing a loopy line,
hopping at its end and starting again, and "Opening note…" for screen
readers. It SHALL show from the first paint, before the scripts and
WebAssembly have loaded, wait a moment before fading in so a quick open
shows nothing, and go once the note is open. The nib SHALL stay on the end
of the line as it is drawn. With reduced motion nothing SHALL move; the
short wait before it shows SHALL still apply.

#### Scenario: Starting up
- **GIVEN** the app's WebAssembly is slow to arrive
- **WHEN** the page loads
- **THEN** the pen covers the canvas and writes, with "Opening note…" as a status; once the note is open it goes
<!-- test-js: apps/web/tests/note-loading.test.mjs :: the pen writes while the app starts, and goes once the note is open -->

#### Scenario: Opening a note that takes a moment
- **GIVEN** a saved note that takes 700 ms to read
- **WHEN** it is opened
- **THEN** the pen shows while it opens and goes at once when it has, so the ink shows straight away; it only fades in after a moment, so a note that opens at once shows nothing
<!-- test-js: apps/web/tests/note-loading.test.mjs :: a note that takes a moment to open shows the pen while it opens, and its ink as soon as it has; a quick one shows nothing -->

#### Scenario: The nib stays on the line
- **GIVEN** the pen is writing
- **WHEN** it is looked at any moment while it writes
- **THEN** the nib is on the end of the drawn line
<!-- test-js: apps/web/tests/note-loading.test.mjs :: the nib stays on the end of the line while the pen writes -->

#### Scenario: Reduced motion
- **GIVEN** the device asks for reduced motion
- **WHEN** a note opens
- **THEN** after the same short wait as with motion (so a quick open shows nothing and nothing flickers), the finished line is shown at once, without a fade, with the pen resting at its end, and nothing moves
<!-- test-js: apps/web/tests/note-loading.test.mjs :: with reduced motion the pen rests at the end of a finished line, still -->

#### Scenario: In Obsidian
- **GIVEN** the Obsidian plugin
- **WHEN** a note opens in a view, or a change made elsewhere reloads it
- **THEN** the pen is in the view's page from the start and shows while the note is reloaded
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the pen writes while a note opens in Obsidian, and while an outside change reloads it -->
