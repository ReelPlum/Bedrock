# Keep a folder name being typed when the notes list redraws

## Why

The notes list redraws on its own (when it opens, after a save). A redraw
that finished just after "New folder" was tapped replaced the row being
named, so the name field vanished with what was typed. CI showed it as the
folder tests timing out, on main too.

## What changes

- A row being named or renamed stays as it is; the rest of the list is
  redrawn around it (`apps/web/src/main.js`, `renderLibrary`).
- Regression test: "the notes list redrawing while a folder is being named
  keeps the name being typed".

Shipped in PR #13. This change holds only the spec, and is archived into
`openspec/specs/library-folders` once that living spec exists (PR #12).

## Data formats

None change.
