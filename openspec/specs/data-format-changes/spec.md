# data-format-changes Specification

## Purpose
Bedrock's data outlives the app. This spec is the rule every change follows
when it touches stored or exchanged data, and the list of what counts.

A **data format** is anything written to disk or sent between programs:

| Format | Spec |
|---|---|
| Note files: `.bedrock` (`note.json`, `recognized.json`, `links.md`, `images/`, `preview.svg`), `.json`, `.svg` | `note-format`, `docs/note-format.md`, `docs/note.schema.json` |
| Markdown sidecars and Obsidian index notes; links to a word | `obsidian-sidecars`, `obsidian-plugin` |
| An exported library (ZIP of folders) | `obsidian-sidecars`, `library-folders` |
| The on-device library (IndexedDB `bedrock`) | `saving-and-opening`, `library-folders` |
| Training samples, the upload queue and their local storage | `training-data-sharing` |
| Training prompts (`GET /v1/prompts`, `bedrock.train.prompts`) | `training-pages` |
| Error reports (`bedrock-error-report`), `send-report`, the on-device log `bedrock.errors.v1` | `error-reporting` |
| Slow entries and automatic performance reports, `bedrock.perf.v1` | `performance` |
| The backend API, its storage and training data | Bedrock-Backend `openspec/specs/` |

## Requirements

### Requirement: A data format change SHALL be asked about, with its reason, before it is made

Before any change to a data format above is written, the person who owns
Bedrock SHALL be asked, with what changes, why, and how old data keeps
working; the change waits for their approval. A proposal
(`openspec/changes/<change>/proposal.md`) for such a change SHALL have a
"Data format change" section saying this, and SHALL record the approval.
This holds for people and for Claude sessions alike.

#### Scenario: A change touches a format
- **GIVEN** a change that adds, removes, renames or re-means a field, an entry, a file, a store or an API route
- **WHEN** it is planned
- **THEN** the owner is asked first with the reason and the plan for old data, and nothing is changed before they agree

### Requirement: Old formats SHALL keep working, unless they break a security rule

A format that breaks a rule in `docs/security.md` is the one exception: it
loses support instead of being kept readable. Its spec says plainly that it
no longer works, and a test shows it is refused with a clear error. No app
format has been dropped yet; the backend dropped plain SHA-256 code hashes
(see the backend's `collect-api` spec).

A change SHALL NOT stop data written by an earlier version from being read.
Readers keep reading every earlier version; writers may write a newer one.
Each change to a format adds a test that reads data written by the version
just before the change, kept as a fixture that is never regenerated.

#### Scenario: Which changes bump the note format version
- **GIVEN** a change to the note format
- **WHEN** it only adds an optional field that older readers can ignore
- **THEN** `version` stays the same; when it removes a field or changes what one means, `version` is bumped and readers keep reading the old version

#### Scenario: Note files from every earlier version
- **GIVEN** the note files in `crates/bedrock-core/tests/fixtures/old-formats/`
- **WHEN** the tests run
- **THEN** every one of them opens with all its content
<!-- test: the_first_note_format_still_opens -->
<!-- test: notes_from_before_pictures_still_open -->
<!-- test: notes_with_pictures_and_text_boxes_still_open -->

#### Scenario: A newer file is read as far as possible
- **GIVEN** a note from a newer version with fields this version does not know
- **WHEN** it is opened and saved
- **THEN** it opens with a warning and the unknown fields are written back unchanged
<!-- test: newer_version_loads_with_warning -->
<!-- test: unknown_fields_are_preserved -->

#### Scenario: Library records from before folders
- **GIVEN** notes stored on the device before folders existed
- **WHEN** the app opens
- **THEN** they are listed at the top
<!-- test-js: apps/web/tests/folders.test.mjs :: notes saved before folders existed are kept, at the top -->

#### Scenario: Sidecars that name an old path
- **GIVEN** a sidecar whose front matter names where the note used to be
- **WHEN** the plugin indexes the vault
- **THEN** the sidecar opens the note beside it and is rewritten to the new path
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: a library dropped into a subfolder: sidecars open their note and are fixed to the new path -->
