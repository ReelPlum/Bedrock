# saving-and-opening Specification

## ADDED Requirements

### Requirement: The save worker SHALL reuse the page's compiled WebAssembly

#### Scenario: One compile for the page and its save worker
- **GIVEN** the app starting
- **WHEN** it compiles its WebAssembly and starts the save worker
- **THEN** the WebAssembly is fetched and compiled once, the worker is sent the compiled module first and saves with it, and a worker sent no module compiles its own
<!-- test-js: apps/web/tests/app.test.mjs :: the WebAssembly is fetched and compiled once; the save worker gets the module the page compiled -->
