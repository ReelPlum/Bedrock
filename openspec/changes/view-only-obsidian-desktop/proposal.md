# Notes are view only in Obsidian on a computer

## Why

Frederik: "Drawing / editing should not be possible on mac. It should be view
only there on the obsidian plugin." and then "Mac / PC".

Bedrock is made for writing with a pencil. On a Mac or PC in Obsidian the
mouse and trackpad drew ink, and a note could be changed by accident while
it was only being read or searched.

## What changes

- In Obsidian's desktop app (Mac, Windows, Linux: `Platform.isDesktopApp`)
  every Bedrock note opens view only. On the iPad and phones nothing changes.
- View only, the canvas:
  - moves and zooms the page with the pen, mouse, trackpad, wheel and
    fingers; nothing draws, erases or selects, and no tap or key undoes,
    redoes or switches tools (the engine's `view_only`);
  - hides the toolbar, undo and redo, inserting pictures, pasting,
    importing a PDF and the pen's settings, and ignores pasting and
    dropping;
  - shows "View only" where it shows "Saved", and the header name cannot
    be edited;
  - a word's menu says what the word was read as and keeps "Open link" and
    "Copy a link to here"; correcting, linking, grouping, recolouring,
    duplicating and deleting are gone;
  - "Tags and links…" shows the note's tags and links and opens links, but
    nothing adds or removes them;
  - never saves the note. Search hits, links to words, "Show all ink", the
    minimap and the remembered camera (plugin data, not the note) work as
    before.
- The plugin refuses a `write` and a `rename` from a view-only canvas, so
  the file cannot change even if the canvas asked. The one exception is
  below.
- New notes are still made on a computer (Frederik, later: "I want to be
  able to create notes on Mac but it should not be able to draw there"):
  "New Bedrock note" (ribbon, folder menu, command), "New handwritten note
  linking here" (note, PDF and editor menus, command) and the "Folder for
  new notes" setting work as on the iPad. The new note opens view only, to
  be written on the iPad. A note made about a page saves its starting link
  at once, as on the iPad: the plugin lets a view-only canvas write once,
  only into the empty file and only after it was handed starting links.
- Index notes are still written on a computer, so search, links, the graph
  and backlinks keep seeing notes written on the iPad.

## Reading chosen

"Editing" is read as anything that changes the note file: ink, pictures and
text boxes, recognised text corrections, word links, tags and links of the
whole note, and the note's name. Renaming the `.bedrock` file in Obsidian's
own file explorer is Obsidian's, and still works.

## Not changed

No data format changes. The note file, index notes, sidecars and the
plugin's `data.json` are as before. `BEDROCK_VIEW_ONLY` is a flag the plugin
writes into the page it ships in its own `main.js`, nothing stored. The web
app in a browser is unchanged.

## Open source used

None added. The desktop check is Obsidian's own `Platform` API.
