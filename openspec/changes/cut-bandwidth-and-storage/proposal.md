# Cut bandwidth and storage without losing data

## Why

Measured on 13 November 2026 (the research is in the project's "Bandwidth
and storage research" document):

- A `.bedrock` file costs about 40 bytes per pen sample: a busy page of
  1,600 strokes is 9.0 MB on the device, in every autosave and in every
  export. `preview.svg`, a picture made from the ink, is 59% of that, and
  `note.json` holds each sample as about 41 bytes of JSON text.
- The app downloads 781 KB of compressed WebAssembly. CI never installed
  `wasm-opt`, so the published module was never optimised, and PDF import
  (about a tenth of the module) is downloaded by everyone, though few open
  PDFs.
- Nothing asks the browser to keep Bedrock's storage, so Safari may clear
  the notes and the 64 to 521 MB of cached recognition models.
- The notes list read every note's file bytes to show titles.
- Training samples are uploaded as plain JSON (2.6x larger than gzip), and
  model downloads could not be kept by the browser (`no-store`).

Frederik's rule for this work: what is saved must not change and nothing
may be lost. Every change below is lossless: raw pen data, note contents
and stored samples come back bit for bit the same.

## What changes

- **Smaller app download.** CI and Pages install binaryen and fail without
  `wasm-opt`; libraries that run rarely (PDF reading, spelling, ZIP
  structure, SVG reading, PNG, Base64) are built for size. PDF import is its
  own WebAssembly module (`crates/bedrock-pdf`), downloaded the first time a
  PDF is opened. The spelling dictionary (195 KB) is downloaded only while
  spelling is on. 781 KB becomes 587 KB at start, plus 394 KB on the first
  PDF.
- **`points.bin`.** Inside a `.bedrock`, the pen samples move from
  `note.json` to a binary entry: each value as a whole number of its
  channel's step (exactly how `note.json` already rounds it), delta-coded
  per channel, LEB128. About 7 bytes per sample instead of 16.5 compressed.
  `note.json` becomes version 2 with `"pointsFile": "points.bin"`. A stroke
  whose values cannot be stored exactly keeps them in `note.json`. The
  `.json` and `.svg` exports are unchanged (version 1, every sample in JSON).
- **Lighter `preview.svg`.** Outline points to 1 decimal instead of 2 in the
  preview inside a `.bedrock` (the full SVG export keeps 2).
- **Stronger compression for files that leave the device.** Save to Files
  and the library export use deflate level 6 instead of 2 (level 9 was
  measured: 1% smaller again, twice as slow). Autosave stays at 2. Notes
  inside a library export are stored, not deflated a second time.
- **Keep storage.** After the first save, the app asks once per page load
  for persistent storage (`navigator.storage.persist()`).
- **Notes list from metadata.** IndexedDB version 3 adds a `meta` store with
  each note's `{ id, title, created, modified, folder }`, written with the
  note in one transaction and filled from the notes when a version 2
  database is opened. The list and folder deletes read only `meta`.
- **Gzip uploads.** `POST /v1/samples` is sent with `Content-Encoding: gzip`
  where the browser has `CompressionStream`. If the backend cannot read it
  (a backend from before this change), the same batch goes plain and the
  page stays on plain JSON. The backend change is in Bedrock-Backend.

## Data format change

Asked on 13 November 2026 with the reasons and the plan for old data (the
research document: what changes, why, how old files keep working).
**Approved by Frederik on 13 November 2026 at 23:48 UTC**: "Let's implement
it all. Also the binary encoding of the json."

| Format | Change | Old data |
|---|---|---|
| `.bedrock` note files | `note.json` version 2 with `pointsFile`; new entry `points.bin`; `preview.svg` outlines to 1 decimal; `README.txt` names `points.bin`; files leaving the device deflated at level 6 | Version 1 files (every sample in `note.json`) open as before; tested with every fixture in `tests/fixtures/old-formats/`, including `v1-handwriting-before-points-bin.bedrock` written by commit 90c0a6c just before this change, and every one saved again comes back value for value |
| `.json`, `.svg` exports | None (still version 1) | |
| The exported library | Notes inside are stored instead of deflated | Any unzip tool reads both |
| The on-device library (IndexedDB `bedrock`) | Version 3: `meta` store | Opening a version 2 database copies every note's metadata; `notes` records are not touched (browser test) |
| Training sample uploads | Request body may be gzip (`Content-Encoding: gzip`) | The backend keeps accepting plain JSON; the app falls back to plain JSON for a backend that cannot read gzip |

**Older apps and new files.** A Bedrock from before this change reads
version 2 `note.json` with a warning and cannot find the samples of strokes
without `points`, so it shows them as damaged. The web app updates itself on
the next load; the Obsidian plugin needs its update before it opens notes
saved by a newer app. An older web app also cannot open the version 3
database (IndexedDB refuses a lower version); it only runs offline from an
old cache, and reloading online gets the new one.

## Not changed

- No pen value is rounded further, no channel or sample is dropped, and no
  stored training sample changes. `points.bin` holds exactly the numbers
  `note.json` would.
- R2 ink stays gzipped at the fast level. A stronger level was proposed for
  about 10% less R2 storage, but the Worker runs on the free plan's 10 ms of
  CPU per request and a full batch at level 6 to 9 would not fit; R2 storage
  costs about $0.015 per GB a month, so the saving is not worth refused
  uploads.
- Recognition models are not swapped for smaller or more quantised ones:
  that would change what the recogniser reads.

## Open source used

| | leb128 | binaryen (`wasm-opt`) |
|---|---|---|
| Version | [0.2](https://crates.io/crates/leb128) | [version_123](https://github.com/WebAssembly/binaryen/releases/tag/version_123), in CI only |
| Used for | Reading and writing the integers of `points.bin`. | Optimising the published WebAssembly (was already in `build-web.sh`, but never installed in CI). |
| Why this one | The LEB128 encoding of WebAssembly and DWARF, so the format names a standard any language has a reader for; overflow and truncation are errors, not panics. | The WebAssembly project's own optimiser, the standard step after `wasm-bindgen`. |
| Why it is mature | gimli-rs organisation (the DWARF reader used by Rust's backtraces), since 2016, about 90 million downloads, released June 2026. | WebAssembly Community Group, since 2015, used by Emscripten, wasm-pack and Rust's wasm tooling. |
| Licence | MIT or Apache-2.0 | Apache-2.0 |
| Considered | `pco` (Pcodec, Apache-2.0): compresses numbers further, but its format is far more than a page to describe, which breaks the promise that anyone can read a note without Bedrock's code. Protocol Buffers or CBOR: generic, and still need the delta coding that does the work. zstd or brotli inside the ZIP: smaller, but most unzip tools cannot open ZIP method 93. | |

`CompressionStream`, `DecompressionStream` and `navigator.storage.persist()`
are built into browsers; gzip and deflate are the existing `flate2` and
`zip` crates.
