# performance Specification

## Purpose
Noticing when Bedrock is slow for someone (the pen lags, it stutters, a tap
or a save takes long), and what was running at that moment, so it can reach
the Bedrock team. Slow moments go into the error log and "Share with the
Bedrock team" (the `error-reporting` spec). Only when the person switches on
"Send performance reports automatically", after reading what is sent, are
they sent by themselves. The backend side is the `error-reports` spec
(report version 2) in Bedrock-Backend.

Approved by Frederik on 2026-11-13 ("Build it; also opt-in automatic"), as
report version 2, the slow entries in `bedrock.errors.v1` and the setting
`bedrock.perf.v1`. The research is the "Tracking performance" Claude Doc.

| File | What it does |
|---|---|
| `apps/web/src/perf.js` | The watcher (`PerfWatcher`, shared as `perf`), job timing, and `AutoSender`. |
| `apps/web/src/errors.js` | `bedrockErrors.slow`: logs slow moments, merges repeats, the "Bedrock seems slow" notice. |
| `apps/web/src/error-report.js` | Builds version 2 when a report holds slow moments or is automatic. |
| `apps/web/src/main.js`, `input.js`, `handwriting.js` | Feed frames to the watcher; time `save`, `open`, `library`, `import-pdf` and `recognize`; the menu setting. |
| `apps/obsidian/src/report.js`, `session.js`, `main.js` | The plugin times `read`, `write`, `index` and `unpack`, and adds its slow moments to the canvas's automatic reports. |

## Open source used

No new library. `web-vitals` (Apache-2.0, Google) was weighed first: it
measures INP and LCP for a whole page visit, which says a page is slow but
not when or why, and has no pen latency or job timing. The browser APIs it
uses are used directly: Event Timing (`PerformanceObserver` type `event`,
Safari 26.2+, Chrome, Firefox) for slow taps, Long Animation Frames (type
`long-animation-frame`, Chromium, so Obsidian on desktop) for the scripts
that held the page, and `performance.mark`/`measure` for jobs, so they also
show in the browser's own profiler. Pen latency and stutters come from the
frames Bedrock already draws (`input.js`).

## Data formats

**Slow entry** in the log (`bedrock.errors.v1`) and in a report:
`{ kind: "slow", message, what, ms, at, count, snapshot? }`, `what` one of:

| `what` | When |
|---|---|
| `latency` | Over one stroke (at least 8 frames), the slowest 5% of frames came over 3 frame intervals and over 25 ms after their pen event (50 ms at 60 frames a second, 25 ms at 120) |
| `stutter` | One frame came over 100 ms after the pen or finger moved |
| `slow_tap` | A tap or key took over 200 ms to answer (Event Timing) |
| `long_job` | A job over its limit: `save` 2 s, `open` 3 s, `library` 2 s, `recognize` 8 s, `import-pdf` 60 s; in the plugin `read` 2 s, `write` 2 s, `index` 3 s, `unpack` 10 s |

The same `what` and message within 30 s adds to one entry (count, the
slowest `ms`, and that moment's snapshot).

**Snapshot**: `running` (up to 10 `{ job, ms, running? }`: jobs running then
and those that ended in the 2 s before; a `recognize` job is timed from when
the recogniser starts on that word with its model ready, not while it waits
for other words or a model download), `doing` (`writing`, `moving`,
`idle`; `mobile` or `desktop` for the plugin), `tool`, `strokes_bucket`
(`0-100`, `100-1k`, `1k-5k`, `5k-20k`, `20k+`), `zoom_bucket`
(`under-half`, `half-1`, `1-2`, `2-4`, `4+`), `recognizer` (`both`, `live`,
`careful`, `off`), `scripts` (up to 5 `{ source, function?, ms }` from Long
Animation Frames). A Bedrock script is named by its file name with its
function; any other is only `obsidian`, `another plugin`, `extension`,
`other` or `unknown`, without a function name.

**Report version 2**: as version 1, plus `sent` (`person` or `auto`) and
slow entries. A report without slow entries is still sent as version 1.
An automatic report holds only slow entries and no comment.

**Setting** `bedrock.perf.v1` (local storage):
`{ auto, day, count, last }`: whether automatic reports are on, how many
were sent on `day` (UTC), and the time of the newest entry sent.

## Requirements

### Requirement: Slow moments SHALL be noticed with what was running, without note content

#### Scenario: The four kinds
- **GIVEN** a smooth stroke, a laggy stroke while saving, a frame 150 ms after a move, a save of 2.5 s, a quick and a slow tap, and an untimed job
- **WHEN** the watcher sees them
- **THEN** it logs latency, stutter, long_job and slow_tap, each with the running jobs, the tool, the stroke and zoom classes and the recogniser mode, and nothing else the page said
<!-- test-js: apps/web/tests/perf.test.mjs :: the watcher notices pen lag, stutters, slow taps and long jobs, with what was running -->

#### Scenario: Pen lag at the screen's frame rate (regression)
A report from iPad Safari logged "The pen lagged" at 32 to 37 ms, marked
`idle`. A browser normally takes up to 2 frames from a pen event to the frame
that draws it, which is 33 ms where it draws 60 frames a second (iPad
Safari), so a fixed 25 ms called every ordinary stroke lag there. Lag now
means at least one frame more than that: over 3 frame intervals (measured by
`input.js`; 60 frames a second until known) and over 25 ms. The snapshot was
taken once the pen had lifted, so it said `idle`; a lagging stroke is logged
as `writing`.
- **GIVEN** strokes at 37 ms and 60 ms on a 60 Hz screen, and at 32 ms on a 120 Hz screen
- **WHEN** each stroke ends
- **THEN** only the 60 ms and the 120 Hz strokes are lag (limits 50 ms and 25 ms), and both are logged as `writing`
<!-- test-js: apps/web/tests/perf.test.mjs :: pen lag is judged against the frame rate of the screen, and is logged as writing even though the pen has lifted (regression) -->

#### Scenario: Other people's scripts
- **GIVEN** a long frame with Bedrock's `onFrame` and a script of another Obsidian plugin
- **WHEN** a stutter is logged
- **THEN** Bedrock's script is named with its function and the other is only "another plugin", with no folder, vault or plugin name
<!-- test-js: apps/web/tests/perf.test.mjs :: scripts of Obsidian, other plugins and extensions are labelled, never named -->

#### Scenario: In the app
- **GIVEN** the page is busy on each pen move while a save runs
- **WHEN** the person writes
- **THEN** one stutter entry is logged, with `save` running, the pen and the stroke class
<!-- test-js: apps/web/tests/perf.test.mjs :: a laggy stroke in the app is logged with what was running, and repeats add to one entry -->

### Requirement: The person SHALL see slow moments before they are sent

#### Scenario: Notice and report
- **GIVEN** three slow moments within 5 minutes
- **WHEN** the app is running
- **THEN** a quiet "Bedrock seems slow" notice offers Details, the panel shows a version 2 report with the slow entries and their snapshots, and Send sends it
<!-- test-js: apps/web/tests/perf.test.mjs :: the slow notice shows after 3 moments in 5 minutes -->
<!-- test-js: apps/web/tests/perf.test.mjs :: after 3 slow moments a quiet notice offers Details; the report is version 2 and sends -->

### Requirement: Automatic performance reports SHALL be off until the person agrees, and bounded

#### Scenario: Opt in
- **GIVEN** the menu setting "Send performance reports automatically"
- **WHEN** the person ticks it
- **THEN** a confirmation says what is sent and that it is at most 3 a day; saying no keeps it off; once on, a minute after a slow moment a report with `sent: "auto"`, slow entries since it was switched on and no comment is sent, nothing twice, at most 3 a day, with no slow notice; switching it off stops it
<!-- test-js: apps/web/tests/perf.test.mjs :: automatic performance reports are off until agreed, send slow entries only, at most 3 a day -->

### Requirement: The Obsidian plugin SHALL time its own jobs

#### Scenario: Plugin jobs
- **GIVEN** a write to the vault that takes 2.5 s, twice
- **WHEN** the canvas saves
- **THEN** one slow entry "Plugin: A job took long: write" is logged with a count of 2 and whether Obsidian is on mobile
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: slow reads, writes and index updates are logged with what was running -->

#### Scenario: With the canvas's automatic reports
- **GIVEN** the plugin has a slow moment and the canvas sends an automatic report through `send-report`
- **WHEN** the plugin sends it
- **THEN** the plugin's slow entries since the last one are added (errors are not), with a `mobile` fact; a report the person sent goes exactly as they saw it
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the plugin's slow moments go with the canvas's automatic reports, once, and never into a person's -->
