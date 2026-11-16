# Work without an internet connection

## Why

Frederik: "Make sure the program works without an Internet connection."
Bedrock is local-first, but an audit found three places where being offline
broke something, and one where it only looked broken:

| What | Network use | Offline before | Offline now |
|---|---|---|---|
| Opening, writing, editing, saving, the library and folders, PDF import, the spell checker | none (IndexedDB, Rust/WebAssembly, files shipped with the app) | worked after one visit (service worker) | same, now proven by a test with the server shut down |
| Launch gate | `GET /v1/stats` to check a new code | a stored code opens the app offline; a new code is kept and checked later | unchanged |
| Training samples | `POST /v1/samples` | queued on the device, sent later | unchanged |
| Handwriting recognition: Transformers.js | `cdn.jsdelivr.net`, exact version | only in the browser's HTTP cache, which the service worker ignored | kept by the service worker, works offline |
| Handwriting recognition: models and ONNX Runtime | `huggingface.co`, `cdn.jsdelivr.net` | kept by Transformers.js in `transformers-cache`, **but every app update deleted that cache** | kept across updates |
| Recognition with no model downloaded yet | as above | each word failed twice and was given up, with "not available here" | the word waits, a quiet note says it is read once online, and it is read when the connection is back |
| Automatic performance reports | `POST /v1/reports` | a failure waited for the next slow moment | also sent as soon as the connection is back |
| Error report sent by the person | `POST /v1/reports` | says it could not reach the team; Copy works | unchanged |
| Cloud sync | none yet (`cloud.js` is a stub) | n/a | n/a |
| Obsidian plugin | files packed into the plugin | worked | same; recognition there loads Transformers.js through Electron's cache |

Two bugs came out of it:

- **The models were deleted on every update.** The service worker's
  `activate` deleted every cache of the site, including Transformers.js's
  `transformers-cache`, so after each update the handwriting models
  (hundreds of MB) were downloaded again and recognition stopped working
  offline.
- **A missing file was answered with the app page.** Offline, any request
  the service worker had no copy of got `index.html`. Transformers.js asks
  Bedrock's own host for models first (`/models/...`), so offline it would
  read the page as a model file.

## What changes

- `sw.js`: clears only Bedrock's own old caches (`bedrock-*`); keeps
  Transformers.js from the CDN (exact version only) in `bedrock-libs-v1`,
  cache first; only a page navigation falls back to the app page.
- `recognizer-worker.js`: `env.allowLocalModels = false`, so models are
  never asked from Bedrock's host.
- `handwriting.js`: a word that fails while the device is offline is not
  counted as a failed try; it shows "Waiting for a connection to download
  the handwriting model" and is read on the `online` event.
- `main.js`: the service worker is registered in any secure context (also
  `localhost`, so the tests run with it), not inside a host; asks for
  persistent storage (`navigator.storage.persist()`) so the browser does not
  clear notes and models when space runs low; on `online`, waiting words
  are read and automatic reports are retried.

## Data formats

None change. No note, sidecar, library, sample, report or API field is
added or changed. `bedrock-libs-v1` is a browser cache of a CDN file, not
data people keep.

## Security

No security rule is weakened. The launch gate already worked offline (a
code accepted once is stored; a new code entered offline is kept and
checked with the server when samples are next sent, and a code the server
turns down brings the gate back). That last point means someone offline can
start the app with any code until the device is next online; this was
already so and is not changed here. Only exact-version CDN files are kept,
and only full (non-opaque) answers.

## Impact

- `apps/web/sw.js`, `src/main.js`, `src/handwriting.js`, `src/recognizer-worker.js`
- Tests: `tests/offline.test.mjs`, `tests/offline-app.test.mjs` (new), `tests/perf.test.mjs`
- Spec: `web-app-delivery`
