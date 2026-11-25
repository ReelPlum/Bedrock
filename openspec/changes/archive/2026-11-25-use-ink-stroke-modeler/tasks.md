# Tasks

## 1. Ink Stroke Modeler

- [x] 1.1 Vendor the modeler and abseil at pinned commits; C interface and Rust wrapper with tests
- [x] 1.2 Build it into the web app's WebAssembly with the WASI SDK (installer with checksums, build script, CI cache); no WASI imports
- [x] 1.3 Use it for every timed stroke, tuned to input pixels; keep letters' corners; prediction keeps the old filters
- [x] 1.4 "Line smoothing" setting: Natural (default) or Classic, remembered on the device
- [x] 1.5 Rust, perf and browser tests pass
