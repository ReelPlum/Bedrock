# Tasks

## 1. Index note after a pause

- [x] 1.1 Failing test first: `unit.test.mjs` writes five saves in quick succession and expects no index note until writing pauses, then one.
- [x] 1.2 `session.js`: debounce the index update (`INDEX_DELAY_MS`), `flushIndex()`; the view and the harness flush when a note closes.

## 2. No copies

- [x] 2.1 Failing test first: `host.test.mjs` watches the canvas's `write` message and expects the file's buffer in its transfer list.
- [x] 2.2 `host.js` transfers the buffer; `session.js` writes a whole buffer without slicing it.

## 3. Compile once

- [x] 3.1 Failing tests first: `app.test.mjs` expects one request for the WebAssembly (page and worker); `host.test.mjs` expects one compile for two notes, none in the canvas; `unit.test.mjs` for `InlineApp.wasmModule()` and the `wasm` request.
- [x] 3.2 `assets.js` `compileWasm`, `main.js` compiles once and sends the module to the save worker, `save-worker.js` takes it; `host.js` `wasm()`; `inline-app.js` `wasmModule()`; `session.js` `wasm` request.
- [x] 3.3 The plugin compiles it soon after Obsidian starts (`plugin.test.mjs`).
- [x] 3.4 Spec, README protocol table.
