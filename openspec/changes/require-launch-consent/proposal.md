# Ask for the invite code and consent when Bedrock starts

## Why

Frederik, 2026-11-12: "when launching the app / plugin ask for the code
immediately and require that you accept that your handwriting will be
shared with the server." While Bedrock is a small invite-only test, every
user is meant to contribute handwriting; today sharing is set up on a page
people may never open (`/train`), and "Send every word" is off by default.

## What changes

- **Launch gate.** When the web app starts, and when Obsidian starts with
  the plugin, a window asks for the invite code and consent before anything
  else. It cannot be closed without agreeing, and the app behind it cannot
  be used. The code is checked with the server (`GET /v1/stats`, which
  needs a code and changes nothing) before it is accepted.
- **Consent version 3.** The consent text now says every handwritten word
  written in notes is sent, and that sharing is part of using Bedrock for
  now. Agreeing turns on "Send every word I write in notes", and that
  setting cannot be turned off while the gate is on. "Stop saving" on
  `/train` still withdraws consent at once (the gate then comes back), and
  "Delete my contributions" still works without consent.
- The gate is one constant, `LAUNCH_GATE` in `apps/web/src/collect.js`, so
  sharing can be made optional again for a public release. It only takes
  effect once a server address is built in (`DEFAULT_API`): until the
  backend is deployed there is nothing to check a code against, so the app
  opens as today.
- The plugin had no consent flow. It now loads the same gate from the web
  app (`apps/web/welcome/`) in an Obsidian window at start-up; each note
  also shows the gate over its canvas if the window was closed.

## Consent, GDPR

Making the app unusable without agreeing means the consent is not "freely
given" under GDPR article 7(4) for a general audience. Frederik was told
this and agreed to build it as a switchable gate for the invite-only group
(2026-11-13, "1. Yes"). Before a public release, `LAUNCH_GATE` should be
turned off, or the legal basis reviewed.

## Data format change

What changes:

- `CONSENT_VERSION` goes from 2 to 3 (the `consent` field of local storage
  `bedrock.collect.v1`, and `contributor.consent_version` in requests).
  The shape of the stored state and of requests does not change.
- Agreeing writes `shareWords: true` and `shareWordsSince` to the existing
  settings (`bedrock.settings.v1`); both fields already exist.

Why: the consent text changes what is sent (every word in notes, not only
when the person turns it on), so consent given to the older text must not
count for it.

How old data keeps working:

- State written by the current version (consent 2) still loads: its code,
  contributor id, writing hand and count are kept; the gate asks again with
  the code filled in, and agreeing keeps the same contributor id. Frozen
  fixture `crates/bedrock-core/tests/fixtures/old-formats/collect-state-consent-v2.json`,
  test "consent given to the version 2 text is asked for again, keeping the
  code and the contributor id".
- Samples already queued under version 1 or 2 are sent as they are; the
  backend accepts any consent version above 0 and keeps the highest
  (Bedrock-Backend `collect-core/src/store.rs`), so no backend change is
  needed.

Approval: Frederik, 2026-11-13, in the project thread, after the reason
was given: "2. Yes".

## Open source used

None added. The gate is the browser's own `<dialog>` element
(`showModal()`), which already makes the page behind it inert and keeps
focus inside; the plugin uses Obsidian's `Modal`. A dialog library would
add nothing these do not.

## Impact

- `apps/web/src/collect.js` (`LAUNCH_GATE`, `gateRequired`, `gateNeeded`,
  `checkCode`, `CONSENT_VERSION = 3`), new `apps/web/src/consent.js`,
  `apps/web/src/main.js`, `apps/web/train/` (the text now comes from
  `consent.js`), new `apps/web/welcome/`, `apps/web/sw.js` (cache v27).
- `apps/obsidian/src/consent.js` (new), `apps/obsidian/src/main.js`,
  `apps/obsidian/build.mjs`, `apps/obsidian/styles.css`.
- Docs: `docs/training-data.md`.
- Backend: none. Deployment note: browsers only read the code check's
  answer from origins in the Worker's allowed list. Without that (for
  example the plugin's `app://` origin), the check looks like no
  connection: the code is kept and checked when samples are sent, and a
  code the server turns down brings the gate back.
