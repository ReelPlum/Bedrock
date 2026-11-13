# Smooth pen input with Google's Ink Stroke Modeler

## Why

Bedrock smooths pen input with its own filters (1€ filters on position,
pressure and tilt). Google's Ink Stroke Modeler does this job and is used in
Google's own handwriting apps: it models the pen tip as a mass on a spring
behind the real input, which takes out hand tremor and the stair steps of
whole-pixel samples while keeping the corners of letters. The open source
survey suggested it, and Frederik asked for the official C++ version
(docs/open-source-first.md: not Rust, so it needed Frederik's approval,
which they gave).

## What changes

- New crate `crates/ink-stroke-modeler`: the modeler's C++ source and the
  parts of abseil it uses, copied in at pinned commits by
  `scripts/vendor-ink-stroke-modeler.sh`, a small C interface and a safe
  Rust wrapper. It builds with the `cc` crate: the system C++ compiler for
  tests, and the WASI SDK's clang for the web app's WebAssembly, linked into
  the same module as the Rust code (no extra download, no WASI calls at run
  time).
- `pen::filter_points` uses the modeler for every stroke with pen timing,
  old ink included. Strokes without timing (imported ones) keep the old
  path, which leaves them as they are. Steady hand widens the range of
  speeds the modeler smooths.
- Frederik chose: on by default, with a "Line smoothing" setting
  (Natural / Classic) that brings back today's filters. It is a device
  setting like steady hand, kept out of notes.
- `scripts/install-wasi-sdk.sh` downloads WASI SDK 25 and checks its
  checksum; `scripts/build-web.sh` runs it when the SDK is missing, and CI
  caches it.

## Data formats

None change. Notes keep the raw pen samples; the modeler only changes how
they are drawn, so a note looks the same as before after switching to
Classic.

## Impact

- `crates/bedrock-core/src/pen.rs`, `tessellate.rs` (the predicted tail
  still uses the 1€ filters, so a wrong prediction does not bend the line),
  `crates/bedrock-web` (`set_smoother`), `apps/web` (setting, menu, service
  worker cache), CI and Pages workflows.
- About 230 files of vendored C++ (2.8 MB of abseil source, 232 KB of the
  modeler); none of it is edited by hand.
- The WebAssembly grows by about 0.1 MB before compression (the modeler,
  abseil and the C and C++ libraries).
- Speed: the 100 000 stroke perf test stays inside its budgets (incremental
  sync after one stroke about 8.5 ms against 50 ms, measured 7.6 ms before).
