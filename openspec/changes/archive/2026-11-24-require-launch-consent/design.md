# Design

## One gate, two hosts

The gate lives in the web app (`apps/web/src/consent.js`) so the code,
consent and "Send every word" setting are stored where the canvas reads
them: the web app's local storage. The Obsidian plugin runs the web app in
iframes on one origin, so a page from the same unpacked app sees the same
storage.

- **Web app.** `main.js` calls `showGate()` first thing, before the
  WebAssembly loads, as a modal `<dialog>`. `cancel` (Escape) is
  prevented. `collect.onStatus` shows it again when the server turns the
  code down (a `401` while sending).
- **Plugin.** At `onLayoutReady`, `askAtLaunch` (apps/obsidian/src/consent.js)
  loads `welcome/index.html?…&probe=1` in a hidden iframe, which answers a
  `consent` request `{ needed }` over the existing host protocol. Only if
  needed does it open an Obsidian `Modal` with the welcome page; when the
  person agrees, the page answers `{ needed: false }` and the window closes.
  A note opened after the window was closed shows the gate itself.
- **Several windows.** A `storage` event for `bedrock.collect.v1` closes
  the gate in every other window once one of them has agreed, and updates
  that window's in-memory settings so its next save keeps "Send every word"
  on.

## Checking the code

`GET /v1/stats` needs a code and changes nothing, so it is used as the
check: `401`/`403` is a wrong code (nothing is stored), `2xx` is accepted,
another status asks to try again, and no answer at all (offline, or CORS)
keeps the code to be checked by the next send.

## Turning it off

`LAUNCH_GATE = false` gives back the optional flow (the setting is off
until turned on, and needs consent from `/train`). The browser tests of that
flow set `window.bedrockNoLaunchGate`, which a page only honours when served
from this computer, as with the stored server address.
