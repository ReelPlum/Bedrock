# training-data-sharing

## ADDED Requirements

### Requirement: While Bedrock is invite-only, the app SHALL ask for the invite code and consent at launch, and SHALL NOT be usable without them

With `LAUNCH_GATE` on and a safe server address built in, the web app
SHALL show the gate (a modal dialog with the consent text, the invite code
and an optional writing hand) as soon as it starts, whenever there is no
consent to the current version (3) with a code, or the server has turned
the code down. It SHALL NOT close without agreeing. The code SHALL be
checked with `GET /v1/stats` first: a code the server turns down is not
stored; with no answer it is kept and checked by the next send. Agreeing
SHALL store the consent and code and turn on "Send every word I write in
notes", which then cannot be turned off in the settings; "Stop saving" on
`/train` withdraws consent and brings the gate back. With no server
address built in, the app opens without the gate.

#### Scenario: First launch
- **GIVEN** a server address built in and no consent
- **WHEN** the app starts
- **THEN** the gate is shown over the app, Escape does not close it, no tick or no code is refused without asking the server, a wrong code is refused by the server and nothing is stored, and the right code stores consent 3, the code and the writing hand, and turns "Send every word" on and locks it
<!-- test-js: apps/web/tests/launch-gate.test.mjs :: the app asks for the invite code and consent at once, and cannot be used until both are given -->

#### Scenario: No server yet
- **GIVEN** no server address built in
- **WHEN** the app starts
- **THEN** there is no gate and the setting can be changed as before
<!-- test-js: apps/web/tests/launch-gate.test.mjs :: with no server address built in, the app opens without the gate -->

#### Scenario: Offline, and a code turned down later
- **GIVEN** the server cannot be reached when agreeing
- **WHEN** the code is later turned down while sending
- **THEN** the gate was let through with the code kept, and comes back saying the code was not accepted, with the code filled in
<!-- test-js: apps/web/tests/launch-gate.test.mjs :: offline, the code is kept and checked later; a code the server turns down brings the gate back -->

#### Scenario: Consent to an older text
- **GIVEN** local storage written by the previous version, with consent 2 (frozen fixture `crates/bedrock-core/tests/fixtures/old-formats/collect-state-consent-v2.json`)
- **WHEN** the app starts
- **THEN** the gate asks again with the code and hand filled in, and agreeing keeps the contributor id and the count of sent samples
<!-- test-js: apps/web/tests/launch-gate.test.mjs :: consent given to the version 2 text is asked for again, keeping the code and the contributor id -->
<!-- test-js: apps/web/tests/collect.test.mjs :: consent given to an older consent text is asked for again -->

#### Scenario: One consent text
- **GIVEN** the gate and `/train`
- **WHEN** either is shown
- **THEN** both show the same text, agreeing on `/train` also turns "Send every word" on, and "Stop saving" there brings the gate back
<!-- test-js: apps/web/tests/launch-gate.test.mjs :: /train shows the same consent text, and agreeing there turns on "Send every word" -->

#### Scenario: Several windows
- **GIVEN** the app open in two windows
- **WHEN** the person agrees in one
- **THEN** the gate closes in the other, which keeps "Send every word" on
<!-- test-js: apps/web/tests/launch-gate.test.mjs :: agreeing in another window of the app closes the gate in this one -->

#### Scenario: Sending starts at once after agreeing
- **GIVEN** a page that tried to send before there was consent
- **WHEN** consent is given on that page
- **THEN** samples are sent without a reload (a bug found while building the gate: the empty first send was kept as the send in progress for good)
<!-- test-js: apps/web/tests/collect.test.mjs :: a page that tried to send before consent sends once consent is given, without a reload -->
