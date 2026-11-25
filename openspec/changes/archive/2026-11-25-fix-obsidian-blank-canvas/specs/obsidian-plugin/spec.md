# obsidian-plugin Specification

## ADDED Requirements

### Requirement: The plugin SHALL open .bedrock files and keep them safe

#### Scenario: The canvas loads no files (Obsidian refuses them)
- **GIVEN** Obsidian refuses every file request made from a page inside a view
- **WHEN** a note or the launch gate is opened
- **THEN** the page is written into the iframe with its stylesheet and scripts inline, its module, workers, WebAssembly and word list are handed over as `blob:` URLs, and the canvas starts, saves and reads the word list without one request
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the canvas starts inside Obsidian without loading a single file (Obsidian refuses them) -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the canvas pages are written with their files handed over as blob: URLs, never loaded by address -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: at start, the plugin asks for the invite code and consent in a window, and closes it once agreed -->

