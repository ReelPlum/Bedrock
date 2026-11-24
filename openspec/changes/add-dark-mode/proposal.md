# Dark mode for the chrome

## Why

Frederik asked for a dark mode that follows the system setting, for the
toolbar and the rest of the chrome, with the canvas staying white. Writing
at night on a dark iPad, a bright toolbar, menu and library glare; the page
itself must stay paper so notes look the same everywhere and ink colours
mean what they meant when written.

## What changes

- `apps/web/style.css`: the chrome's colours become tokens (`--chrome`,
  `--ink`, `--on-ink`, `--muted`, `--accent`, `--accent-fill`, `--hover`,
  `--pressed`, `--field`, `--danger`, `--toast`, `--backdrop`, …) with a dark
  set. The dark set applies when the system is dark
  (`prefers-color-scheme: dark`) unless a host said `data-theme="light"` on
  `<html>`, and whenever a host said `data-theme="dark"`. `color-scheme`
  follows, so selects, sliders and scroll bars go dark too.
- The page never changes: the WebGL paper and ink are drawn from the note,
  `--paper` stays, and marks drawn over the page (the search-hit flash, the
  minimap's view frame, the link picker's words over a page) use
  `--paper-accent`, which stays the same blue. The minimap's picture of the
  page keeps the paper colour inside its dark frame, so black ink stays
  visible. Colour swatches and size dots get a light ring in dark mode so a
  black ink swatch shows on the dark toolbar.
- The loading screen (the pen writing) and the error screen use
  `--backdrop`, dark in dark mode.
- Panels that bring their own styles (the launch gate, the report panel)
  wrap their dark rules with `darkCss` from the new `src/theme.js`, so they
  follow the same rule. The welcome page and `theme-color` follow too.
- Obsidian: the canvas follows Obsidian's theme, not the system's (they can
  differ). The plugin writes `data-theme` into each page before it paints
  (`InlineApp`'s `theme`), and on Obsidian's `css-change` sets it on every
  open canvas and the launch gate (`src/theme.js`).
- Contrast: text tokens are checked against WCAG 2.2 AA (4.5:1) in both
  themes. The light `--accent` moves from `#2f6bff` to `#2a62ee` (and filled
  buttons with it), because `#2f6bff` was 4.47:1 on the toolbar.

## Not changed

No data format. Nothing is stored or sent: the theme is read from the
system or Obsidian each time. The Obsidian host protocol is unchanged (the
attribute is set on the same-origin frame, no new message). The training
pages (`/train`) and the terms page stay light for now.

## Open source used

None. Dark mode is CSS custom properties and the standard
`prefers-color-scheme` media query; nothing to add. Libraries considered:
**theme-change** (MIT) and **next-themes** (MIT, React) only toggle a
`data-theme` attribute and store a choice, which Bedrock does not need (it
follows the system or Obsidian, with no setting to store), and next-themes
needs React. The CSS `light-dark()` function would avoid writing the dark
colours twice, but needs Safari 17.5 or later, and an older iPad would get no
chrome colours at all, so the two dark blocks are written out and a test keeps them equal.
