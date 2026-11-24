# Tasks

## 1. Old formats first
- [x] 1.1 Frozen `collect-state-consent-v2.json` and a test that it loads, is asked again, and keeps the code and contributor id

## 2. Web app
- [x] 2.1 `LAUNCH_GATE`, `gateRequired`, `gateNeeded`, `checkCode`; `CONSENT_VERSION = 3`
- [x] 2.2 `consent.js`: the consent text, `accept` (turns on "Send every word"), the gate dialog
- [x] 2.3 `main.js` shows it at launch and when a code is turned down; the setting is locked while the gate is on
- [x] 2.4 `/train` uses the same text and `accept`
- [x] 2.5 `welcome/` page for hosts; service worker cache

## 3. Obsidian plugin
- [x] 3.1 `askAtLaunch` with a hidden probe and a window; `ConsentModal`; the welcome page is packed

## 4. Tests and docs
- [x] 4.1 Browser tests (web app and plugin harness), unit tests
- [x] 4.2 `docs/training-data.md`
