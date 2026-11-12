# Working on Bedrock

Bedrock uses spec driven development: read
[docs/spec-driven-development.md](docs/spec-driven-development.md) first.

- Every feature and every data format has a living spec in
  `openspec/specs/<capability>/spec.md`. Write or update the spec before or
  alongside the code, and name the test that proves each scenario
  (`<!-- test: name -->` or `<!-- test-js: file :: title -->`).
  `cargo test -p bedrock-core --test specs` fails when a named test is gone.
- **Data formats** (note files, sidecars and index notes, the exported
  library, the on-device library, training samples and prompts, the backend
  API; the full list is in `openspec/specs/data-format-changes/spec.md`):
  never change one without first asking Frederik, giving the reason, and
  waiting for their approval.
- **Old formats keep working.** A format change keeps every earlier version
  readable, and adds a test that reads a fixture written before the change
  (`crates/bedrock-core/tests/fixtures/old-formats/`). Never regenerate a
  fixture to make a test pass.
- Every bug fix starts with a test that reproduces the bug.
