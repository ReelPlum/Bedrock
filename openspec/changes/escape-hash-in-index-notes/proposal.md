# A handwritten # makes no tag in the index note

## Why

Frederik (2026-11-24): "For the index files could it then in the indexes use
a special letter for # so it doesnt mistake it for a tag? When it is
handwritten recognised text..." and "And make it so it updates for already
indexed files also".

The text section of an index note (and of an exported sidecar) is the
recognised handwriting as written. A handwritten `#physics` became an
Obsidian tag of the index note, and a `#` at the very start of the text
turned the whole text line into a heading.

## What changes

- Every `#` in the recognised text is written `\#`, Markdown's escape for a
  plain `#`, the same way `[` and `]` already are. Obsidian makes no tag
  and no heading of it, and shows a plain `#`.
- The front matter, `## Links` and `## Linked handwritten notes` are
  unchanged.
- The Obsidian plugin rewrites an index note whose text section still has a
  bare `#` the next time it indexes the vault (at start and on sync), so
  notes indexed before this change lose their stray tags by themselves.

## Options considered

- **`\#` (chosen).** CommonMark's own escape; Obsidian honours it, and its
  Web Clipper escapes tags the same way. The text looks the same, and a
  search for `word` or `#word` still finds it (`\#word` contains `#word`).
- **A look-alike, fullwidth `＃` (U+FF03).** Also no tag, but a search for
  a typed `#word` misses it, copied text carries a different character,
  and screen readers say "fullwidth number sign".
- **A code span, or an invisible character after `#`.** A code span changes
  how the text looks; an invisible character breaks search for `#word`.

## Data format change

**What changes.** The text section of the Markdown sidecar / index note
writes `#` as `\#`.

**Why.** A handwritten `#` made tags and headings in Obsidian.

**How old data keeps working.** An index note written before the change
still names and opens its note, and a search hit in it still finds the
ink (`index-before-escaped-hashes.md` fixture). The plugin writes it again
with the escape on its next sync. Sidecars in an older exported library
keep working the same way and are rewritten when the plugin finds them.
Nothing in `.bedrock` files changes.

**Approval.** Asked 2026-11-24 in the project thread with the options
above; Frederik chose "Backslash \# (recommended)" the same day.

## Open source

Nothing new is needed: it is Markdown's own escape.
