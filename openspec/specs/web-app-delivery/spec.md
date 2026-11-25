# web-app-delivery Specification

## Purpose
How the web app reaches the device and keeps working: publishing to GitHub
Pages, the service worker that keeps it working offline, and recovering when
an update lands mid-load.

## Requirements

### Requirement: Every part of the web app SHALL be published

#### Scenario: The Pages workflow
- **GIVEN** the Pages workflow
- **WHEN** it copies the site
- **THEN** every file the app and the training pages load is published
<!-- test-js: apps/web/tests/site.test.mjs :: the Pages workflow publishes every part of the web app -->

### Requirement: The app SHALL work offline and pick up updates

#### Scenario: Service worker checks with the server
- **GIVEN** an installed app and a new version on the server
- **WHEN** the app loads online
- **THEN** the service worker checks files with the server instead of using a copy the browser kept, and offline it serves its own copy
<!-- test-js: apps/web/tests/offline.test.mjs :: the service worker checks files with the server instead of using a copy the browser kept -->

#### Scenario: A page from two versions
- **GIVEN** a page put together from files of two versions just after an update
- **WHEN** it fails to start
- **THEN** it says to reload instead of staying empty, and offers to share what went wrong (see `error-reporting`)
<!-- test-js: apps/web/tests/train.test.mjs :: a page put together from two versions (just after an update) says to reload instead of staying empty -->

#### Scenario: The page itself is checked with the server
- **GIVEN** an installed app whose page the browser may keep for 10 minutes
- **WHEN** a new version goes live and the app is opened again
- **THEN** the new page is loaded, so it never runs with scripts from another version
<!-- test-js: apps/web/tests/offline.test.mjs :: after an update the page itself comes from the server too, so it never mixes with newer scripts -->

#### Scenario: The app heals itself after one reload
- **GIVEN** the app fails to start because its page is older than its scripts
- **WHEN** it starts
- **THEN** it reloads once by itself and starts; if it fails again it says so with a Reload button and does not reload again
<!-- test-js: apps/web/tests/app.test.mjs :: a page from an older version than its scripts reloads once by itself and starts; if that does not help it says so with a Reload button -->

### Requirement: The app download SHALL be as small as it can be without slowing the pen

The published WebAssembly is optimised with binaryen's `wasm-opt`; CI and
Pages install it and fail without it. Libraries that run rarely (PDF
reading, spelling, ZIP structure, SVG reading, PNG, Base64) are built for
size; the engine, renderer, JSON and deflate stay at full speed (building
those for size too was measured: it fails the scribble perf budget). PDF
import is its own module (`bedrock_pdf`), downloaded the first time a PDF is
opened, and the spelling dictionary only while spelling is on. Measured on
13 November 2026: 781 KB compressed at start before, 587 KB after.

#### Scenario: wasm-opt in CI
- **GIVEN** the CI, Pages and Obsidian plugin release workflows
- **WHEN** they build the WebAssembly
- **THEN** they install binaryen and the build fails without `wasm-opt`
<!-- test-js: apps/web/tests/site.test.mjs :: CI, the Pages workflow and the plugin release install wasm-opt and fail without it -->

#### Scenario: Only what is used is downloaded
- **GIVEN** the app with spelling off
- **WHEN** it starts
- **THEN** it downloads neither PDF import nor the dictionary, and turning spelling on downloads the dictionary then
<!-- test-js: apps/web/tests/app.test.mjs :: the app starts without downloading PDF import or, with spelling off, the dictionary -->
<!-- test-js: apps/web/tests/mirror-notes-app.test.mjs :: importing a PDF: each page becomes a note, and is mirrored, not sent as samples -->

### Requirement: Every core feature SHALL work without a connection after one visit

Opening, writing, editing and saving notes, the library and its folders,
and the spell checker SHALL work with no connection once the app has been
opened online one time.

#### Scenario: The app offline
- **GIVEN** the app opened once online, and a note written and saved
- **WHEN** the server is gone and the device is offline, and the app is opened again
- **THEN** the last note opens, new writing is saved, a new note is listed in the library, the first note opens again with the writing done offline, and the spell checker loads
<!-- test-js: apps/web/tests/offline-app.test.mjs :: with no connection the app opens, and notes are written, saved, listed and opened again -->

#### Scenario: Any address opens the app, a missing file stays missing
- **GIVEN** an installed app, offline
- **WHEN** a page it never saw is opened, and a file it has no copy of is fetched
- **THEN** the page opens the app, and the file fails as it would with no service worker, so it is never read as the app page
<!-- test-js: apps/web/tests/offline.test.mjs :: offline, a page opens the app but a missing file is not answered with the page -->

### Requirement: Handwriting SHALL be read offline once its model has been downloaded

#### Scenario: Reading offline
- **GIVEN** a model used once online
- **WHEN** the device is offline and the app is opened again
- **THEN** the word is read, with nothing asked of the network
<!-- test-js: apps/web/tests/offline-app.test.mjs :: handwriting is read offline once its model was downloaded -->
<!-- test-js: apps/web/tests/offline.test.mjs :: the recogniser library from the CDN is kept by the service worker and works offline -->

#### Scenario: An update keeps the models (regression)
The service worker deleted every cache of the site on each update,
Transformers.js's `transformers-cache` too, so the models were downloaded
again and reading stopped working offline after every update.
- **GIVEN** downloaded models and an old copy of the app in the browser's caches
- **WHEN** a new version of the app takes over
- **THEN** the models are kept and only the old copy of the app is cleared
<!-- test-js: apps/web/tests/offline.test.mjs :: an update keeps the handwriting models Transformers.js downloaded, and clears only old copies of the app (regression) -->

#### Scenario: No model yet and no connection
- **GIVEN** a model that was never downloaded, and no connection
- **WHEN** words are written
- **THEN** they wait (never given up), say they wait for a connection, a quiet note says so once instead of an error, and they are read when the connection is back
<!-- test-js: apps/web/tests/offline-app.test.mjs :: offline without the model, words wait (not given up) and are read when the connection is back -->

### Requirement: What goes to the backend SHALL wait for a connection

Training samples wait on the device (see `training-data-sharing`), a new
invite code entered offline is checked later (see `toolbar-and-settings`
and the launch gate tests), and automatic performance reports are retried.

#### Scenario: An automatic report offline
- **GIVEN** automatic performance reports on, and a slow moment while offline
- **WHEN** sending fails, and the connection comes back
- **THEN** the report is sent at once, without waiting for the next slow moment
<!-- test-js: apps/web/tests/perf.test.mjs :: an automatic report that could not go out offline is sent as soon as the connection is back -->
<!-- test-js: apps/web/tests/collect.test.mjs :: with no connection samples wait on the device and are sent later, even after a reload -->
<!-- test-js: apps/web/tests/launch-gate.test.mjs :: offline, the code is kept and checked later; a code the server turns down brings the gate back -->

## Open source used

| | wasm-bindgen, js-sys, web-sys | binaryen (`wasm-opt`) | Playwright (tests only) |
|---|---|---|---|
| Version | [wasm-bindgen](https://crates.io/crates/wasm-bindgen) 0.2.130 (pinned, with `wasm-bindgen-cli` at the same version), js-sys and web-sys 0.3 | version_123, in CI and `scripts/build-web.sh` | [playwright](https://www.npmjs.com/package/playwright) from `apps/web/package-lock.json` |
| Used for | The bridge between the Rust engine and the page: the `Canvas` class, WebGL2 and the browser types. | Shrinking and speeding up the published WebAssembly. | Driving the real app in headless Chromium in the browser tests. |
| Why this one | The standard way Rust talks to JavaScript in WebAssembly, run by the Rust and WebAssembly working group since 2017. | The WebAssembly Community Group's optimiser, since 2015. | Microsoft's browser automation for real Chromium; the tests send it synthetic Pointer Events with pen pressure and tilt. |
| Licence | MIT or Apache-2.0 | Apache-2.0 | Apache-2.0 |
| Not Rust | Rust. | C++, build only. | JavaScript, tests only. |
