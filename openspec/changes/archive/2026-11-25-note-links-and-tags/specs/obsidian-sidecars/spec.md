# obsidian-sidecars Specification

## ADDED Requirements

### Requirement: A sidecar SHALL carry the note's tags and the links of the whole note

#### Scenario: Tags and note links in the sidecar
- **GIVEN** a note with tags, a note link and a linked word
- **WHEN** its sidecar (index note) is written
- **THEN** the front matter says `tags: [bedrock, <the note's tags>]`, with only real tags, each once, quoted where YAML would misread them, and `## Links` lists the note link before the word's link
- **AND** a damaged tag list costs the tags and nothing else
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the index note carries the note's tags and the links of the whole note -->

#### Scenario: Sidecars from before tags
- **GIVEN** an index note written before tags existed, and the note it was written for
- **WHEN** the note is indexed again, and the old index note is opened
- **THEN** the index note is byte for byte the same, and the old one still names its note
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: index notes from before tags: an untagged note indexes the same, and old index notes still open their note -->
