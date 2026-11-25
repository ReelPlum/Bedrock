# The note's name in the canvas header is its file name in Obsidian

## Why

Frederik: "For the header where you can change the note name please also
rename the obsidian files that way and when the file name is changed in
obsidian update this header also."

In the Obsidian plugin the canvas header showed the title stored inside the
note (`note.json` `title`), which had nothing to do with the vault file's
name. A new note was "Handwritten note.bedrock" with an empty header, and
naming it in the header left the file, its tab, search and links on the old
name. Renaming the file in Obsidian left the header as it was.

## What changes

- Inside Obsidian the header shows the note's file name (without
  `.bedrock`). When a note opens and the title stored in it differs, the
  header shows the file name, and the stored title follows with the next
  save.
- Naming the note in the header renames the vault file once the name is
  done (Enter, or leaving the box), not on every key. The plugin renames it
  with Obsidian's `fileManager.renameFile`, so links to the note in other
  notes (including links to its words, `[[Note.bedrock#^…]]`) are updated by
  Obsidian as for any rename. The index note or sidecar follows as for every
  rename, and so does the remembered camera.
- Characters a file name or an Obsidian link cannot hold (`\ / : * ? " < >
  | # ^ [ ]`, control characters, leading dots) become spaces. A name that is
  empty after that, or that another file in the folder already has, does not
  rename the file: the header goes back to the file name, with a notice for
  the clash (Obsidian refuses such renames too).
- Renaming or moving the file in Obsidian (file explorer, tab header, a sync)
  puts the new name in the header, and the stored title follows with the next
  save.
- Two new messages between the plugin's view and the canvas it ships with:
  `rename { title }` (app asks, answer `{ name }`: the file's name after it)
  and `renamed { name }` (view tells the app).
- Fixed on the way: the remembered camera only followed a renamed note while
  "Make handwriting searchable" was on; it now always does. Renaming an
  empty (new, never drawn on) note no longer makes an index note for it.

## Not changed

No data format changes. `note.json` `title` keeps its meaning (the note's
name, which inside Obsidian is now kept equal to its file name); index notes,
sidecars and links to words are unchanged; `rename` and `renamed` are
messages between two parts of the plugin's one `main.js`, nothing stored.
The web app in a browser behaves as before.

## Open source used

None added. Renaming uses Obsidian's own API (`FileManager.renameFile`),
which is what keeps links intact. Turning a title into a file name is a
dozen lines of our own: libraries such as `sanitize-filename` cover the
operating systems' rules but not Obsidian's link characters (`# ^ [ ] |`),
and do not decide what to do on a clash, which is the part that matters here.
