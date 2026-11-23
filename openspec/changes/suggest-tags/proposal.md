# Suggest tags already in use

## Why

Frederik (2026-11-23): "Also add autocomplete / suggestions for tagging so
it's easy to find already created tags."

## What changes

- "Tags and links…"'s tag box suggests tags in use above the box, narrowed
  while typing, picked by tap or arrow keys and Enter
  (`apps/web/src/tag-suggest.js`, `note-info.js`).
- Web app: the tags of the other notes in the library.
- Obsidian: every tag in the vault from the metadata cache
  (`apps/obsidian/src/tags.js`), asked with a new host request `list-tags`.
  An older plugin answers it with an error; the app then suggests nothing.

The living spec is updated in `openspec/specs/obsidian-plugin/spec.md`
("The tag box SHALL suggest tags already in use").

## Data format change

None. Suggestions are read from notes' existing `tags` and Obsidian's cache
each time; nothing new is stored.
