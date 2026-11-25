# Tasks

## 1. Core

- [x] 1.1 `Document::recolor`: same place, text, link and group; one undo step; no step when nothing changes. Test `recoloring_keeps_place_text_link_and_group_in_one_undo`.
- [x] 1.2 `Engine::recolor_selection` keeps the recoloured strokes selected. Test `recolor_selection_changes_only_selected_strokes_and_keeps_them_selected`.

## 2. Web

- [x] 2.1 `recolor_selection`, and `color` / `highlighter` in `selection_json`, in `bedrock-web`.
- [x] 2.2 `SwatchPicker` shared by the toolbar's + and the menu's +.
- [x] 2.3 Color in the selection menu with the swatches and the +. Browser test in `apps/web/tests/app.test.mjs`.
