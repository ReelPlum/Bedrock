# obsidian-plugin Specification

## ADDED Requirements

### Requirement: Writing in Obsidian SHALL cost Obsidian's main thread little

The canvas shares Obsidian's main thread, so work done for each save there
holds up the pen.

#### Scenario: The index note waits for a pause in writing
- **GIVEN** a note being written in the view
- **WHEN** the canvas saves again and again while the writer keeps writing
- **THEN** every save reaches the file at once, the index note is written once writing has paused (2.5 s) with the latest text, a waiting index note is written as soon as the view closes, and nothing is written when nothing is waiting
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: while the writer keeps writing, the index note waits for a pause and is written once -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: saves hand the file to Obsidian without a copy, and the index note waits for writing to pause -->

#### Scenario: A saved file is handed over, not copied
- **GIVEN** the canvas saving its note
- **WHEN** it sends the file to the plugin
- **THEN** the file's buffer is transferred, and the session writes it to the vault without another copy
<!-- test-js: apps/obsidian/tests/host.test.mjs :: saves hand the file to Obsidian without a copy, and the index note waits for writing to pause -->

#### Scenario: The WebAssembly is compiled once while the plugin runs
- **GIVEN** the plugin running, with notes opened one after another
- **WHEN** each canvas starts
- **THEN** it asks the plugin for the compiled WebAssembly (`wasm`) and gets the module the plugin compiled soon after Obsidian started (or for the first note), compiles nothing itself, and passes it on to its save worker; with no module it compiles its own; a reloaded plugin compiles afresh
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the WebAssembly is compiled once while the plugin runs, and the session hands it to each canvas -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the WebAssembly is compiled once for all notes; each canvas and its save worker reuse it -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: soon after Obsidian starts, the WebAssembly is compiled once, ready for the first note -->
