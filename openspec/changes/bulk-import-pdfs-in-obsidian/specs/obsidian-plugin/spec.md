# obsidian-plugin Specification

## ADDED Requirements

### Requirement: Many PDFs SHALL be imported at once from the settings

"Import PDFs" in the plugin's settings SHALL take PDFs dropped on it (folders
of PDFs too) or chosen with "Choose PDFs…", and make each a `.bedrock` note at
the vault's root, named after the PDF, as importing a PDF into an open note
makes it (every page with ink or pictures, one below another, with the PDF's
reading of the handwriting). No data format changes.

#### Scenario: Dropping a GoodNotes library
- **GIVEN** PDFs exported from GoodNotes, and a file that is not a PDF
- **WHEN** they are dropped on the drop zone in the settings
- **THEN** each PDF becomes a note at the vault's root named after it, which opens with its handwriting and has its index note, and the other file is listed as not a PDF
<!-- test-js: apps/obsidian/tests/host.test.mjs :: PDFs dropped on the settings' drop zone become notes at the vault root that open with their handwriting -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: the settings have a place to drop PDFs, which imports them at the vault root -->

#### Scenario: Dropping folders
- **GIVEN** a folder of PDFs with folders inside it, and a loose PDF
- **WHEN** they are dropped together
- **THEN** every PDF in the folders is found and imported at the vault's root (the folders are not kept), and other files are listed as not a PDF
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bulk PDF import: a dropped folder is searched for its files, in its folders too -->

#### Scenario: Names already taken
- **GIVEN** a note `Physics.bedrock` at the root, and PDFs `Physics.pdf`, `physics.PDF` and `Term 1/Physics.pdf` (from a dropped folder)
- **WHEN** they are imported
- **THEN** they become `Physics 1.bedrock`, `physics 2.bedrock` and `Physics 3.bedrock` at the root (names are compared ignoring case), and no file is overwritten
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bulk PDF import: each PDF becomes a note at the vault root named after it, and never overwrites a file -->

#### Scenario: A PDF that cannot be imported
- **GIVEN** a batch with a locked PDF, a PDF without handwriting or pictures, a file that cannot be read and a note that cannot be written
- **WHEN** it is imported
- **THEN** each of those is listed with its reason, and every other PDF is still imported
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bulk PDF import: a PDF that fails is listed with its reason, and the others are still imported -->

#### Scenario: Hundreds of PDFs
- **GIVEN** 300 PDFs dropped at once
- **WHEN** they are imported
- **THEN** only one file is read and held at a time, progress counts up one by one, and Obsidian gets to run between files; the import goes on when the settings are closed, and a notice says when it is done
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bulk PDF import: hundreds of PDFs are read one at a time, with progress, letting Obsidian run between files -->

#### Scenario: Stop
- **GIVEN** an import under way
- **WHEN** Stop is pressed
- **THEN** the notes already made stay, the PDF being read is finished, and the rest are listed as not imported
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bulk PDF import: Stop keeps the notes already made and lists the rest as not imported -->

#### Scenario: A PDF the reader hangs or crashes on
- **GIVEN** the PDF reader, which runs in a worker so Obsidian never freezes
- **WHEN** it does not answer for 2 minutes, or crashes, on one PDF
- **THEN** that PDF is listed as not imported, the worker is stopped and a new one reads the next PDF; a worker is also started afresh every 25 PDFs so its memory is given back
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: bulk PDF import: a PDF the reader hangs or crashes on is given up, and the reader is started afresh -->
