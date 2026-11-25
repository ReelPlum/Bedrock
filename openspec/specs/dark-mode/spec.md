# dark-mode Specification

## Purpose

The chrome (toolbar, menus, panels, library) follows the system's light or
dark setting, or Obsidian's theme inside Obsidian. The page itself, its
paper and its ink, never changes, so notes look the same everywhere. The
background is in `openspec/changes/archive/2026-11-25-add-dark-mode/`.

## Requirements

### Requirement: The chrome SHALL follow the system's light or dark setting

#### Scenario: A dark system
- **GIVEN** the system set to dark
- **WHEN** the app opens and a line is drawn
- **THEN** the toolbar and the other chrome are dark with light text, native controls are dark (`color-scheme: dark`), and the paper is the same colour as in light mode with the ink drawn on it as before
<!-- test-js: apps/web/tests/dark-mode.test.mjs :: the chrome follows the system dark setting, and the page stays white -->

#### Scenario: The minimap
- **GIVEN** dark mode
- **WHEN** the minimap shows the page
- **THEN** its frame is dark and its picture of the page keeps the paper colour, so black ink stays visible
<!-- test-js: apps/web/tests/dark-mode.test.mjs :: the minimap keeps the paper colour inside its dark frame -->

#### Scenario: Panels with their own styles
- **GIVEN** the launch gate or the report panel, which bring their own styles
- **WHEN** the chrome is dark, by the system or by a host
- **THEN** they are dark too, by the same rule as the rest
<!-- test-js: apps/web/tests/dark-mode.test.mjs :: panels with their own styles go dark the same way -->
<!-- test-js: apps/web/tests/dark-mode.test.mjs :: the dark colours for the system and for a host are the same -->

### Requirement: A host's theme SHALL win over the system's

A host (the Obsidian plugin) says its theme with `data-theme="light"` or
`"dark"` on the page's `<html>`; without it the system decides.

#### Scenario: Obsidian light on a dark system, and the other way round
- **GIVEN** a page with the system dark
- **WHEN** the host sets `data-theme="light"`, then `"dark"`; and on a light system sets `"dark"`
- **THEN** the chrome is light, then dark at once without a reload; and dark on the light system
<!-- test-js: apps/web/tests/dark-mode.test.mjs :: a host can say light or dark over the system setting (Obsidian theme) -->

#### Scenario: Obsidian's theme
- **GIVEN** Obsidian dark (`theme-dark` on its `<body>`)
- **WHEN** a note opens, and when Obsidian's theme changes while it is open
- **THEN** the canvas's page is written with `data-theme="dark"` before it paints, and every open canvas and the launch gate get the new theme when it changes
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the canvas's chrome follows Obsidian's theme, set before the page paints and changed live -->

### Requirement: Text on the chrome SHALL have accessible contrast

#### Scenario: Both themes
- **GIVEN** light and dark
- **WHEN** the chrome's text colours are measured against what they sit on (the see-through chrome over the white page, the loading screen, text boxes, the chosen tool, filled buttons, toasts)
- **THEN** each is at least 4.5:1 (WCAG 2.2 AA)
<!-- test-js: apps/web/tests/dark-mode.test.mjs :: text on the chrome has accessible contrast in light and dark -->

## Open source used

None: CSS custom properties and `prefers-color-scheme`. theme-change and
next-themes (both MIT) only toggle and store a theme, which Bedrock does not
need; `light-dark()` needs Safari 17.5. See the change's proposal.
