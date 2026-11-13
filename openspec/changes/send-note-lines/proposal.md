# Send whole lines from notes, so wrong word splits can be fixed

## Why

The app cuts each line of handwriting into words and sent every word as its
own sample. When it cut in the wrong place ("to gether", "helloworld"), the
pieces were stored apart and nothing could put them back together: review
could fix a word's text but not join or split words, and training learned
broken pieces. Research and options: "Fixing wrong word splits in training
data" (option 4, with option 1).

## What changes

- A note is sent one line of handwriting at a time, as training sample
  version 3: the line's ink plus `words`, saying which strokes make each
  word and each word's text and label source.
- When a line changes (a new reading, a word checked, words added or
  regrouped), it is sent again and `supersedes` every earlier sample that
  holds any of the same strokes, including words sent alone by earlier
  versions of the app.
- Each word on the page says which line it is on (`WordInfo.line`,
  `words_json` field `line`).
- The training pages still send version 2.

The backend side (accepting version 3, reviewing cuts, training on lines)
is change `send-note-lines` in Bedrock-Backend.

## Data format change

What changes:

- Training samples from notes are `bedrock-training` version 3 (version 2
  plus `words`); samples from the training pages stay version 2.
- Local storage: `bedrock.sharedLines.v1` (new) remembers what was sent
  line by line. `bedrock.sharedWords.v1`, written by earlier versions, is
  still read; a record is removed once its word has been sent in a line.

Why: to keep a line together so its word splits can be fixed after it is
stored, and so the reader can learn where words end.

How old data keeps working:

- Samples already queued on a device (version 2) are sent unchanged; the
  backend keeps accepting version 2.
- `bedrock.sharedWords.v1` as earlier versions wrote it is read: its words
  are replaced by their lines, a word checked before keeps its checked
  text, and records for other notes are kept. Frozen fixture
  `crates/bedrock-core/tests/fixtures/old-formats/shared-words-v1.json`,
  test "words sent alone by an earlier version are replaced by their line".
- No note file changes.

Approval: Frederik, 2026-11-13, in the project thread, after reading the
options: "Please change the dataformat."

Deploy order: deploy the backend change first. A backend without it
refuses version 3, and the app drops samples the server refuses. No
backend is deployed yet (`DEFAULT_API` is empty), so nothing is lost today.

## Impact

- `crates/bedrock-core/src/handwriting.rs`, `crates/bedrock-web/src/lib.rs`
  (`line` on each word).
- `apps/web/src/collect.js` (`fromLine`), `apps/web/src/share-words.js`.
- Docs: `docs/training-data.md`.
