// Bedrock's chrome follows Obsidian's theme, not the system's
// (openspec/specs/dark-mode): Obsidian can be dark on a light system and
// the other way round. Obsidian marks its theme on <body> (`theme-dark` or
// `theme-light`); the canvas's page is told with `data-theme` on its <html>,
// which apps/web/style.css reads. Its pages are srcdoc frames of Obsidian's
// own origin, so the attribute is set on them directly. Free of Obsidian
// imports so it can be tested on its own.

/** 'dark' or 'light': the theme Obsidian shows now. */
export function obsidianTheme(body) {
  return body?.classList?.contains('theme-dark') ? 'dark' : 'light';
}

/** Tells each frame's page the theme (frames not loaded yet are skipped:
 *  their page is written with the theme already, see inline-app.js). */
export function tellTheme(frames, theme) {
  for (const f of frames) {
    try {
      const root = f?.contentDocument?.documentElement;
      if (root) root.dataset.theme = theme;
    } catch (_) { /* not ours to reach */ }
  }
}
