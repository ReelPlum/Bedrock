# Recolour a lasso selection

## Why

Frederik wants to change the colour of ink after writing it: lasso it, open
its menu, tap **Color**, and pick one of their swatches or add a new one with
the +, as in the toolbar.

## What changes

- The selection menu (hold the selection) gets **Color** whenever the
  selection holds strokes. It shows the writer's swatches in place of the
  menu, with the selection's colour marked when all of it is one colour, and
  the + for a new colour.
- Tapping a swatch gives that colour to every selected stroke, as one undo
  step. Pictures and text boxes are left as they are. The strokes stay
  selected, so they can still be moved.
- The + opens the colour picker. As in the toolbar, one opening adds at most
  one swatch, when the picker closes; that colour also goes to the selection.
  The new swatch shows up in the toolbar too.
- A selection that is all highlighter ink gets the highlighter swatches;
  anything else gets the ink swatches.
- The brush keeps its own colour: recolouring does not change what the pen
  draws next.

## Not changed

- The note format. A stroke's colour is already stored in its brush
  (`brush.color`); recoloured strokes are ordinary strokes with new ids, as
  moved strokes are. `version` stays 1.
- Settings: the palettes are the same `palettes.ink` / `palettes.highlighter`
  arrays the toolbar already saves.

## Open source used

None new. This is a menu over the existing core (document undo, the colour
input of the browser) and the toolbar's own swatch picker, now shared in
`apps/web/src/swatch-picker.js`. There is no library to adopt for a
recolour command on our own document model.
