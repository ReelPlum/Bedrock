# Tasks

## 1. Web

- [x] 1.1 Colour tokens and their dark set in `style.css`; every chrome colour uses a token; the page's colours (`--paper`, `--paper-accent`, the minimap's paper) stay.
- [x] 1.2 `src/theme.js` (`darkCss`, `isDark`); the launch gate and the report panel use it. Added to the service worker's files.
- [x] 1.3 Welcome page background and `theme-color` follow the theme.
- [x] 1.4 Browser tests in `apps/web/tests/dark-mode.test.mjs`, contrast included.

## 2. Obsidian

- [x] 2.1 `src/theme.js`: `obsidianTheme`, `tellTheme`; `InlineApp` writes the theme into each page; the plugin follows `css-change`.
- [x] 2.2 Unit test in `apps/obsidian/tests/unit.test.mjs`.
