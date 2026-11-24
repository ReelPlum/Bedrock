# error-reporting

## ADDED Requirements

### Requirement: A half-started app SHALL NOT save

When start-up fails, the app SHALL NOT save the open note afterwards: its
note may be incomplete, and the parts saving needs may not exist yet.

#### Scenario: A save scheduled before the failure
- **GIVEN** start-up fails after a save was scheduled
- **WHEN** the save would run
- **THEN** nothing is saved and no second error ("Could not save this note") joins the log (a bug found when CI failed on this pull request: the save ran and failed, sometimes after the report about the first error had been sent)
<!-- test-js: apps/web/tests/errors.test.mjs :: after a startup failure the half-started app does not try to save -->
