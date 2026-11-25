# Tasks

## 1. App download

- [x] 1.1 Install binaryen in `ci.yml` and `pages.yml`; `build-web.sh` fails without `wasm-opt` when `BEDROCK_REQUIRE_WASM_OPT=1` (`site.test.mjs`).
- [x] 1.2 Build rarely used libraries for size (`Cargo.toml`); the perf tests still pass.
- [x] 1.3 PDF import as `crates/bedrock-pdf`, loaded on first use; the dictionary only while spelling is on (`app.test.mjs`).

## 2. Note files

- [x] 2.1 Fixture `v1-handwriting-before-points-bin.bedrock` from commit 90c0a6c, before any change.
- [x] 2.2 `points_bin.rs` (encode, decode, exactness), `note.json` version 2 with `pointsFile`, reader for both versions; schema and `docs/note-format.md`.
- [x] 2.3 Preview outlines to 1 decimal; level 6 for Save to Files and the library export; notes stored inside the export.

## 3. On the device and uploads

- [x] 3.1 `navigator.storage.persist()` after the first save (`storage.test.mjs`).
- [x] 3.2 IndexedDB version 3 with `meta`, migration from version 2 (`folders.test.mjs`).
- [x] 3.3 Gzip sample uploads with a plain fallback (`collect.test.mjs`).
