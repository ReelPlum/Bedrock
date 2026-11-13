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
