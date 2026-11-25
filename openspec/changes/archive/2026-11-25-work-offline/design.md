# Design: work without an internet connection

## Service worker

Two caches, both named `bedrock-*` so the service worker knows which are
its own:

- `bedrock-vN` (the app): network first, `no-cache`, as before. Bumped to
  v33 so the new worker installs.
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

## Persistent storage and files downloaded on first use

Persistent storage (`navigator.storage.persist()`) is asked for by the
`cut-bandwidth-and-storage` change, after the first save; this change does
not ask again.

That change also downloads the spelling dictionary only while spelling is
on, and PDF import only when a PDF is opened. The service worker used to
fetch the dictionary at install anyway, so it is no longer in `SHELL`: like
PDF import, it is kept for offline the first time it is used. On the very
first visit the dictionary is fetched before the service worker takes over,
so when it does (`controllerchange`) and spelling is on, the app fetches the
two dictionary files once more through it.

## Open source used

No new library. Workbox (MIT, Google, widely used) was weighed for the
service worker. Bedrock needs two strategies (network first for the app,
cache first for one pinned file) in about 70 lines without a bundler;
Workbox would add a build step or a CDN script to the one file that has to
load offline. Transformers.js (Apache-2.0, already used and recorded in the
`handwriting-recognition` spec) does its own model and runtime caching,
which this change relies on rather than replaces.
