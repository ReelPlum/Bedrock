# Bedrock

Handwritten notes on an infinite canvas, made for Apple Pencil (and any other
pen). The canvas engine is written in Rust; the web app runs it as
WebAssembly and draws with WebGL2, so it works in Safari on iPad today and
the same core can power native apps later.

Your notes are never locked in. Each note is a `.bedrock` file, which is an
ordinary ZIP archive with a picture of the note (`preview.svg`, opens in any
browser) and every pen stroke as documented JSON (`note.json`). See
[docs/note-format.md](docs/note-format.md).

## Features (web app)

- Infinite canvas: pan with one finger, pinch to zoom, trackpad and mouse wheel too.
- Apple Pencil pressure and tilt, every 240 Hz sample (`getCoalescedEvents`) and
  predicted points (`getPredictedEvents`) to hide latency.
- Vector brushes: pen, pencil (tilt to shade), fountain pen, marker, highlighter (drawn under ink).
- Eraser for whole strokes or only the part you touch.
- Scribble over ink to erase it: the ink fades as soon as the stroke is a scribble, and goes when the pen lifts.
- Palm rejection: while the Pencil is down, touches are ignored.
- Undo and redo, also with a two-finger double tap (undo) and a three-finger double tap (redo).
- Solid, dashed and dotted lines, and a stabiliser for shaky hands, set per brush.
- Strokes rendered with signed distance fields: round, smooth edges at any zoom.
- A toolbar you can dock to any edge, three editable size presets per brush, your own colour presets, and a settings panel for the selected tool.
- Tap the active tool again to jump back to the previous one (for example pen and eraser).
- Dot, grid and line paper that stays fixed to the page, like printed paper.
- Notes are saved on the device automatically within a second (IndexedDB) and reopen where you left off.
- Folders in the notes list: make, nest, rename, delete, and move notes between them.
  They are saved on the device with the notes.
- Save to iCloud Drive through the Files app / share sheet, open from iCloud Drive, export SVG.
  Automatic CloudKit sync is planned, see [docs/icloud.md](docs/icloud.md).
- Export all notes as a ZIP that unzips to your folders, each note with a Markdown sidecar
  (`Name.bedrock.md`) beside it: drag the folder into an Obsidian vault and search, links and
  the graph work at once (with the Bedrock plugin, notes open as handwriting).
- When something goes wrong, Bedrock says so and offers "Share with the Bedrock team": you
  see the whole error report (no notes, no file names) and nothing is sent until you press
  Send. Menu → Report a problem… works any time.
- Bedrock notices when it is slow (pen lag, stutters, slow taps, long saves) and what was
  running then; these show in the same report. Menu → "Send performance reports
  automatically" sends them by themselves (off until you agree, at most 3 a day).

Notes are kept in the browser's storage (IndexedDB), which the iPad's Files app cannot see.
The export, or "Save to iCloud Drive / Files" for one note, is how notes leave the website.
- Dots, grid, lines or plain paper. Works offline when installed to the home screen.

## Repository layout

```
crates/bedrock-core   Platform independent engine: input, brushes, geometry, eraser,
                      undo, gestures, scene batching, the note format. Fully unit tested.
crates/bedrock-web    WebAssembly bindings and the WebGL2 renderer.
apps/web              The web app (HTML/CSS/JS shell around the Rust canvas) and its browser tests.
apps/obsidian         The Obsidian plugin: runs apps/web unchanged in a view (see its README).
docs/                 Note format spec, JSON Schema, iCloud plan.
scripts/              Build scripts.
```

Future apps (native iPad, desktop), a backend for sync and the website get
their own folders under `apps/` (and `backend/`, `website/`) and reuse
`bedrock-core`.

## Building and running

Requirements: Rust (stable), the WebAssembly target and `wasm-bindgen-cli`
matching the version pinned in `crates/bedrock-web/Cargo.toml`, and Node 20+.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130
./scripts/build-web.sh          # builds apps/web/pkg
node apps/web/serve.mjs 8080    # open http://localhost:8080
```

To try it on an iPad, serve over HTTPS on your network (or deploy `apps/web`
to any static host) and open it in Safari. "Add to Home Screen" gives a full
screen app that works offline. Menu → "Show latency" displays the measured
input-to-frame time, the frame rate and Bedrock's own drawing time per frame.
Safari holds pages to 60 frames a second by default, also on 120 Hz iPads:
Settings → Apps → Safari → Advanced → Feature Flags → turn off "Prefer Page
Rendering Updates near 60fps" to see whether your iPad gives the page 120.

Menu → "Record a pen trace" saves everything the pen does, as the engine
receives it, to a JSON file. Put it in `crates/bedrock-core/tests/fixtures/`
and the replay test (`tests/replay.rs`) can run it: that is how a problem
with the feel of the ink on a real device becomes a test.

## Tests

```sh
cargo test                                   # engine unit tests, Pencil trace replay, format fuzzing
cargo test --release -p bedrock-core --test perf -- --ignored --nocapture   # 100 000-stroke budget
cd apps/web && npm install && npx playwright install chromium && npm test   # browser tests
cd apps/obsidian && npm install && npm test                                 # Obsidian plugin tests
```

The browser tests drive the real app in headless Chromium with synthetic
Pointer Events shaped like Apple Pencil input: pressure, tilt, coalesced and
predicted samples, palm rejection, gestures, autosave and reload, file round
trips, damaged files, and a latency budget: handling and drawing a pen sample
must take under 8 ms (half a frame), so pen-to-pixel time stays under the
~40 ms people notice.

Project rule: when a bug is found, add a test that reproduces it first.

Project rule: before building something, look for proven open source that
already does it. See [docs/open-source-first.md](docs/open-source-first.md).
