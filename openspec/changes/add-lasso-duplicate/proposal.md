# Duplicate a lasso selection

## Why

Writers want to copy ink and pictures they have lassoed (a diagram, a
heading, a sticker picture) without drawing them again. The copy should be
ready to place at once: selected, with its box, so the next drag moves it.

While checking how the copy is moved, Frederik also set how a selection
ends: dragging inside it moves it, and drawing a new loop or drawing with
any pen lets go of it. The lasso already did the first two; a pen did not
let go of a selection made from a word's menu while the pen was the tool.

## What changes

- The selection menu (hold the selection) gets **Duplicate**, for strokes,
  pictures and text boxes alike. ⌘/Ctrl+D does the same with the lasso.
- The copy lands 24 css px down and to the right of the original (clear of
  it at any zoom, close enough to read as its copy), on top of everything,
  and becomes the selection. The lasso becomes the tool if it was not, so
  the copy can be dragged straight away.
- What was said about copied ink goes with it when it is wholly about the
  copied strokes: recognised text, links, "make it one word" groupings and
  text/maths overrides. A copied picture shares the original's file.
- Duplicating is one undo step.
- Drawing or erasing with a pen lets go of the selection.

## Not changed

- The note format. A copy is ordinary strokes and pictures with new ids;
  copied pictures point at the same `images/` file, which the format
  already allows. `version` stays 1.
- There is no clipboard: Duplicate copies within the note.
