## 1. Tests first

- [x] 1.1 Regression: an update keeps `transformers-cache` (fails on the old service worker)
- [x] 1.2 Regression: offline, a missing file is not answered with the app page (fails on the old service worker)
- [x] 1.3 The recogniser's library is kept and served offline (fails on the old service worker)
- [x] 1.4 The whole app offline with the server shut down: open, write, save, library, reopen, spell checker
- [x] 1.5 Recognition offline after one download, with the real Transformers.js and ONNX Runtime (fails on the old code)
- [x] 1.6 Offline without a model: words wait and are read when the connection is back
- [x] 1.7 An automatic report that failed offline goes when the connection is back

## 2. App

- [x] 2.1 `sw.js`: own caches only, pinned library cache, navigation-only fallback
- [x] 2.2 `recognizer-worker.js`: no local model requests
- [x] 2.3 `handwriting.js`: offline failures wait; `retryWaiting`
- [x] 2.4 `main.js`: register in any secure context, persistent storage, `online` retries
- [x] 2.5 Spec scenarios cite their tests
