# obsidian-plugin Specification

## ADDED Requirements

### Requirement: The link picker SHALL find the words of notes in every format version

#### Scenario: A note with its samples in points.bin
- **GIVEN** another Bedrock note saved as format version 2 (samples in `points.bin`), or an older one with every sample in `note.json`, or one that mixes both
- **WHEN** it is opened in the link picker
- **THEN** its words are marked in the same places either way, and a damaged `points.bin` marks no words instead of failing
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the link picker finds the words of notes with their samples in points.bin, and of older notes -->
<!-- test-js: apps/obsidian/tests/host.test.mjs :: the link picker opens another Bedrock note to link one of its words, or the whole note -->
