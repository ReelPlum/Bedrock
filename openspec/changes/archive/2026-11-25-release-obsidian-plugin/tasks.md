# Tasks

## 1. Manifest at the root

- [x] 1.1 Move `apps/obsidian/manifest.json` to `/manifest.json`; `build.mjs` copies it into `dist/` and reads it for `--vault`.
- [x] 1.2 Add `/versions.json` with `"0.1.0": "1.5.0"`.
- [x] 1.3 Test: the root manifest follows Obsidian's rules and is in `versions.json` (`tests/release.test.mjs`).

## 2. Release workflow

- [x] 2.1 `release.mjs check|stamp <tag>`, with tests for release and beta tags and refused manifests.
- [x] 2.2 `.github/workflows/obsidian-release.yml` on bare version tags: check, build, unit tests, stamp, attest, `gh release create` (beta tags as pre-releases).
- [x] 2.3 README: installing with BRAT, releasing, and the rule that only the plugin makes GitHub releases.
