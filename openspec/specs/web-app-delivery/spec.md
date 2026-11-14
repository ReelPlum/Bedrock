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
- **GIVEN** the CI and Pages workflows
- **WHEN** they build the WebAssembly
- **THEN** they install binaryen and the build fails without `wasm-opt`
<!-- test-js: apps/web/tests/site.test.mjs :: CI and the Pages workflow install wasm-opt and fail without it -->

#### Scenario: Only what is used is downloaded
- **GIVEN** the app with spelling off
- **WHEN** it starts
- **THEN** it downloads neither PDF import nor the dictionary, and turning spelling on downloads the dictionary then
<!-- test-js: apps/web/tests/app.test.mjs :: the app starts without downloading PDF import or, with spelling off, the dictionary -->
<!-- test-js: apps/web/tests/collect.test.mjs :: importing a PDF: each page becomes a note, and every line is sent with the PDF's reading -->
