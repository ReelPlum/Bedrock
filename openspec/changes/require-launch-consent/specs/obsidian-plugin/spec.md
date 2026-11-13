# obsidian-plugin

## ADDED Requirements

### Requirement: The plugin SHALL ask for the invite code and consent when Obsidian starts

While the web app's launch gate is required, the plugin SHALL, once
Obsidian's layout is ready, show the web app's gate (`welcome/index.html`
from the unpacked app) in an Obsidian window, before any note is opened,
and close it when the person agrees. It SHALL first ask a hidden copy of
the page whether the gate is needed, and show nothing when it is not. A
note opened while consent is missing shows the gate over its canvas.

#### Scenario: At start
- **GIVEN** no consent
- **WHEN** Obsidian starts with the plugin
- **THEN** a window with the gate opens, and closes once the person has agreed, leaving the consent and "Send every word" stored for the notes
<!-- test-js: apps/obsidian/tests/host.test.mjs :: at start, the plugin asks for the invite code and consent in a window, and closes it once agreed -->

#### Scenario: Already agreed
- **GIVEN** consent to the current text
- **WHEN** Obsidian starts with the plugin
- **THEN** no window is shown
<!-- test-js: apps/obsidian/tests/host.test.mjs :: at start, nothing is shown when consent is already given -->

#### Scenario: The welcome page ships with the plugin
- **GIVEN** the built plugin
- **WHEN** it unpacks the web app
- **THEN** the welcome page is there, next to the app it is a part of
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: registers the .bedrock view, commands and settings, and unpacks the web app -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the welcome page address sits next to the web app -->
