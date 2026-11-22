# Design

## Core

`Document::recolor(ids, color) -> Vec<(old, new)>` replaces each selected
stroke whose colour differs with a copy in the new colour, at the same index,
as one `Op::Replace` with `renamed` pairs: exactly like `translate`, so the
GPU chunks (keyed by stroke id) draw them again, and recognised text, links,
groups and kind overrides follow through undo and redo. Strokes already that
colour are skipped; if none differ there is no undo step.

`Engine::recolor_selection(color)` recolours the selection and maps it to
the new ids (pictures keep theirs).

## Web

- `canvas.recolor_selection('#rrggbb')` (wasm).
- `selection_json()` adds `color` (the strokes' shared colour, or null) and
  `highlighter` (every selected stroke is highlighter ink). These are the
  app's own wasm bindings, not a stored format.
- The toolbar's one-swatch-per-opening logic moves from `main.js` into
  `SwatchPicker` (`swatch-picker.js`), used by the toolbar's + and by the
  menu's +. The toolbar previews on the brush while the picker is open; the
  menu does not preview (each recolour is an undo step), it recolours once
  when the pick settles.
- `WordMenu` gets a `color` view (`#wm-color-view`) and the options
  `palette(highlighter)` and `onPaletteChange()`; `main.js` passes the
  settings' palettes and saves them.

## Alternatives

- Live preview on the selection while the picker is open: every move would
  be an undo step, or undo would need a way to merge them. Rejected for now;
  the colour shows as soon as the picker closes.
- Keep stroke ids when recolouring: the GPU caches would keep the old
  colour. Rejected, as for moving.
