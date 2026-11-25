# Tasks

## 1. Core

- [x] 1.1 `Document::duplicate` with recognised text, links, groups and kinds following the copy; one undo step. Test `duplicating_copies_on_top_with_text_link_and_group_and_one_undo`.
- [x] 1.2 `Engine::duplicate_selection` selects the offset copy; a pen or eraser lets go of the selection. Tests in `engine.rs`.

## 2. Web

- [x] 2.1 `duplicate_selection` in `bedrock-web`; Duplicate in the selection menu and ⌘/Ctrl+D; the lasso becomes the tool after duplicating. Browser test in `apps/web/tests/app.test.mjs`.
