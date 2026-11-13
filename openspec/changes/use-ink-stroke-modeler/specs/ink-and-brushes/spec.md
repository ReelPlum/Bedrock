# ink-and-brushes Specification

## ADDED Requirements

### Requirement: Pen input SHALL be smoothed by Google's Ink Stroke Modeler, with the old filters as a choice

Line smoothing is a device setting like steady hand: remembered on the
device, applied to old ink too, and never saved in notes, which keep the raw
pen samples.

#### Scenario: Tremor is taken out and the line keeps its ends
- **GIVEN** a shaky line drawn with a pen that reports a sample every few milliseconds
- **WHEN** it is drawn with the usual setting
- **THEN** the modeler takes out the wobble, the line starts where the pen touched down and ends where it lifted, at any zoom
<!-- test: the_modeler_takes_out_tremor_and_keeps_both_ends -->
<!-- test: the_modeler_works_at_any_zoom -->
<!-- test: the_modeler_is_the_usual_smoother -->
<!-- test: a_stroke_is_modelled_from_down_to_up -->
<!-- test: shaky_slow_movement_is_smoothed -->
<!-- test: smoothing_keeps_sharp_corners_of_letters -->

#### Scenario: Classic brings back the old filters
- **GIVEN** the "Line smoothing" setting in the menu
- **WHEN** Classic is chosen
- **THEN** every line, old ink included, is drawn with Bedrock's own filters again, and the choice is remembered after a reload
<!-- test-js: apps/web/tests/app.test.mjs :: line smoothing: the Ink Stroke Modeler smooths timed pen input, Classic brings back the old filters -->
<!-- test-js: apps/web/tests/app.test.mjs :: pressure curve, steady hand and line smoothing survive a reload -->

#### Scenario: Strokes without timing and bad input
- **GIVEN** an imported stroke without pen timing, or input the modeler refuses
- **WHEN** it is drawn
- **THEN** it is drawn with the old filters (which leave untimed strokes as they are), and nothing crashes
<!-- test: strokes_without_timing_skip_the_modeler -->
<!-- test: mistakes_are_refused_not_crashes -->

## Open source used

| | Ink Stroke Modeler |
|---|---|
| Version | [google/ink-stroke-modeler](https://github.com/google/ink-stroke-modeler) at `f2388813b0b25bc3e33d143d369a8367ab2e30c8`, copied into `crates/ink-stroke-modeler/third_party` by `scripts/vendor-ink-stroke-modeler.sh` |
| Used for | Smoothing pen input: position (a spring model of the pen tip), pressure and tilt. Prediction is off; the live prediction keeps Bedrock's 1€ filters. |
| Why chosen | It does exactly this job and nothing else, and it is Google's own solution from its handwriting apps. It is not Rust: C++20. Frederik approved it and asked for the official C++ version over a port. It is built from source with the `cc` crate and linked into the same WebAssembly module as Bedrock, so the web app gains no extra download or JavaScript glue. |
| Why it is mature | Open sourced by Google in 2021 from the ink code of its handwriting products, with its own test suite. Google's newer Ink library now carries its own copy of this modeling code, so this repository changes rarely; it is small and complete, and pinning a commit keeps it stable. |
| Licence | Apache-2.0: commercial use allowed. The licence file is kept with the copied source. |
| Tuning | Distances scaled to input pixels: writing speed 400 px/s, wobble smoothed fully below 2% of it and not at all above 3%, over 0.02 s; spring 8/32400 (Google's 11/32400 rounded the tip of a small "v"). Steady hand widens the wobble range up to five times. |

| | Abseil (C++) |
|---|---|
| Version | [abseil/abseil-cpp](https://github.com/abseil/abseil-cpp) 20250512.0 (`bc257a88f7c1939f24e0379f14a3589e926c950c`), only the files the modeler uses |
| Used for | `absl::Status` and strings, which the modeler's interface uses. |
| Why chosen | The modeler depends on it. Its mutex and CPU count are replaced by single-thread versions (`absl_single_thread.cc`): WebAssembly here has one thread, and only Cord's sampling uses the mutex, which the modeler never touches. |
| Why it is mature | Google's own C++ base library, used across Google and in Chromium, released twice a year with long-term-support versions. |
| Licence | Apache-2.0: commercial use allowed. The licence file is kept with the copied source. |

| | WASI SDK (build tool) |
|---|---|
| Version | [wasi-sdk 25](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-25), installed by `scripts/install-wasi-sdk.sh` with pinned checksums |
| Used for | Building the C++ for WebAssembly: clang, libc++ and wasi-libc. Not shipped as such; only the parts linked in end up in the web app. |
| Why chosen | The standard clang toolchain for C and C++ on WebAssembly, maintained by the Bytecode Alliance; works with Rust's `wasm32-unknown-unknown` target, unlike Emscripten, which brings its own JavaScript runtime. The few WASI calls the C library could make are answered by small Rust stubs and are never made while drawing. |
| Why it is mature | Since 2019, used by many C and C++ projects that ship WebAssembly, with regular releases. |
| Licence | Apache-2.0 with LLVM exception (clang, libc++), MIT/BSD-style (wasi-libc): commercial use allowed. |
