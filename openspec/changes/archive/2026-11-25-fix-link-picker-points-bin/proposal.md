# Fix: the link picker finds no words in newly saved notes

## Why

Two changes that each passed alone met on main: the link picker (#40) read
word positions from `note.json` only, and notes are now saved with their
samples in `points.bin` (#33, note format version 2). The picker then found
no words in any note saved since, and CI on main went red
(`host.test.mjs :: the link picker opens another Bedrock note to link one
of its words, or the whole note`).

## What changes

`apps/web/src/link-picker.js` reads `points.bin` as `docs/note-format.md`
describes it, for the strokes that have no `points` in `note.json`. About
40 lines of JavaScript, which is what the format doc says any reader takes;
the Rust reader (`points_bin.rs`) is in the WebAssembly, which the
picker's pure function does not load. A damaged `points.bin` marks no words
instead of failing.

## Not changed

No data format changes: this only reads the format as documented. Version 1
notes (every sample in `note.json`) read as before.

## Open source used

None added.
