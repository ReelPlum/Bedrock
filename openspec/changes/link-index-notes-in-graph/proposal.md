# Links between handwritten notes show in a tidy graph

## Why

Frederik: "When linking it links between the .bedrock files which means it
doesn't show in the graph view." With the graph filter that hides
`.bedrock` files (`tidy-obsidian-graph`), a link from one handwritten note
to another pointed at a hidden node, so the edge vanished.

Approved as a data format change (Frederik chose "Add a linked-notes
section" on 2026-11-23) over injecting edges into Obsidian's link cache at
runtime, which relies on Obsidian internals.

## What changes

- An index note (and an exported sidecar) whose links lead to other
  handwritten notes ends with `## Linked handwritten notes`, linking each
  one's index note once: `- [[<index note path>|<name>]]`. Not the note
  itself, not a note that does not exist (or, in an export, is not in it).
- In Obsidian the plugin resolves each link as Obsidian does
  (`metadataCache.getFirstLinkpathDest`) and links the note's sidecar, or
  its note in the index folder. The website's export links sidecars.
- Opening one of these links opens an index note, which opens the
  handwriting, as before.

## Backwards compatibility

- Index notes and sidecars with no link to a handwritten note are byte for
  byte the same (the before-tags fixture test still passes).
- Index notes written before the section still name their note and still
  open search hits at the words (the section comes after the text, so no
  word moves). The plugin rewrites them once, when it indexes the vault.
  Fixture: `apps/obsidian/tests/fixtures/index-before-linked-notes.md`,
  written by the code before this change.
