# Tasks

## 1. Fix

- [x] 1.1 Failing tests first: `host.test.mjs` picks a note in an Obsidian-like prompt with the mouse (the box stayed empty, the link was made at once, the box took the focus), and brings up an iPad-like keyboard (the menu stayed under it).
- [x] 1.2 `word-menu.js`: a pick fills the box and focuses Save; no focus on the box while the picker opens; `setInset` keeps the menu above a hidden bottom.
- [x] 1.3 `keyboard.js` and the view send `inset { bottom }`; the app passes it to the word menu.
- [x] 1.4 Spec, README protocol table.
