# Name words and new pictures with BLAKE3

## Why

`docs/security.md` rule 1: BLAKE3, never SHA-256 or a hand-written hash.
The November 2026 rules review found two hashes that are stored in notes
and did not follow it: word ids (a hand-written FNV-1a in
`crates/bedrock-core/src/words.rs`) and picture file names (SHA-256 in
`apps/web/src/images.js`). Neither protects a secret; they only name
things. They change now so every hash in the app follows one rule.

## What changes

- **Word ids** are the first 64 bits of BLAKE3 over the domain
  `bedrock word id` and the word's stroke ids (little-endian), written
  as 16 hex digits as before. They are stored as `id` in
  `recognized.json`.
- **New pictures** are named `images/<first 128 bits of the BLAKE3 hash of
  the bytes, in hex>.<ext>`, the same length as before. The name is made in
  Rust (`bedrock_core::format::picture_name`, exported to the web app as
  `picture_name`), so the app uses the `blake3` crate it already has
  instead of a second hash library in JavaScript.

## Data format change

What changes: the values of `recognized.json` `items[].id`, and the names
of picture files that are added from now on. No field, entry or version
changes, and the note format `version` stays the same: both values were
already opaque names (`docs/note-format.md` shows `"id": "r1"`).

Why: `docs/security.md` rule 1.

How old data keeps working:

- Recognised text is found again by its strokes, never by its id
  (`Handwriting::text_for`), so text saved with FNV ids is still shown and
  is replaced, not doubled, when the word is read again. The old id is kept
  as it was until then. Test `text_saved_with_old_word_ids_is_kept`; the
  frozen fixture `v1-first-release` (id `r1`) still opens with its text
  (`the_first_note_format_still_opens`).
- A picture's name is only looked up in the note's files, never checked
  against its bytes, so notes with SHA-256 names open as before. The frozen
  fixture `v1-pictures-and-text-boxes` names its picture `images/abc.png`
  and still opens with it (`notes_with_pictures_and_text_boxes_still_open`).
- A picture added twice, once before and once after this change, is stored
  under both names. That costs space once and loses nothing.

Approval: Frederik, 2026-11-25, in the project thread, after the reason and
the plan for old notes were given: "Change word ids and picture names. Old
data still works right?"

## Open source used

`blake3` (already used, see `saving-and-opening`). Nothing added.

## Impact

- `crates/bedrock-core/src/words.rs`, `crates/bedrock-core/src/format.rs`,
  `crates/bedrock-web/src/lib.rs`, `apps/web/src/images.js`.
- Docs: `docs/note-format.md`, `docs/security.md`.
- Specs: `note-format`, `handwriting-recognition`.
