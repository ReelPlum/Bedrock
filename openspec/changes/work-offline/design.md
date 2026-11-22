# Design: work without an internet connection

## Service worker

Two caches, both named `bedrock-*` so the service worker knows which are
its own:

- `bedrock-vN` (the app): network first, `no-cache`, as before. Bumped to
  v32 so the new worker installs.
- `bedrock-libs-v1` (the recogniser's library): cache first. The URL holds
  an exact version (`@huggingface/transformers@4.3.1`), so the file never
  changes; a new version is a new URL. Only that package is kept: its
  ONNX Runtime and the models are already kept by Transformers.js itself
  (`useBrowserCache`, `useWasmCache`, cache `transformers-cache`), and
  keeping them twice would cost tens of MB. When `TRANSFORMERS` moves to a
  new version, bump `LIBS` so the old copy is dropped.

`activate` deletes only caches that start with `bedrock-` and are not
current. `transformers-cache` and anything else on the origin is left
alone.

When the network fails and there is no copy, a navigation gets
`index.html` (the app opens at any address), while any other request gets a
network error, as it would with no service worker.

## Recognition offline

Transformers.js loads a model from the browser cache first, so once a model
has been downloaded it loads offline. `allowLocalModels = false` stops it
asking Bedrock's host for `/models/...` first.

If the model was never downloaded, loading fails. When `navigator.onLine`
is false the failure is not counted towards the two tries a word gets; the
word's status says it waits for a connection, a toast says so once, and the
`online` event schedules a pass. `onLine === true` with no real connection
still counts as a failure, as before.

## Persistent storage

`navigator.storage.persist()` asks the browser to keep IndexedDB (the
notes) and the caches when space runs low. Safari and Chrome decide without
asking; Firefox asks the person once. It is not called inside a host.

## Open source used

No new library. Workbox (MIT, Google, widely used) was weighed for the
service worker. Bedrock needs two strategies (network first for the app,
cache first for one pinned file) in about 70 lines without a bundler;
Workbox would add a build step or a CDN script to the one file that has to
load offline. Transformers.js (Apache-2.0, already used and recorded in the
`handwriting-recognition` spec) does its own model and runtime caching,
which this change relies on rather than replaces.
