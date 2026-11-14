# training-data-sharing Specification

## Purpose
Sending handwriting samples to the private training backend, only with
consent: from the training pages, and (with a setting) words written in
notes. `docs/training-data.md` explains it for people; the backend's checks
are in the Bedrock-Backend repository (`training-samples` spec there).

## Data formats

**Sample** (`bedrock-training`, version 2), made in `apps/web/src/collect.js`:

| Field | Value |
|---|---|
| `format`, `version` | `"bedrock-training"`, `2` |
| `id` | UUID version 7 made on the device |
| `source` | `train` or `note` |
| `kind` | `text`, `math`, `scribble` or `drawing` |
| `label` | What the ink says, NFC, trimmed. LaTeX for maths. Lines of a paragraph separated by `\n`. Empty only for `unchecked` without a reading, or `drawing`. |
| `label_source` | `prompt` (train), or `unchecked`, `confirmed`, `corrected` (note) |
| `model_reading`, `model_engine` | Optional: what the recogniser read, and which model |
| `language` | BCP 47; `zxx` for maths |
| `device` | Coarse class (`ipad`, `iphone`, `android`, `windows`, `mac`, `linux`, `other`) |
| `pointer` | `pen`, `mouse` or `touch` (the one most strokes used) |
| `written`, `app_version` | Unix ms on the device; app version |
| `box` | Optional `{ width, height }` of the training box |
| `supersedes` | Optional ids of this writer's earlier samples of the same ink |
| `channels`, `strokes` | The note format's channels, and `{ start, points }` per stroke; nothing else of the stroke |

Version 1 existed only inside the first training page and was never stored
or sent, so version 2 is the oldest version anyone holds.

**Request**: `{ "contributor": { "id", "consent_version", "handedness"?, "locale"? }, "samples": [...] }`
to `POST /v1/samples` with `Authorization: Bearer <invite code>`. Sent with
`Content-Encoding: gzip` where the browser has `CompressionStream` (since
November 2026); the JSON inside is the same.

**On the device**: the queue is IndexedDB database `bedrock-collect`
(version 1, store keyed by sample `id`); consent, code and contributor id
are in local storage `bedrock.collect.v1`; which sample was sent for each
note word is in `bedrock.sharedWords.v1` (the newest 5000).

## Requirements

### Requirement: Nothing SHALL be kept or sent without consent

#### Scenario: Practice only
- **GIVEN** no consent
- **WHEN** the training pages are used
- **THEN** nothing is kept or sent, and no contributor id is made
<!-- test-js: apps/web/tests/collect.test.mjs :: without consent the pages are practice only: nothing is kept or sent -->
<!-- test-js: apps/web/tests/collect.test.mjs :: the consent card: no tick or no code saves nothing -->

#### Scenario: The server address is built in
- **GIVEN** the training page
- **WHEN** it looks for where to send
- **THEN** there is no address field, the site always uses the built-in `https` address, and only a page on this computer may use another
<!-- test-js: apps/web/tests/collect.test.mjs :: people cannot change the server address: there is no field, and only a page on this computer may use another -->
<!-- test-js: apps/web/tests/collect.test.mjs :: ids, device class and the server address check -->

### Requirement: Samples SHALL be queued on the device and never lost to a bad connection

#### Scenario: Queue and send
- **GIVEN** consent and an invite code
- **WHEN** samples are made
- **THEN** they are queued, sent with the code once a minute or at once when the page is hidden, in batches under the request size limit (always at least one), and leave the queue when stored
<!-- test-js: apps/web/tests/collect.test.mjs :: after consent a sample is queued, sent with the code, and taken off the queue -->
<!-- test-js: apps/web/tests/collect.test.mjs :: samples wait for the next send, once a minute, or go at once when the page is hidden -->
<!-- test-js: apps/web/tests/collect.test.mjs :: a batch stays under the request size limit, but always takes at least one sample -->

#### Scenario: Offline, refused and failed
- **GIVEN** queued samples
- **WHEN** there is no connection, the server refuses one for good, could not store one, or the code is wrong
- **THEN** offline samples wait (even across a reload), a refused one is dropped, one that failed to store is kept, and a wrong code keeps them and says so
<!-- test-js: apps/web/tests/collect.test.mjs :: with no connection samples wait on the device and are sent later, even after a reload -->
<!-- test-js: apps/web/tests/collect.test.mjs :: a sample the server will never take is dropped; one it could not store is kept -->
<!-- test-js: apps/web/tests/collect.test.mjs :: a wrong invite code keeps the samples and says so -->

#### Scenario: Delete my contributions
- **GIVEN** samples sent and queued
- **WHEN** "Delete my contributions" is chosen
- **THEN** the server is asked to delete them, the queue is emptied and saving is turned off
<!-- test-js: apps/web/tests/collect.test.mjs :: "Delete my contributions" asks the server to delete, empties the queue and turns saving off -->

### Requirement: Words from notes SHALL be sent only with the setting on, and checked words SHALL replace unchecked ones

#### Scenario: The setting
- **GIVEN** no consent, or the setting off
- **WHEN** the writer ticks a reading as right
- **THEN** the setting cannot be turned on before consent, and nothing is sent while it is off
<!-- test-js: apps/web/tests/collect.test.mjs :: notes: the setting cannot be turned on before consent -->
<!-- test-js: apps/web/tests/collect.test.mjs :: notes: "This is right" marks a reading as checked, and sends nothing while the setting is off -->

#### Scenario: Checked words
- **GIVEN** the setting on
- **WHEN** the writer confirms or corrects a word
- **THEN** that one word is sent moved to 0,0, labelled with the confirmed or corrected text, with the reading alongside
<!-- test-js: apps/web/tests/collect.test.mjs :: notes: with the setting on, a confirmed word is sent as its line, moved to 0,0 -->

#### Scenario: Unchecked words
- **GIVEN** "Send every word" on
- **WHEN** a new word is read
- **THEN** it is sent once its reading settles (or at once when the app is hidden) as `unchecked`, then replaced through `supersedes` when the writer checks it; words from before the setting are not sent by themselves; with the recogniser off they are sent without text
<!-- test-js: apps/web/tests/collect.test.mjs :: notes: with "Send every word" on, a new word is sent unchecked, then replaced when the writer checks it -->
<!-- test-js: apps/web/tests/collect.test.mjs :: notes: an unchecked reading waits until it settles, and is sent at once when the app is hidden -->
<!-- test-js: apps/web/tests/collect.test.mjs :: notes: words written before the setting was on are not sent by themselves -->
<!-- test-js: apps/web/tests/collect.test.mjs :: notes: with the recogniser off, words are sent without text -->

### Requirement: Uploads SHALL be gzipped, and SHALL still reach a backend that cannot read gzip

#### Scenario: Gzip
- **GIVEN** a sample to send
- **WHEN** it is sent
- **THEN** the request is gzipped and unpacks to exactly the JSON the app would send plain
<!-- test-js: apps/web/tests/collect.test.mjs :: uploads are gzipped, and hold exactly the JSON the app would send plain -->

#### Scenario: A backend from before gzip
- **GIVEN** a backend that refuses the gzipped request
- **WHEN** a batch is sent
- **THEN** the same batch goes as plain JSON, and later batches on that page go plain at once
<!-- test-js: apps/web/tests/collect.test.mjs :: a backend that cannot read gzip gets the same batch as plain JSON, and plain JSON from then on -->
