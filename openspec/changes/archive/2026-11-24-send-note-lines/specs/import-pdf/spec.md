# import-pdf

## MODIFIED Requirements

### Requirement: Imported words SHALL be sent for training only with consent

Importing is the writer's own act, so with saving set up on `/train` every line of an imported page SHALL be sent at once (training sample version 3, as for any note), its words marked `unchecked` with the PDF's reading as each word's `model_reading`, and `model_engine: "pdf-text"`.

#### Scenario: Saving set up
- **GIVEN** saving is set up on `/train`, and "Send every word" is off
- **WHEN** a PDF is imported
- **THEN** every line is queued and sent once, with the PDF's reading where it has one
<!-- test-js: apps/web/tests/collect.test.mjs :: importing a PDF: each page becomes a note, and every line is sent with the PDF's reading -->

#### Scenario: Saving not set up
- **GIVEN** saving is not set up
- **WHEN** a PDF is imported
- **THEN** the notes are made and nothing is queued or sent
<!-- test-js: apps/web/tests/collect.test.mjs :: importing a PDF without saving set up keeps it on the device -->
