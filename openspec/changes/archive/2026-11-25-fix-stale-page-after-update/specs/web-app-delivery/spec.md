# web-app-delivery Specification

## MODIFIED Requirements

### Requirement: The app SHALL work offline and pick up updates

#### Scenario: Service worker checks with the server
- **GIVEN** an installed app and a new version on the server
- **WHEN** the app loads online
- **THEN** the service worker checks files with the server instead of using a copy the browser kept, and offline it serves its own copy
<!-- test-js: apps/web/tests/offline.test.mjs :: the service worker checks files with the server instead of using a copy the browser kept -->

#### Scenario: The page itself is checked with the server
- **GIVEN** an installed app whose page the browser may keep for 10 minutes
- **WHEN** a new version goes live and the app is opened again
- **THEN** the new page is loaded, so it never runs with scripts from another version
<!-- test-js: apps/web/tests/offline.test.mjs :: after an update the page itself comes from the server too, so it never mixes with newer scripts -->

#### Scenario: A page from two versions
- **GIVEN** a page put together from files of two versions just after an update
- **WHEN** it fails to start
- **THEN** it says to reload instead of staying empty
<!-- test-js: apps/web/tests/train.test.mjs :: a page put together from two versions (just after an update) says to reload instead of staying empty -->

#### Scenario: The app heals itself after one reload
- **GIVEN** the app fails to start because its page is older than its scripts
- **WHEN** it starts
- **THEN** it reloads once by itself and starts; if it fails again it says so with a Reload button and does not reload again
<!-- test-js: apps/web/tests/app.test.mjs :: a page from an older version than its scripts reloads once by itself and starts; if that does not help it says so with a Reload button -->
