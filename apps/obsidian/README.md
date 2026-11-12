# Bedrock for Obsidian

Handwritten Bedrock notes inside an Obsidian vault, on desktop and iPad.
`.bedrock` files open in a Bedrock view; new ones come from the ribbon pen
icon or the "New handwritten note" command.

- **Link to vault notes.** Hold a handwritten word, choose "Make a link…" and
  Obsidian's own file picker opens to choose the note. Links open with
  Obsidian, and appear in the graph and backlinks (see below).
- **Search the handwriting.** Obsidian only indexes Markdown, so each note
  has an index note (in `Bedrock index/` by default) with the text read from
  the handwriting and the note's links. It is rewritten on every save,
  including when you correct what the recogniser read, and opening it (from
  search, a link or the graph) opens the handwriting. A search result opens
  it **at the words that were found**: the view moves there and a frame
  flashes around them (see "Jumping to a place" below). Settings can turn it
  off or move it beside each note as `Name.bedrock.md`. "Rebuild search index
  of handwritten notes" re-indexes notes edited elsewhere (this also runs at
  start-up).
- **Link to a word.** Hold a word and choose "Copy a link to here". Pasted
  into any note, the link (`[[Physics.bedrock#^9f2c4e1a7b3d5f60]]`) opens the
  handwriting at that word.
- The note file is the same `.bedrock` file the web app writes
  ([format](../../docs/note-format.md)), so notes move freely between the
  two.

## One codebase for the web app and the plugin

The plugin does not fork the web app. It runs `apps/web` unchanged in an
iframe, and the few things that differ inside Obsidian live behind one
adapter, [`apps/web/src/host.js`](../web/src/host.js), which is inactive in
the browser. A fix to the canvas, the pens or recognition lands once in
`apps/web` or `crates/` and the next plugin build ships it:

```sh
./scripts/build-web.sh                        # WebAssembly, as for the web app
cd apps/obsidian && npm install && npm run build    # dist/main.js, manifest.json, styles.css
node build.mjs --vault ~/path/to/vault        # build and install into a vault for trying it out
```

`build.mjs` packs the web app's runtime files (HTML, CSS, modules,
WebAssembly, word list) into `main.js`, because Obsidian's plugin directory
installs only `main.js`, `manifest.json` and `styles.css`. On start the plugin
unpacks them into its own folder (`.obsidian/plugins/bedrock-notes/web/`,
only when the version changed) and the view loads them from there, so the
browser features the web app relies on (module workers, WebAssembly, WebGL2,
Pointer Events with Pencil pressure and tilt) work exactly as in Safari.

## How the view and the app talk

`postMessage` between the view (`src/bridge.js`, `src/session.js`) and the app
(`apps/web/src/host.js`). Messages are `{ bedrock: 1, ... }`.

| From | Message | Answer |
|---|---|---|
| app | `ready` | the app has started |
| app | `read` | `{ name, created, modified, data }`: the file's bytes (empty for a new note) |
| app | `write { data, title }` | saves the bytes into the file, then updates its index note |
| app | `get-kv { key }` / `set-kv { key, value }` | per-file app state (the camera), kept in the plugin's data |
| app | `pick-note { query }` | Obsidian's file picker; the chosen note as link text, or null |
| app | `open-link { type, target }` | opens the note in Obsidian |
| app | `copy-link { stroke }` | puts a link to the word with that stroke on the clipboard |
| view | `flush` | the app saves now (sent before the view closes) |
| view | `reload` | the file changed elsewhere (sync, another window): the app reloads it |
| view | `show { strokes }` | the app brings those strokes (each as its whole word) into view and flashes a frame around them; `false` if none is on the page any more |

Requests carry `seq`; answers carry `reply` (the request's `seq`) and
`result` or `error`.

## Jumping to a place

Nothing about places is saved. `recognized.json` already lists, for every
piece of text, the strokes it was read from, and that is enough:

1. The index note is one paragraph of the recognised words (so a phrase is
   found as a phrase). `indexLayout` in `src/index-note.js` rebuilds it from
   the note file and knows which characters came from which strokes.
2. Obsidian's search opens a result with `leaf.openFile(file, { eState: {
   match: { content, matches } } })`. The plugin wraps `openFile`: for an
   index note it maps the first match to stroke ids and opens the
   handwriting with `eState: { bedrock: { strokes } }` instead, so the
   Markdown never flashes up. If the index note is opened some other way,
   the `file-open` handler swaps it as before, using the editor's cursor as
   the place when it has one. If the index is older than the note, the hit
   is found by its text.
3. The view's `setEphemeralState` sends `show` to the app once it has loaded
   the note (or at once if the note is already open). A link's
   `#^<stroke id>` arrives the same way, as `eState.subpath`.
4. The app calls `Canvas.reveal_strokes`: each stroke is widened to its
   word, the camera centres on the ink (zoom kept unless it does not fit or
   would be too small to read) and a frame fades over it.

Ink that moved is found where it is now; ink that was erased leaves the view
where it was.

## Tests

```sh
npm test    # unit tests (vault, index notes, ZIP, bridge, unpacking) and
            # browser tests of the real app in an iframe with the plugin's bridge
```

The browser tests need `../web/pkg` (run `./scripts/build-web.sh`) and
Playwright's Chromium, like the web app's tests. `tests/harness.html` plays
Obsidian with an in-memory vault.

## Not done yet

- Tried only against these tests, not yet inside the Obsidian app on a
  desktop or an iPad. In particular the shape of what search hands
  `openFile` (`eState.match`), and of a link's `eState.subpath`, are not part
  of Obsidian's documented API; the tests play them as described above. If
  Obsidian differs, the note still opens, only not at the place.
- Text read from pictures has no strokes, so it cannot be jumped to until
  the note format gives such text a picture and a box.
- Publishing to Obsidian's plugin directory needs `manifest.json` at the root
  of a GitHub repository: either a small release repository that CI fills
  from `apps/obsidian/dist`, or the directory's newer source-path option.
- Plugins cannot receive the Apple Pencil's double tap or squeeze.
