# A tidy graph view in Obsidian

## Why

Frederik: "Please somehow hide the #bedrock tag from the graphview... I also
want to be able to see PDFs on the graph view without all the .bedrock
files.."

With "Tags" on, every index note hangs off one `#bedrock` tag node. With
"Attachments" on (needed to see PDFs), every handwritten note shows twice:
its index note and the `.bedrock` file the index note links to.

## Research

- Obsidian's graph has five filters: "Search files" (Obsidian's search
  syntax), "Tags", "Attachments", "Existing files only" and "Orphans"
  ([Graph view help](https://obsidian.md/help/Plugins/Graph+view)). Files
  matching "Excluded files" are left out too. There is no plugin API to
  set any of them; the options live in `.obsidian/graph.json`, owned by the
  core graph plugin, which keeps them in memory and writes them back.
- There is no setting to hide one tag node and keep its notes; it is an
  open feature request
  ([forum](https://forum.obsidian.md/t/exclude-a-specific-tag-from-the-graph-view/33842)).
  `-tag:#bedrock` hides every index note with it. Users report that
  `-(#bedrock)` hides the tag node and keeps the notes (same thread, 2024).
- `file:` in the graph's search hides attachments where a folder `path:`
  did not
  ([forum](https://forum.obsidian.md/t/graph-view-is-there-a-way-to-exclude-embedded-images-within-notes-from-the-graph-view/21028)).
- "Excluded files" would also push `.bedrock` files down in the quick
  switcher and link suggestions, so it is not used.
- Community plugins that hide graph nodes (for example "Graph exclusions")
  patch Obsidian's internal graph renderer; that breaks with Obsidian
  updates, so none is used.

## What changes

- The plugin offers a graph filter, `-file:/\.bedrock$/ -(#bedrock)`: a
  command, "Copy graph filter that hides .bedrock files and the #bedrock
  tag", and a "Tidy graph view" setting with a "Copy filter" button. Both
  put it on the clipboard (or show it where the clipboard is refused) and
  say where it goes: the graph's "Search files", with "Attachments" on.
- With it each handwritten note is one node, its index note, which carries
  the note's links, so a note linking a PDF page is an edge from that node
  to the PDF.
- No data format changes: index notes and sidecars still say
  `tags: [bedrock, ...]`.

## Not done

- Setting the graph's filter by writing `.obsidian/graph.json` or through
  Obsidian's private graph objects: undocumented, overwritten by the open
  graph, and liable to break with any Obsidian update.
- Dropping `bedrock` from the index note's tags would hide the tag node
  for sure, but changes the sidecar format (asked separately).
