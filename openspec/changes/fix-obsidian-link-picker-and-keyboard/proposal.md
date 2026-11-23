# Fix: a picked note never showed in the link box, and the iPad keyboard hid it

## Why

Frederik, in the Obsidian plugin: "When trying to make a note … it shows the
other files etc. but when i click it it doesnt put it into the note
textbox. Also when I enter the textbox on my ipad the textbox dissapears
because the keyboard blocks it."

- **The picker.** "Make a link…" opens Obsidian's note picker. A chosen note
  linked the word straight away and closed the menu, so the link box never
  showed it and the writer could not see what had happened. The box was also
  focused just as the picker opened, which on the iPad brings up the
  keyboard for nothing.
- **The keyboard.** On the iPad, Obsidian's on-screen keyboard covers the
  bottom of the app without resizing it: Obsidian only sets
  `--keyboard-height` on its root element and fires `keyboardWillShow` /
  `keyboardWillHide` (app.js of Obsidian 1.15.1). The canvas in the view's
  iframe never learnt of it, so a menu placed below a word sat under the
  keyboard.

## What changes

- The word menu puts the picked note into the link box and focuses Save; Save
  (or Enter) makes the link. When a new note link starts in the picker, the
  box is not focused.
- `apps/obsidian/src/keyboard.js` works out how much of the bottom of the
  view's frame is hidden (`--keyboard-height`, and the visual viewport for
  anything else) and the view sends it to the canvas as a new view event,
  `inset { bottom }`. The word menu places itself above it, and moves when it
  changes.
- The browser harness plays Obsidian's picker as a real prompt (it takes the
  focus and is clicked) and Obsidian's iPad keyboard.

## Not changed

No data format changes. `inset` is a new message between the plugin's view
and the canvas it ships with (both are in the plugin's one `main.js`); nothing
is stored. The web app in a browser behaves as before.

## Open source used

None added.
