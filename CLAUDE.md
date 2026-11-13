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
- **Security rules:** follow [docs/security.md](docs/security.md) in
  every change. It wins over every other rule here.
- **Old formats keep working**, unless they break a rule in
  `docs/security.md`: those lose support, and their spec says they no
  longer work. A format change keeps every earlier version
  readable, and adds a test that reads a fixture written before the change
  (`crates/bedrock-core/tests/fixtures/old-formats/`). Never regenerate a
  fixture to make a test pass.
- Every bug fix starts with a test that reproduces the bug.
- **Open source first.** Before building a feature or module, research
  whether a tried, tested and well maintained open source library already
  does exactly what is needed and allows commercial use, and prefer it.
  Prefer Rust; if an option that is not Rust is clearly better, ask Frederik
  first and explain why. Building our own needs a written reason. Every
  library, model or data set used is recorded in the feature's spec under
  "Open source used": why it was chosen, why it is mature, and its licence.
  The full rule is in [docs/open-source-first.md](docs/open-source-first.md).
