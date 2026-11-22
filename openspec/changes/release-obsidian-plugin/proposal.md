# Release the Obsidian plugin from this repository, installable with BRAT

## Why

Frederik wants to install the Bedrock plugin on desktop and iPad before it
is in Obsidian's community directory, using BRAT, and from this repository
rather than a separate release repository. Obsidian and BRAT install a
plugin from the GitHub release whose tag is its version, with `main.js`,
`manifest.json` and `styles.css` attached, and Obsidian reads
`manifest.json` from the repository root. The repository had neither a
root manifest nor releases.

## What changes

- `manifest.json` moves from `apps/obsidian/` to the repository root, the
  one copy; `build.mjs` copies it into `dist/`. `versions.json` (plugin
  version to `minAppVersion`) is added beside it.
- `.github/workflows/obsidian-release.yml` publishes a GitHub release when a
  plugin version is tagged: `0.2.0` for a release, `0.2.0-beta.1` for a
  pre-release. It checks the tag first, builds the WebAssembly and the
  plugin, runs the unit tests, writes the tag into the released
  `manifest.json`, attests the files and publishes them.
- `apps/obsidian/release.mjs` holds the check: Obsidian's manifest rules,
  `versions.json` lists the version, and a release tag equals the manifest
  version (a beta tag may run ahead; it is not committed).
- Tags: only the plugin makes GitHub releases here. BRAT sorts every
  release by any digits in its tag, so a release such as `web-2.0.0` would
  become the plugin's "latest". Other apps use plain git tags with a prefix
  (`web-`, `ipad-`) and ship elsewhere, or get their own release repository.

## Not changed

No data format changes. The plugin's code and the plugin id
(`bedrock-notes`) are unchanged.

## Open source used

- **BRAT** (TfTHacker/obsidian42-brat, MIT): the tool Obsidian's own docs
  recommend for beta testing plugins; maintained since 2021, about a million
  downloads. Used by people installing, not bundled.
- **actions/attest-build-provenance** (GitHub, MIT): signed build provenance
  for the release files, which Obsidian's release guide recommends.
- **GitHub CLI** `gh release create` (MIT), preinstalled on GitHub runners.
- The tag and manifest check is our own (about 60 lines): no maintained
  library checks Obsidian's manifest rules together with a release tag, and
  Obsidian's sample plugin does the same with a small script
  (`version-bump.mjs`).
