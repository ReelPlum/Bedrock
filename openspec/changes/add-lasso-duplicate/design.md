# Design

## Core

`Document::duplicate(ids, delta) -> Vec<StrokeId>` copies strokes and
pictures as one undo step (one `Op::Replace` adding the stroke copies at
the end of the stacking order, one `Op::Images` appending picture copies).
New ids come from `next_id`, so they cannot clash with anything on the
page. After the copy, recognised text, links, groups and kind overrides
whose strokes were *all* copied are cloned onto the copies' ids (like
`group`, these are not undo steps; entries whose strokes are gone are not
saved). A recognised text's id is the word id of its new strokes, as
`Handwriting::set_text` makes it.

`Engine::duplicate_selection(offset_css)` turns the css offset into world
units at the current zoom, duplicates the selection and selects the copy.
`DUPLICATE_OFFSET_CSS = 24`.

`Engine::pointer_down` clears the selection when the tool that starts is
not the lasso (drawing, erasing, or the pen's eraser end).

## Web

`canvas.duplicate_selection()` (wasm) calls the engine. The word menu shows
`Duplicate` whenever it is open on a selection; after it, `main.js` selects
the lasso tool if another tool was active. ⌘/Ctrl+D with the lasso calls it
too and stops the browser's bookmark shortcut.

## Alternatives

- Copy in place (no offset): the copy would hide the original and look
  like nothing happened. Rejected.
- Offset in world units: tiny when zoomed out, huge when zoomed in.
  Rejected in favour of css px.
