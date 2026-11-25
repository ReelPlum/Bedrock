# Speed up writing in the Obsidian plugin

## Why

Frederik: writing is noticeably slower in the Obsidian plugin than on the
website, on the iPad and on the Mac.

The canvas runs in a `srcdoc` iframe of Obsidian's own origin, so it shares
one main thread with Obsidian and every other plugin; on the website it has
that thread to itself. Measured in Chromium with the plugin's harness
(findings doc in the project thread):

- Every autosave (every 400 ms of writing) also rewrote the note's index
  note. Each index write makes Obsidian re-read the Markdown for search,
  backlinks and the graph, on the thread the pen needs.
- Each saved file was copied twice on its way to the vault: once by
  `postMessage`, once more by the session.
- Each note open compiled the 2.2 MB WebAssembly twice (the canvas and its
  save worker). blob: URLs get no compiled-code cache, so this happened on
  every open, and Safari's engine (the iPad) caches none anyway. The website
  also compiled it twice (page and save worker).

## What changes

- **Index note after a pause.** The session writes the file at once on every
  save, as before, but the index note only once writing has paused for
  2.5 s, with the latest bytes. Closing the view writes a waiting index note
  straight away (`session.flushIndex()`).
- **No copies.** The app transfers the saved file's buffer to the host
  (`HostStore.put`), and the session writes that buffer as it is.
- **Compile once.** The page compiles the WebAssembly once (streamed where
  the browser can) and sends the module to its save worker, which no longer
  compiles its own. In the plugin, `InlineApp.wasmModule()` compiles it once
  while the plugin runs, and each canvas asks for it over the bridge with a
  new request, `wasm`; structured clone shares the compiled code. The plugin
  compiles it 1.5 s after Obsidian's layout is ready, so the first note does
  not wait for it either.

## Not changed

No data format changes. The index note's content is the same; it is written
later. `wasm` is a new request between the plugin's view and the canvas it
ships with (both in the plugin's one `main.js`), and the save worker's new
first message `{ wasm }` is internal to the web app; nothing is stored. A
canvas that gets no module compiles its own, as before.

## Open source used

None added. `WebAssembly.compile`, `compileStreaming`, structured clone of
`WebAssembly.Module` and transferable `ArrayBuffer`s are browser APIs;
wasm-bindgen's generated `init` (already used) accepts a compiled module.
