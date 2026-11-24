# note-mirrors Specification

## Purpose
"Mirror my notes": a copy of the handwriting of every note, kept up to date
in the training data backend as the writer adds and erases strokes, so
recognition can later be trained on notes exactly as they were written.
Off unless the writer turns it on, on top of the consent on the training
pages. The app side is `apps/web/src/mirror-notes.js`, `collect.js`
(`sendNotes`) and `bedrock-core`'s `ink_mirror`; the backend's checks and
storage are the `note-mirrors` spec in the Bedrock-Backend repository.
`docs/training-data.md` explains it for people. Research and the choice of
a change log over uploading whole files: "Training data: full-note mirror
vs stroke streaming" (24 November 2026).

## Data formats

**Upload** (`bedrock-note-mirror`, version 1), made in `mirror-notes.js`
and sent to `POST /v1/notes` with the invite code and
`X-Contributor-Secret`, at most 5 uploads and 16 erased strokes per request:

```json
{
  "contributor": { "id": "<contributor id>", "consent_version": 4 },
  "notes": [{
    "format": "bedrock-note-mirror", "version": 1,
    "id": "<UUID version 7: this upload>",
    "note": "<UUID version 7: the mirror, made on the device>",
    "channels": ["x", "y", "pressure", "altitude", "azimuth", "t"],
    "add": [{ "id": "9f2c4e1a7b3d5f60", "start": 1794421370000, "points": [10, 20, 0.5, 0.9, 1.2, 0] }],
    "erase": ["0a11b2c3d4e5f607"],
    "written": 1794421373000, "device": "ipad", "app_version": "0.1.0"
  }]
}
```

| Field | Value |
|---|---|
| `note` | A random id made the first time the note is mirrored, kept only on this device. Never the app's note id, title or file name. |
| `add` | Strokes written since the last upload: the note's own stroke id, start time and raw samples (`note_ink_json` and the canvas give the same values the note file saves). At most 800 strokes and 50 000 points per upload. No highlighter strokes, brush, colour, typed text or pictures. |
| `erase` | Ids of strokes erased since the last upload. |
| `deleted` | `true` (with no strokes) when the note is deleted from the library. |

A stroke erased from a mirror is never stored there again, so a stroke that
comes back (an erase undone) is sent under a new random stroke id, and
erased again by that id.

**On the device**:

- IndexedDB `bedrock-mirror` (version 1). Store `notes`, keyed by the app's
  note id: `{ "note", "mirror", "sent": [stroke id], "erased": [stroke id],
  "alias": { note's stroke id: mirror's stroke id }, "modified" }`. A record
  without `erased` or `alias` reads as having none. Store `queue`: uploads
  waiting to be sent, keyed by their id.
- In local storage `bedrock.collect.v1`: `mirror` (the consent version the
  writer gave for mirroring, 4; anything else is off), `secret` (64 hex
  digits, made on the device, sent only in `X-Contributor-Secret`) and
  `secretKnown` (the backend has stored the secret, so "Delete my
  contributions" sends it too). Earlier states have none of these and read
  as mirroring off.

## Open source used

Nothing new. Automerge (MIT) and Loro (MIT) were considered for merging and
not used: strokes are only added or erased by ids that are never reused, so
a set with remembered erasures needs no CRDT library and no new file format.

## Requirements

### Requirement: Nothing SHALL be mirrored without its own consent

#### Scenario: Off until turned on
- **GIVEN** saving set up on the training pages, and "Mirror my notes" off
- **WHEN** the writer writes
- **THEN** nothing is kept or sent; turning it on asks (consent version 4) and then sends every note as it is now
<!-- test-js: apps/web/tests/mirror-notes.test.mjs :: nothing is kept or sent while mirroring is off, and turning it on catches up -->
<!-- test-js: apps/web/tests/mirror-notes-app.test.mjs :: writing, erasing and undoing in a note keeps its cloud copy exactly as the note -->

#### Scenario: Only ink leaves the device
- **GIVEN** a note with a title, typed text, pictures and highlighter strokes
- **WHEN** it is mirrored
- **THEN** only stroke ids, start times and raw samples are sent, under a random id that is not the note's
<!-- test: the_mirror_holds_ink_only -->
<!-- test-js: apps/web/tests/mirror-notes.test.mjs :: the backend id of a note is random, not the note id in the app -->
<!-- test-js: apps/web/tests/mirror-notes.test.mjs :: the app sends what the rules of the backend take -->
<!-- test-js: apps/web/tests/mirror-notes-app.test.mjs :: the training data spec lists what the app keeps for mirrors -->

### Requirement: The cloud copy SHALL follow writing and erasing

#### Scenario: Writing
- **GIVEN** a mirrored note
- **WHEN** strokes are written
- **THEN** only the new strokes are sent, once, with every raw sample, and the open note reads only new strokes from the canvas
<!-- test-js: apps/web/tests/mirror-notes.test.mjs :: writing is sent once, and the cloud copy holds exactly the note -->
<!-- test-js: apps/web/tests/mirror-notes.test.mjs :: the open note reads only new strokes from the canvas -->

#### Scenario: Erasing, partly erasing and moving
- **GIVEN** a mirrored note
- **WHEN** strokes are erased, cut by the partial eraser, or moved (which gives them new ids)
- **THEN** the erased ids are sent, new pieces are sent as written, and the cloud copy ends exactly as the note
<!-- test-js: apps/web/tests/mirror-notes.test.mjs :: erasing is sent, and the cloud copy loses the erased ink -->
<!-- test-js: apps/web/tests/mirror-notes.test.mjs :: partly erasing a stroke sends its pieces and erases the original -->
<!-- test-js: apps/web/tests/mirror-notes.test.mjs :: moving strokes sends them as erased and written again -->
<!-- test-js: apps/web/tests/mirror-notes.test.mjs :: writing and erasing before anything is sent ends the same -->

#### Scenario: Undoing an erase
- **GIVEN** a stroke erased and sent as erased
- **WHEN** the erase is undone (the stroke comes back with its id), and later erased and undone again
- **THEN** the stroke is sent again under a new id each time, and the cloud copy holds it
<!-- test-js: apps/web/tests/mirror-notes.test.mjs :: bug: undoing an erase writes the stroke back in the cloud copy -->
<!-- test-js: apps/web/tests/mirror-notes-app.test.mjs :: writing, erasing and undoing in a note keeps its cloud copy exactly as the note -->

#### Scenario: Large notes, offline and the backend's limits
- **GIVEN** a note with thousands of strokes, or no connection
- **WHEN** it is mirrored
- **THEN** it goes in uploads and requests the backend takes, waits on the device while offline, and is sent later
<!-- test-js: apps/web/tests/mirror-notes.test.mjs :: a large note is sent in uploads the backend takes -->
<!-- test-js: apps/web/tests/mirror-notes.test.mjs :: uploads wait while offline and are sent later -->

### Requirement: Every note already in the library SHALL be mirrored in full

#### Scenario: Notes in every earlier format version
- **GIVEN** notes saved in every earlier version of the note format (`crates/bedrock-core/tests/fixtures/old-formats/`)
- **WHEN** mirroring is turned on
- **THEN** each is sent once with every handwritten stroke and sample, and a note changed later is sent again
<!-- test: every_old_note_mirrors_all_its_handwriting -->
<!-- test-js: apps/web/tests/mirror-notes.test.mjs :: notes already in the library are sent in full, once, and changed ones again -->
<!-- test-js: apps/web/tests/mirror-notes-app.test.mjs :: every note already in the library is mirrored in full, whatever format version it was saved in -->

### Requirement: Deleting SHALL reach the cloud copy

#### Scenario: A note is deleted
- **GIVEN** a mirrored note
- **WHEN** it is deleted from the library
- **THEN** its mirror is deleted in the backend
<!-- test-js: apps/web/tests/mirror-notes.test.mjs :: a note deleted from the library deletes its mirror -->
<!-- test-js: apps/web/tests/mirror-notes-app.test.mjs :: every note already in the library is mirrored in full, whatever format version it was saved in -->

#### Scenario: Delete my contributions
- **GIVEN** mirrored notes
- **WHEN** the writer deletes their contributions on the Train page
- **THEN** the backend deletes every mirror (with the contributor secret once it knows it), and the device forgets its mirrors and queue and turns mirroring off
<!-- test-js: apps/web/tests/mirror-notes.test.mjs :: forgetting (after "Delete my contributions") starts afresh -->
<!-- test-js: apps/web/tests/mirror-notes-app.test.mjs :: "Delete my contributions" deletes the mirrors with the secret, and the device forgets them -->
