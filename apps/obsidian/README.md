# Bedrock for Obsidian

Handwritten Bedrock notes inside an Obsidian vault, on desktop and iPad.
`.bedrock` files open in a Bedrock view; new ones come from the ribbon pen
icon or the "New handwritten note" command.

- **Link to vault files.** Hold a handwritten word and choose "Make a link…":
  the vault's folders and files open over the canvas (with a filter). Tap a
  note to link it; tap a PDF to link one of its pages (`#page=3`), or a
  handwritten note to link one of its words; either can be linked whole.
  Save makes the link. Links open with Obsidian, and appear in the graph and
  backlinks (see below).
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
- **Notes from the website drop straight in.** The website's "Export all
  notes" unzips to your folders with each note's index already beside it as
  `Name.bedrock.md`. Drag that folder anywhere into the vault: a note with a
  sidecar beside it uses that as its index note whatever the index folder
  setting is (no second copy in `Bedrock index/`), the sidecar opens the
  note beside it, moves with the note when it is renamed, and is fixed up
  once if the folder was not dropped into the vault's root.
- **A handwritten note about a page.** Right-click in a note (a long press
  on the iPad), or open a note's or PDF's ⋯ menu (also the tab header and
  the file explorer), and choose "New handwritten note linking here"; a
  right-click inside a PDF offers it too, and so does the command palette.
  The new note ("Lecture 3 notes", or "Week 3 page 4 notes" for a PDF) is
  made next to the page and opens at once, linking to it: to the note, or to
  the PDF page in view (`[[Week 3.pdf#page=4]]`). The link belongs to the
  whole note, not to any ink, so the page lists the note in its backlinks.
- **Tags and links of the whole note.** "Tags and links…" in the canvas's
  menu adds and removes the note's tags (shown in the index note's front
  matter, so Obsidian's tag pane and search find them) and links that belong
  to no handwriting (a vault file or PDF page from the picker, or a website).
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

`build.mjs` packs the web app into `main.js`, because Obsidian's plugin
directory installs only `main.js`, `manifest.json` and `styles.css`.

**The canvas never loads a file.** Obsidian refuses every file request made
from a page inside a view (`net::ERR_BLOCKED_BY_CLIENT`: its webRequest
filter lets only Obsidian's own window load `app://` files), and on the iPad
such a page did not load at all. So nothing is unpacked into the plugin
folder. Instead (`src/inline-app.js`):

- each page (`index.html`, and `welcome/index.html` for the launch gate) is
  packed with its stylesheet and `errors.js` inline, and written into the
  view's iframe as `srcdoc`. That makes it a page of Obsidian's own origin;
- each module graph (the app, the welcome page, the two workers) is bundled
  into one file by esbuild, since a `blob:` module cannot import its
  neighbours, and handed over as a `blob:` URL;
- the WebAssembly and the word list are `blob:` URLs too, found by the app
  through `globalThis.BEDROCK_ASSETS` (`apps/web/src/assets.js`), and
  `globalThis.BEDROCK_HOST` tells the app it runs in the plugin.

The browser features the web app relies on (module workers, WebAssembly,
WebGL2, Pointer Events with Pencil pressure and tilt) work as in Safari. As
the page shares Obsidian's origin, the app's `localStorage` keys (all
`bedrock.*`) sit beside Obsidian's.

## How the view and the app talk

`postMessage` between the view (`src/bridge.js`, `src/session.js`) and the app
(`apps/web/src/host.js`). Messages are `{ bedrock: 1, ... }`.

| From | Message | Answer |
|---|---|---|
| app | `ready` | the app has started |
| app | `start` | what a new note starts with: `{ noteLinks: [{ target, type, text }] }` for a note made by "New handwritten note linking here" (once; the app adds the link and saves at once), else `null` |
| app | `read` | `{ name, created, modified, data }`: the file's bytes (empty for a new note) |
| app | `write { data, title }` | saves the bytes into the file, then updates its index note |
| app | `get-kv { key }` / `set-kv { key, value }` | per-file app state (the camera), kept in the plugin's data |
| app | `list-files` | every vault file the link picker offers (not this note or index notes): `[{ path, link }]`, `link` being Obsidian's link text |
| app | `read-note { path }` | `{ data }`: the bytes of another `.bedrock` file, for its picture in the link picker (nothing but `.bedrock` files) |
| app | `pdf-page { path, page, width }` | `{ count, png }`: a PDF's page count and page `page` drawn `width` px wide with Obsidian's PDF.js (`src/pdf-pages.js`) |
| app | `open-link { type, target }` | opens the note in Obsidian |
| app | `copy-link { stroke }` | puts a link to the word with that stroke on the clipboard |
| app | `send-report { report }` | posts an error report the person chose to send ("Share with the Bedrock team"), or an automatic performance report (`sent: "auto"`, which gets the plugin's own slow moments and a `mobile` fact added), with `requestUrl`; `{ id }` |
| view | `flush` | the app saves now (sent before the view closes) |
| view | `reload` | the file changed elsewhere (sync, another window): the app reloads it |
| view | `show { strokes }` | the app brings those strokes (each as its whole word) into view and flashes a frame around them; `false` if none is on the page any more |
| view | `inset { bottom }` | the bottom `bottom` CSS px of the frame are hidden (the iPad's keyboard, which covers Obsidian without resizing it; `src/keyboard.js`): the word menu stays above them, and a text box being typed in slides into sight (`apps/web/src/keep-in-view.js`) |

Requests carry `seq`; answers carry `reply` (the request's `seq`) and
`result` or `error`.

## Jumping to a place

Nothing about places is saved. `recognized.json` already lists, for every
piece of text, the strokes it was read from, and that is enough:

1. The index note is one paragraph of the recognised words (so a phrase is
   found as a phrase). `indexLayout` (in `apps/web/src/sidecar.js`, shared
   with the website, re-exported by `src/index-note.js`) rebuilds it from
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
npm test    # unit tests (vault, index notes, ZIP, bridge, packed pages) and
            # browser tests of the real app in an iframe with the plugin's bridge,
            # refusing every file request from the iframe as Obsidian does
```

The browser tests need `../web/pkg` (run `./scripts/build-web.sh`) and
Playwright's Chromium, like the web app's tests. `tests/harness.html` plays
Obsidian with an in-memory vault.

## Installing with BRAT

Until the plugin is in Obsidian's directory, install it with
[BRAT](https://github.com/TfTHacker/obsidian42-brat), on desktop or iPad:

1. In Obsidian, Settings > Community plugins: turn off Restricted mode, then
   Browse, find "BRAT", install and enable it.
2. In BRAT's settings choose "Add beta plugin" (or run its command "Add a
   beta plugin for testing") and paste `https://github.com/ReelPlum/Bedrock`.
   Pick "Latest version" to follow new releases, or a specific version to
   stay on it.
3. Enable "Bedrock" under Community plugins. With BRAT's "Auto-update
   plugins at startup" on, it updates when Obsidian starts.

"Latest version" follows the newest release, betas included (BRAT is a
beta tester's tool). Pick a specific version to stay off betas.

## Releasing

`manifest.json` and `versions.json` live at the repository root, where
Obsidian and BRAT look for them; the build copies `manifest.json` into
`dist/`. A tag publishes a release with `.github/workflows/obsidian-release.yml`:

- **A release:** bump `version` in `/manifest.json`, add the same version to
  `/versions.json` with its `minAppVersion`, merge, then tag that commit
  with the bare version: `git tag 0.2.0 && git push origin 0.2.0`.
- **A beta:** tag the version with a suffix, without committing it to
  `manifest.json`: `git tag 0.2.0-beta.1 && git push origin 0.2.0-beta.1`.
  It becomes a GitHub pre-release, and the released `manifest.json` carries
  `0.2.0-beta.1`, as BRAT and Obsidian want the tag and the version to match.

The workflow first checks the tag and manifest (`node release.mjs check
<tag>`; the rules are tested in `tests/release.test.mjs`), then builds the
WebAssembly and the plugin, attests the three files and publishes them.

**Only the plugin makes GitHub releases in this repository.** Obsidian
looks up the release by its exact tag, but BRAT takes the newest-numbered
release as the plugin's latest, reading any digits in a tag as a version,
so a GitHub release such as `web-2.0.0` would hide the plugin. Other apps
ship elsewhere (the web app on GitHub Pages, the iPad app through the App
Store) and may mark versions with plain git tags like `web-2.0.0` or
`ipad-1.0.0`, which BRAT never reads. If another app ever needs downloads
on GitHub, give it its own release repository.

## Not done yet

- The first BRAT beta (0.1.0-beta.1) showed an empty view in Obsidian on a
  Mac and an iPad, because the canvas loaded its files by address (see "The
  canvas never loads a file" above). Since that fix it has run only against
  these tests, which refuse file requests the way Obsidian does. In particular the shape of what search hands
  `openFile` (`eState.match`), and of a link's `eState.subpath`, are not part
  of Obsidian's documented API; the tests play them as described above. If
  Obsidian differs, the note still opens, only not at the place.
- Text read from pictures has no strokes, so it cannot be jumped to until
  the note format gives such text a picture and a box.
- Not yet in Obsidian's community plugin directory (community.obsidian.md).
  Until then it installs with BRAT, below. Submitting needs a `LICENSE`, and
  the directory's build check has to be able to build the WebAssembly.
- Plugins cannot receive the Apple Pencil's double tap or squeeze.
