# New notes start on grid paper, and Obsidian can choose the paper

## Why

Frederik: "Also make the default style grid, and add a setting in the
obsidian plugin to choose the default style."

New notes started on dots paper. Frederik wants grid, and wants to pick the
paper for new notes in the Obsidian plugin.

## What changes

- The web app's new notes (the first note on a fresh device, "New note")
  start on grid paper. The Paper menu lists Grid first.
- The Obsidian plugin gets a setting, "Paper for new notes": grid (the
  default), dots, lines or plain. A new (empty) `.bedrock` file opened in the
  plugin's view starts on that paper.
- One new message between the plugin's view and the canvas it ships with:
  `defaults` (app asks, answer `{ paper }`). Both sides are in the plugin's
  one `main.js`; nothing is stored by it.
- Existing notes keep their paper: it is saved in every note (`paper` in
  `note.json`), and a file without `paper` still opens with dots, so no note
  that exists today looks different. A test pins that
  (`a_note_that_names_no_paper_opens_with_dots`).

## Data format change

The plugin's settings in Obsidian's `data.json` (listed under "Data formats"
in `obsidian-plugin`) get one optional field, `newNotePaper`
(`"grid" | "dots" | "lines" | "plain"`). It is the only place an Obsidian
plugin can keep a setting, which is what was asked for.

- Old data: settings saved before this have no `newNotePaper` and get
  `"grid"`; a value that is not a paper is never kept. Tested in
  `new notes start on grid paper; the settings choose another paper for new notes, and it is remembered`.
- Older plugins reading a newer `data.json` ignore the field (settings are
  spread over the defaults).
- The note format is not changed: `paper` keeps its values and meaning, and
  what a file without it opens with (dots) is unchanged.

Approval: asked of Frederik in the project thread, with this reason, before
merge (pending).

## Open source used

None added. The setting uses Obsidian's own `Setting.addDropdown`.
