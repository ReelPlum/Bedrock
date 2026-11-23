# Spec driven development

Bedrock changes are planned as specs before code is written, using
[Interlock](https://github.com/renzrollon/interlock), a Claude Code plugin
built on [OpenSpec](https://github.com/Fission-AI/OpenSpec).

## Where things live

| Path | What it is |
|---|---|
| `openspec/specs/<feature>/spec.md` | Living specs: what Bedrock does today, as requirements with GIVEN / WHEN / THEN scenarios. |
| `openspec/changes/<change>/` | A change in progress: `proposal.md`, `design.md`, `tasks.md` and delta specs. |
| `openspec/changes/archive/` | Merged changes, kept as a record. |
| `openspec/config.yaml` | Project context and rules the model follows when writing specs and tasks. |
| `.claude/testing/profile.json` | The test commands `/interlock:ship` runs (taken from CI). |

Each scenario names the test that proves it in a comment:
`<!-- test: name -->` for a Rust test function, or
`<!-- test-js: apps/web/tests/x.test.mjs :: test title -->` for a
JavaScript test (the web app, the Obsidian plugin).
`crates/bedrock-core/tests/specs.rs` fails when a cited test no longer
exists, in the living specs and in the delta specs of open changes, so
specs and tests cannot drift apart silently.

## Data formats

Note files, sidecars and index notes, the exported library, the on-device
library, training samples and prompts, and the backend's API and storage are
data formats: people's notes and data depend on them. The full list is in
`openspec/specs/data-format-changes/spec.md`. For any change to one:

1. **Ask first.** Tell Frederik what would change, why, and how old data
   keeps working, and wait for their approval before writing it. Claude
   sessions do the same: they stop and ask, they do not decide. The
   proposal's "Data format change" section records the reason and the
   approval.
2. **Old formats keep working.** Readers keep reading every earlier version;
   only writers move on. Before the change, add a fixture written by the
   current version to `crates/bedrock-core/tests/fixtures/old-formats/` (or
   the matching place for other formats) and a test that reads it. Fixtures
   are never regenerated. **The one exception:** a format that breaks a rule
   in [security.md](security.md) loses support. Its spec says it no longer
   works, and a test shows it is refused.
3. **Write it down.** Update the format's spec and its document
   (`docs/note-format.md` and `docs/note.schema.json` for notes).

## The loop

1. `/interlock:spec "<idea>"` writes a change and stops. For a bug, give the
   error and the steps to reproduce; the first task is then a failing test.
2. Read the change: is the proposal the right idea, are the scenarios the
   behaviour you want, are the tasks sane? If not, spec it again.
3. `/interlock:ship` implements the tasks, runs `cargo test`, and commits.
4. Open the pull request (`/interlock:settle --create --review`, or by hand).
5. After it merges: `openspec archive <change>` folds the delta specs into
   `openspec/specs/`.

## One-time setup

In Claude Code, once per machine:

```text
/plugin marketplace add renzrollon/interlock
/plugin install interlock@interlock
```

`/interlock:ship` cannot stop to ask for permission, so allow the commands
it runs. Either run `! interlock doctor` and paste the snippet it prints, or
add this to `.claude/settings.json` (the `extraKnownMarketplaces` and
`enabledPlugins` keys also make every session in this repo pick up the
plugin):

```json
{
  "extraKnownMarketplaces": {
    "interlock": { "source": { "source": "github", "repo": "renzrollon/interlock" } }
  },
  "enabledPlugins": { "interlock@interlock": true },
  "permissions": {
    "allow": [
      "Bash(interlock:*)",
      "Bash(interlock-graph:*)",
      "Bash(openspec:*)",
      "Bash(git:*)",
      "Bash(cargo test:*)",
      "Bash(cargo build:*)",
      "Bash(cargo clippy:*)",
      "Bash(cargo fmt:*)",
      "Bash(./scripts/build-web.sh:*)",
      "Bash(npm test:*)",
      "Bash(node --test:*)"
    ]
  }
}
```

Then run `/interlock:bootstrap` once to write living specs for the features
that do not have one yet. It keeps existing specs, such as
`openspec/specs/note-format/spec.md`, and never edits source code.

Interlock's code graph does not index Rust imports. That is expected: the
spec, ship and review loop works without it.
