# Mirror whole notes as training data (app)

## Why

Line samples lose the page around each line: its layout, the order lines
were written in, and anything the app cut wrongly. "Mirror my notes" keeps
a copy of each note's handwriting in the training data backend, up to date
as the writer adds and erases strokes, so later models can be trained on
notes exactly as they were written. Research: "Training data: full-note
mirror vs stroke streaming" (24 November 2026). The backend side is the
`note-mirrors` change in Bedrock-Backend.

## What changes

- A setting, "Mirror the handwriting of my notes, to improve recognition",
  off by default, with its own consent (version 4) on top of `/train`'s.
- `apps/web/src/mirror-notes.js`: what was sent per note, the upload queue,
  and sending; every note already in the library is read with
  `note_ink_json` (every note format version) and sent in full.
- `collect.js`: `sendNotes`, the contributor secret, and "Delete my
  contributions" deleting mirrors and forgetting them on the device.

## Data format change

What changes (all new; nothing existing changes meaning):

- Upload `bedrock-note-mirror` version 1, sent to `POST /v1/notes` with
  `X-Contributor-Secret`.
- IndexedDB `bedrock-mirror` version 1 (stores `notes` and `queue`).
- `bedrock.collect.v1` gains `mirror`, `secret` and `secretKnown`.
- `DELETE /v1/contributors/me` sends `X-Contributor-Secret` once the
  backend has stored it.

How old data keeps working:

- Note files are not changed: the mirror id is kept on the device, not in
  the note. Every old note file is read in full
  (`every_old_note_mirrors_all_its_handwriting`, every fixture in
  `crates/bedrock-core/tests/fixtures/old-formats/`, and the browser test
  that mirrors them from the library).
- A `bedrock.collect.v1` from before has none of the new fields and reads
  as mirroring off (`collect-state-consent-v2.json` still loads, in
  `launch-gate.test.mjs`).
- Samples are sent exactly as before, without the secret header, so an
  older backend keeps taking them.

Approval: Frederik, 2026-11-24, in the project thread, after reading the
research doc and its list of format changes: "Build it out for me please."

Deploy order: the backend first (migration, then deploy), then the app.
