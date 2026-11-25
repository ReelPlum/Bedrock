# Keep only "Mirror my notes"

## Why

Frederik, 24 November 2026: "I only want the Mirror handwriting setting. I
only want to keep a copy of the data on the database so I can retrain with
other settings later and have full control of the data that way." Mirrors
hold notes exactly as written; line samples are already cut and labelled
by the app, which review now does on the mirrors instead.

## What changes

- "Send every word I write in notes" is removed, with everything that sent
  note words as samples (`share-words.js`, checked and corrected words,
  imported PDFs). The training pages still send their samples.
- The Terms are version 4 (consent version 4): notes are mirrored whole.
  Everyone is asked again. While the launch gate is on, agreeing turns on
  "Mirror my notes" and locks it on (Frederik chose this on the decision
  card: "Yes, mirroring is part of using it").
- Mirror uploads raise stroke times that go backwards, as samples always
  did, so the backend takes old notes' ink.

## Data format change

Asked for by Frederik in the project thread (quoted above), which is the
approval.

| Format | Change | Old data |
|---|---|---|
| `bedrock-training` samples with `source: "note"` (versions 2 and 3) | No longer sent by the app | The backend still takes them from older apps; stored ones stay |
| `bedrock.collect.v1` `consent` | Version 4 | Versions 1 to 3 are asked again, keeping code, contributor and secret (frozen fixtures `collect-state-consent-v2.json`, `collect-state-consent-v3.json`) |
| `bedrock.settings.v1` `shareWords`, `shareWordsSince` | No longer read or written | Ignored |
| `bedrock.sharedLines.v1`, `bedrock.sharedWords.v1` | No longer read | Removed by "Delete my contributions" |
