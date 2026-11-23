# obsidian-plugin Specification

## MODIFIED Requirements

### Requirement: Search hits and links SHALL lead to the ink

#### Scenario: The iPad keyboard hides no text box
- **GIVEN** a word's menu, or any other text box, low in the view on an iPad
- **WHEN** the on-screen keyboard comes up (Obsidian sets `--keyboard-height` and fires `keyboardWillShow` without resizing the view) or the visible part of the window shrinks
- **THEN** the view tells the canvas how much of its bottom is hidden (`inset { bottom }`); the word menu moves above the keyboard, any other text box being typed in slides into sight with the page (`keep-in-view.js`), and both go back when the keyboard goes
<!-- test-js: apps/obsidian/tests/host.test.mjs :: bug: any text box being typed in slides into sight above the iPad keyboard, and back after -->
