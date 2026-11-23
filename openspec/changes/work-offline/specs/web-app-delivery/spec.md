# Work without an internet connection

## ADDED Requirements

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
