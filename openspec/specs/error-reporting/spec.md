# error-reporting Specification

## Purpose
Catching errors in the web app (and the training pages) and in the
Obsidian plugin, and letting the person send them to the Bedrock team with
"Share with the Bedrock team", so a problem seen on someone's iPad reaches
us. Nothing is ever sent without the person pressing Send after seeing the
whole report. The backend side (checks, storage, `bedrock-data reports`) is
the `error-reports` spec in Bedrock-Backend.

Approved by Frederik on 2026-11-13 as new data formats (the report, the
`POST /v1/reports` route, the on-device log), with 90 days' retention on the
backend and the quiet notice for errors while writing.

| File | What it does |
|---|---|
| `apps/web/src/errors.js` | Plain script loaded first on every page (replaces `boot-check.js`): catches errors, keeps the log, shows the startup failure box and the quiet notice. |
| `apps/web/src/error-report.js` | Builds the report; also used by the plugin. |
| `apps/web/src/report-panel.js` | The panel: the exact report, a comment, Copy and Send. |
| `crates/bedrock-web/src/lib.rs` | Panic hook: a Rust panic goes to the console and to the log. |
| `apps/obsidian/src/report.js` | The plugin's own log, and sending with Obsidian's `requestUrl`. |

## Open source used

No new library. Sentry (SDK MIT, server FSL), GlitchTip (MIT) and Bugsink
(Polyform Shield) were weighed first. Their strength is automatic capture,
grouping and dashboards, which goes against showing the person the report
before anything is sent; the Sentry SDK would add about 25 KB to an app
without a bundler; and GlitchTip or Bugsink would mean running a separate
Python server outside Cloudflare. Catching is a small, standard job
(`error` and `unhandledrejection` events, a panic hook, worker `onerror`).
The report format leaves room to forward reports to GlitchTip later with
the `sentry-types` crate (MIT, Rust) on the backend, without changing the
apps. The full comparison is in the backend's `error-reports` spec.
`console_error_panic_hook` (MIT/Apache-2.0, already used) still writes
panics to the console.

## Data formats

**Report** (`bedrock-error-report`, version 1), JSON, at most 64 KB. The
fields and limits are the backend's `error-reports` spec: `format`,
`version`, `id` (UUID v7 made on the device), `app` (`web` or `obsidian`),
`app_version`, `device` (coarse class), `browser` (engine and major version
only, e.g. `safari 18`), `stage` (`startup` or `running`), `created`,
`errors` (up to 50 `{ kind, message, stack?, at, count? }`, kind `error`,
`rejection`, `panic`, `worker` or `shown`), `context` (yes/no facts:
`webgl2`, `webassembly`, `indexeddb`, `service_worker`, `offline`,
`background_saving`) and an optional `comment`.

**Route**: `POST <backend>/v1/reports`, no code, answer `{ "id" }`. The
address is the training backend's (`DEFAULT_API` in `collect.js`); while it
is empty, Send is off and the report can be copied. Inside Obsidian the
canvas asks the plugin with the host request `send-report` `{ report }` →
`{ id }`, and the plugin posts it with `requestUrl`.

**On the device**: the log is local storage `bedrock.errors.v1`,
`{ "entries": [{ kind, message, stack?, at, count }] }`, the newest 50,
entries older than 7 days dropped. It is cleared after a report is sent.

**What is collected**: error messages (at most 500 characters) and stacks
(at most 4000), with every address and folder cut down to the file name
(and a stack's line and column), so no vault, user or folder name leaves.
No strokes, text, note names or file names: errors that name a file the
person chose are shown but not logged.

## Requirements

### Requirement: Errors SHALL be caught from the first moment, without note content

#### Scenario: File names only
- **GIVEN** messages and stacks holding addresses, Obsidian vault paths, macOS and Windows folders, query strings and blob addresses
- **WHEN** they are logged, by the web app or by the plugin
- **THEN** only file names stay (with line and column), the same in both
<!-- test-js: apps/web/tests/errors.test.mjs :: folders and addresses are cut down to file names before anything is logged -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the plugin error log keeps file names only, counts repeats and builds a report the backend takes -->

#### Scenario: A Rust panic
- **GIVEN** the canvas panics
- **WHEN** the panic hook runs
- **THEN** its message and place are in the log as kind `panic`
<!-- test-js: apps/web/tests/errors.test.mjs :: a Rust panic reaches the log with its message -->

#### Scenario: Kept across a reload
- **GIVEN** the same error three times, then a reload
- **WHEN** the log is read
- **THEN** it holds one entry counted 3, and a report built from it has no strokes, points or titles
<!-- test-js: apps/web/tests/errors.test.mjs :: the log survives a reload, repeats are counted, and it holds no note content -->

### Requirement: A failure SHALL offer Reload and Share, and an error while writing SHALL stay out of the way

#### Scenario: Startup failure (the "wm-duplicate is null" screenshot)
- **GIVEN** a page that fails to start
- **WHEN** the failure is shown
- **THEN** it says what went wrong with Reload first and "Share with the Bedrock team", and the report holds the error with its stack (file names only) and stage `startup`
<!-- test-js: apps/web/tests/errors.test.mjs :: a startup failure offers Reload and Share, and the report holds the error with its stack -->
<!-- test-js: apps/web/tests/app.test.mjs :: a page from an older version than its scripts reloads once by itself and starts; if that does not help it says so with a Reload button -->
<!-- test-js: apps/web/tests/train.test.mjs :: a page put together from two versions (just after an update) says to reload instead of staying empty -->

#### Scenario: Error while writing
- **GIVEN** a ready app
- **WHEN** an error and then a rejected promise happen
- **THEN** a quiet "Something went wrong" notice with Details appears once (not again within a minute), the canvas stays usable, and Details opens the report with both
<!-- test-js: apps/web/tests/errors.test.mjs :: an error while writing shows a quiet notice; Details shows the report and Send sends it -->

#### Scenario: Plugin problems
- **GIVEN** the plugin fails to unpack the canvas
- **WHEN** it tells the person
- **THEN** the Notice has a Report button, the problem is logged, and "Report a problem with Bedrock" is a command
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: a plugin problem is shown with Report and logged; reports go out through requestUrl, from the plugin and from the canvas -->

### Requirement: Nothing SHALL be sent before the person sees it and presses Send

#### Scenario: What is shown is sent
- **GIVEN** the panel with a report and a comment typed
- **WHEN** Send is pressed
- **THEN** exactly the report shown (with the comment) is posted, the backend's checks would accept it, and the log starts afresh
<!-- test-js: apps/web/tests/errors.test.mjs :: a startup failure offers Reload and Share, and the report holds the error with its stack -->

#### Scenario: Report a problem
- **GIVEN** Menu → Report a problem… with no errors logged
- **WHEN** the panel opens
- **THEN** Send stays off until a comment is typed, then the comment is sent
<!-- test-js: apps/web/tests/errors.test.mjs :: Report a problem works without an error, and needs a comment then -->

#### Scenario: No backend address yet
- **GIVEN** a version without the backend's address
- **WHEN** the panel opens
- **THEN** Send is off, it says so, and the report can be copied
<!-- test-js: apps/web/tests/errors.test.mjs :: without a backend address the report can be copied but not sent -->

#### Scenario: Sending from Obsidian
- **GIVEN** a report from the canvas or the plugin
- **WHEN** it is sent
- **THEN** the canvas asks the plugin (`send-report`), the plugin posts it with `requestUrl` over https only, and a refused, limited or unreachable send says what to do
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: reports are sent with requestUrl, and failures say what to do -->
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the canvas sends its error reports through the plugin -->

### Requirement: The browser SHALL be named coarsely

#### Scenario: Browser tag
- **GIVEN** user agents of Safari on iPad, Chrome, Obsidian and Firefox
- **WHEN** the report names the browser
- **THEN** it is only the engine and major version
<!-- test-js: apps/web/tests/errors.test.mjs :: the browser is named by engine and major version only -->
