# Fix: the iPad keyboard hid every text box but the word menu's

## Why

Frederik, in the Obsidian plugin on the iPad: "When I open the keyboard … on
a textbox I cant see the textbox, and what im writing." Beta.3
(`fix-obsidian-link-picker-and-keyboard`) moved only the word menu above the
keyboard. Other text boxes low on the page, such as a reading in "Show and
correct what the recogniser reads", were still typed in under it.

## What changes

- `apps/web/src/keep-in-view.js`: when the host says the bottom of the page
  is hidden (`inset { bottom }`) and the focused text box would be under it,
  the page slides up just enough (a transform on `body`, as Safari pans a page
  for its keyboard), and slides back when typing ends or the keyboard goes.
- The word menu places itself in the page's own coordinates, so a slid page
  does not move it twice.

## Not changed

No data format changes. The web app in a browser behaves as before: the
inset is only ever set by a host.

## Open source used

None added.
