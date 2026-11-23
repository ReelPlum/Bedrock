# Security rules

Every change to Bedrock's apps, website and formats follows these rules, for
people and Claude sessions alike. They win over every other rule in this
repository. A rule is changed only with Frederik's approval. The backend has
the same rules for its side in Bedrock-Backend's `docs/security.md`.

## The rules

1. **Hashing: BLAKE3, never SHA-256.** Anything that keeps a secret uses
   keyed BLAKE3 with a separate key. Hashes that need no secret (names,
   checksums, fingerprints) use plain BLAKE3. SHA-256 is not used for
   anything new. Use the `blake3` crate, never a hand-written hash.
2. **No secret ships in an app.** The web app, the Obsidian plugin and the
   website hold no key, token or admin code. A person's invite code is kept
   only on their own device. The backend's address is built into the app and
   must be `https://`. Only a page served from this computer may use another
   address, for tests.
3. **Text from outside is never HTML.** Note text, prompts, labels and
   anything from the backend or a file go in through `textContent`, or
   through `esc()` when HTML has to be built. `innerHTML` only takes markup
   written in the code.
4. **The note format stays open and safe to open.** A note never runs code
   when it is opened. Every reader caps sizes and counts, so a crafted file
   cannot exhaust memory.
5. **Send as little as possible.** Handwriting leaves the device only with
   consent and an invite code. Error reports are shown in full before they
   are sent. No name, email or address goes to the backend.
6. **Dependencies are checked.** `cargo audit` and `npm audit` find no
   advisories before a release. Each library is recorded in its spec under
   "Open source used" (see `open-source-first.md`).
7. **A format that breaks a rule here loses support.** It is not kept
   readable, unlike other old formats. Its spec says plainly that it no
   longer works, and a test shows it is refused with a clear error.

## Formats that no longer work

None in the apps yet. The backend no longer accepts plain SHA-256 hashes of
invite codes and admin keys. It now uses keyed BLAKE3.

## Open items from the November 2026 review

Each of these needs Frederik's decision before it changes:

- **Picture names in notes use SHA-256** (`images/<hash>.<ext>`,
  `apps/web/src/images.js`). They only name a picture by its content, so
  one picture used twice is stored once. They protect no secret. Moving new
  pictures to BLAKE3 names is a note format change. Existing notes would
  keep opening, because a name is only looked up.
- **The Obsidian build** hashes the packed web app with SHA-256
  (`apps/obsidian/build.mjs`). This can move to BLAKE3 with no format
  change.
- **The web app shares the `reelplum.github.io` origin** with every other
  GitHub Pages site on the account, and has no Content-Security-Policy yet.
  Planned fix: its own domain, plus a CSP.
