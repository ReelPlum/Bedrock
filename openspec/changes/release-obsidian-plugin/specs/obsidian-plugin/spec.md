# obsidian-plugin Specification

## ADDED Requirements

### Requirement: The plugin SHALL be released from this repository so BRAT and Obsidian can install it

#### Scenario: The manifest is at the repository root
- **GIVEN** the repository
- **WHEN** Obsidian or BRAT reads `manifest.json` at its root
- **THEN** it follows Obsidian's manifest rules and `versions.json` maps its version to its `minAppVersion`
<!-- test-js: apps/obsidian/tests/release.test.mjs :: manifest.json at the repository root follows Obsidian's rules and is listed in versions.json -->

#### Scenario: Tagging a version publishes it
- **GIVEN** a tag `0.2.0` equal to the manifest version, or a beta tag `0.2.0-beta.1`
- **WHEN** it is pushed
- **THEN** a GitHub release with that tag carries `main.js`, `manifest.json` (with the tag as its version) and `styles.css`, and a beta is a pre-release; a tag that is not the manifest version, or is not a plugin version, is refused before building
<!-- test-js: apps/obsidian/tests/release.test.mjs :: a release tag must be the manifest version; a beta tag gets its own version in the released manifest -->

#### Scenario: A broken manifest is not released
- **GIVEN** a manifest that breaks Obsidian's rules, or a version missing from `versions.json`
- **WHEN** a version is tagged
- **THEN** the release is refused and says why
<!-- test-js: apps/obsidian/tests/release.test.mjs :: a release is refused when the manifest breaks Obsidian's rules -->
