# ink-and-brushes Specification

## Purpose
How a pen sample becomes ink on the page: the five brushes, pressure, tilt
and speed, the writer's pen feel settings, line styles, smoothing and the
shape of the drawn line. The raw samples are always saved untouched (see
`note-format`); everything here is how they are drawn, so it can improve
without changing any note.

## Requirements

### Requirement: Each brush SHALL respond to the pen the way its tool does

Pen, pencil, fountain pen, marker and highlighter SHALL each turn pressure,
tilt, direction and speed into width and opacity in their own way, and every
brush SHALL grow or hold its width as pressure rises.

#### Scenario: Pressure widens every brush
- **GIVEN** each brush
- **WHEN** pressure rises from light to full
- **THEN** the width never shrinks; with pressure sensitivity off the width stays even
<!-- test: every_brush_grows_or_holds_with_pressure -->
<!-- test: no_pressure_sensitivity_means_even_width -->
<!-- test-js: apps/web/tests/app.test.mjs :: pressure changes the line width -->

#### Scenario: A tilted pencil shades
- **GIVEN** the pencil
- **WHEN** it is tilted towards the paper
- **THEN** the line is wider and lighter than when upright
<!-- test: tilted_pencil_is_wider_and_lighter -->
<!-- test-js: apps/web/tests/app.test.mjs :: tilting the pencil makes a broader stroke -->

#### Scenario: The fountain pen nib
- **GIVEN** the fountain pen
- **WHEN** it moves in different directions, slowly with jitter, or while tilting
- **THEN** its width follows the direction against the nib, ignores slow jitter and changes smoothly with tilt
<!-- test: fountain_pen_depends_on_direction -->
<!-- test: fountain_nib_ignores_jitter_when_moving_slowly -->
<!-- test: fountain_width_is_continuous_as_the_pen_tilts -->

#### Scenario: The highlighter
- **GIVEN** a highlighter stroke with pen ink drawn over it
- **WHEN** the page is drawn
- **THEN** the highlighter is translucent and under the ink, and the ink over it stays continuous
<!-- test: highlighter_is_translucent -->
<!-- test: translucent_strokes_get_own_chunks_and_highlighters_go_first -->
<!-- test-js: apps/web/tests/app.test.mjs :: ink drawn over a highlighter stays continuous -->

#### Scenario: Speed thins pens, never more than pressure
- **GIVEN** a pen stroke written fast and one written slowly
- **WHEN** they are drawn
- **THEN** the fast one is thinner, pressure still matters more than speed, and strokes without timestamps are not thinned
<!-- test: faster_strokes_are_thinner_for_pens_only -->
<!-- test: pressure_matters_more_than_speed -->
<!-- test: speed_only_thins -->
<!-- test: strokes_without_timestamps_are_not_thinned -->
<!-- test: speed_survives_shared_timestamps -->
<!-- test: missing_timestamps_are_detected -->

### Requirement: The writer SHALL be able to tune the pen feel

The pressure curve and steady hand are device settings, remembered on the
device and applied to old ink too. Per-brush tuning (pressure sensitivity,
tapers) is saved with each new stroke; the "usual" setting saves nothing.

#### Scenario: Pressure curve
- **GIVEN** the pressure curve editor
- **WHEN** points are added and dragged, or soft or firm is chosen
- **THEN** the curve stays smooth and rising through its points, is remembered after a reload, and old ink is redrawn with it
<!-- test: pressure_curve_through_points_is_smooth_and_monotone -->
<!-- test: pressure_curve_is_monotone_hits_endpoints_and_defaults_to_linear -->
<!-- test-js: apps/web/tests/app.test.mjs :: pressure curve: points can be added and dragged, it is remembered, and soft/firm still works -->
<!-- test-js: apps/web/tests/app.test.mjs :: pressure curve, steady hand and line smoothing survive a reload -->
<!-- test-js: apps/web/tests/app.test.mjs :: pen pressure feel: soft draws light touches wider, is remembered, and redraws old ink -->

#### Scenario: Steady hand
- **GIVEN** a shaky line
- **WHEN** steady hand is on
- **THEN** the line wobbles less, including ink drawn before it was turned on, for every pen
<!-- test: steady_hand_smoothing_adds_to_every_pen -->
<!-- test-js: apps/web/tests/app.test.mjs :: steady hand smooths a shaky line, old ink included -->

#### Scenario: Per-brush tuning is saved with the stroke
- **GIVEN** a brush with less pressure sensitivity or its own tapers
- **WHEN** a stroke is drawn and saved
- **THEN** the tuning is in that stroke's brush and overrides the brush kind; with "usual" nothing extra is saved
<!-- test: tuning_is_optional_in_the_file_and_overrides_the_kind -->
<!-- test: fractional_settings_are_written_as_short_decimals -->
<!-- test-js: apps/web/tests/app.test.mjs :: pen feel: tuning is saved with new strokes, per brush, and "usual" leaves it out -->
<!-- test-js: apps/web/tests/app.test.mjs :: pen feel: less pressure sensitivity keeps light and hard lines closer in width -->

### Requirement: Line styles and the stabiliser SHALL be set per brush and saved with each stroke

#### Scenario: Dashed, dotted and stabilised lines
- **GIVEN** a brush set to dashed or dotted, with a stabiliser
- **WHEN** a line is drawn and the note reopened
- **THEN** dashes have gaps, dots are evenly spaced circles, the stabiliser smooths jitter at any input rate and ends at the pen, and the settings come back
<!-- test: dashed_line_has_gaps -->
<!-- test: dotted_line_is_evenly_spaced_dots -->
<!-- test: solid_is_one_piece -->
<!-- test: stabilizer_smooths_jitter_and_ends_at_the_pen -->
<!-- test: stabilizer_is_rate_independent -->
<!-- test: pulled_string_is_rate_independent_and_ends_at_the_pen -->
<!-- test: eased_stabiliser_follows_fast_strokes_closer -->
<!-- test-js: apps/web/tests/app.test.mjs :: dashed and dotted line styles and the stabiliser are set per brush and saved -->

### Requirement: The drawn line SHALL be clean and faithful to the pen

#### Scenario: Smooth, antialiased geometry
- **GIVEN** strokes of any shape, far from the origin or at any zoom
- **WHEN** they are turned into geometry
- **THEN** meshes are valid and precise, edges are antialiased, dots and ends are true circles, and straight lines use few pieces
<!-- test: empty_stroke_has_empty_mesh -->
<!-- test: tap_makes_a_dot -->
<!-- test: line_mesh_is_valid_and_covers_the_line -->
<!-- test: mesh_is_precise_far_from_origin -->
<!-- test: outline_is_closed_polygon_around_samples -->
<!-- test: dots_and_ends_are_true_circles -->
<!-- test: straight_lines_use_few_capsules -->
<!-- test: duplicate_points_do_not_produce_nan -->
<!-- test: bounds_include_brush_radius -->
<!-- test-js: apps/web/tests/app.test.mjs :: stroke edges are antialiased, not stair-stepped -->
<!-- test-js: apps/web/tests/app.test.mjs :: a big dot is a true circle, not a polygon -->

#### Scenario: Noise does not show
- **GIVEN** jittery, slow, whole-pixel or pressure-spiking input
- **WHEN** it is drawn
- **THEN** there are no spikes, blobs, kinks or wobbles, letters keep their sharp corners, and the first unreliable pressure is ignored
<!-- test: one_euro_smooths_slow_noise_but_follows_fast_motion -->
<!-- test: decimate_keeps_ends_and_spacing -->
<!-- test: input_cleanup_keeps_endpoints -->
<!-- test: resample_density_follows_step -->
<!-- test: slow_jittery_reversal_has_no_spikes -->
<!-- test: pressure_spike_does_not_make_a_blob -->
<!-- test: slow_jittery_circle_stays_round -->
<!-- test: hesitation_does_not_kink_the_line -->
<!-- test: unreliable_first_pressure_is_ignored -->
<!-- test: whole_pixel_input_is_not_wobbly_at_100_percent -->
<!-- test: smoothing_follows_the_zoom_the_stroke_was_drawn_at -->
<!-- test: smoothing_keeps_sharp_corners_of_letters -->
<!-- test: pencil_noise_does_not_make_the_width_wobble -->
<!-- test: jitter_is_filtered -->

#### Scenario: Tapers
- **GIVEN** a stroke with taper settings, drawn by a finger or flicked
- **WHEN** it is drawn
- **THEN** tapers follow the length of the line and spare dots, and a stroke still being drawn gets no end taper
<!-- test: tapers_follow_arc_length_and_spare_dots -->
<!-- test: taper_settings_fingers_and_flicks -->
<!-- test: live_strokes_get_no_end_taper -->

### Requirement: Every pen sample SHALL be recorded, and only real ones saved

#### Scenario: Coalesced and predicted samples
- **GIVEN** a pen that reports coalesced and predicted samples
- **WHEN** a stroke is written
- **THEN** every coalesced sample is saved, predicted ones are drawn while writing but never saved, and a wrong prediction does not bend the real line
<!-- test: live_stroke_includes_predictions_but_does_not_save_them -->
<!-- test: a_wrong_prediction_does_not_bend_the_real_line -->
<!-- test-js: apps/web/tests/app.test.mjs :: coalesced pen samples are all recorded, predicted ones are not saved -->

#### Scenario: Times within a stroke never go back
- **GIVEN** an iPad that gives a coalesced sample an earlier time than the one before it
- **WHEN** a stroke is written
- **THEN** that sample keeps the time of the one before it, so a stroke's times never go backwards
<!-- test: bug_a_sample_with_an_earlier_time_does_not_go_back_in_time -->

#### Scenario: Lifting the pen ends the line
- **GIVEN** a pencil that is lifted and then hovers
- **WHEN** hover samples arrive after the lift
- **THEN** they add no ink and the stroke ends where the tip left the paper
<!-- test: pen_up_position_after_lift_is_not_ink -->
<!-- test-js: apps/web/tests/app.test.mjs :: lifting the pencil ends the line: hover moves after lift add no ink -->

#### Scenario: A hovering pencil shows where it lands
- **GIVEN** a pencil hovering over the page
- **WHEN** it moves
- **THEN** a brush-sized, brush-coloured mark follows the tip and scales with zoom (a ring for the eraser), hides on touch and when the pencil leaves, and draws nothing; a mouse shows none
<!-- test-js: apps/web/tests/app.test.mjs :: a hovering pencil shows where the tool lands and how big it is, and draws nothing -->

#### Scenario: Raw tilt input is cleaned
- **GIVEN** pen events with garbage values or no tilt
- **WHEN** they are read
- **THEN** values are clamped, an upright pen has no tilt and tilt maps to an azimuth
<!-- test: sanitize_clamps_garbage -->
<!-- test: upright_pen_has_no_tilt -->
<!-- test: tilt_x_maps_to_azimuth_zero -->
<!-- test: handwriting_trace_replays_faithfully -->

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

#### Scenario: Imported handwriting keeps its shape
- **GIVEN** a stroke imported from a PDF, whose points are exact and whose timing is made up from its length
- **WHEN** it is drawn with the modeler
- **THEN** small handwriting stays within 0.15 points of the line the PDF drew
<!-- test: imported_strokes_keep_their_shape_through_the_pens_smoothing -->

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
