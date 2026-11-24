// Dark mode for the chrome (openspec/specs/dark-mode). The chrome follows
// the system's light or dark setting, unless a host says which theme it is
// in by setting `data-theme="light"` or `"dark"` on <html> (the Obsidian
// plugin follows Obsidian's own theme this way). The page itself, its paper
// and its ink, never changes.
//
// style.css writes its dark colours out by hand. The panels that bring their
// own styles (the launch gate, the report panel) wrap theirs with `darkCss`.

/** The two places dark rules apply: the system is dark and no host said
 *  light, or a host said dark. */
export const DARK_ROOTS = [':root:not([data-theme="light"])', ':root[data-theme="dark"]'];

/** Each selector of each flat rule in `css`, under `root`. */
function underRoot(css, root) {
  return css.replace(/([^{}]+)\{([^{}]*)\}/g, (_, selectors, body) => {
    const scoped = selectors.split(',').map((s) => `${root} ${s.trim()}`).join(', ');
    return `\n${scoped} {${body}}`;
  });
}

/** Rules (flat, no nesting) that apply only in dark mode: under the
 *  system's dark setting unless a host said light, and whenever a host
 *  said dark. */
export function darkCss(css) {
  const [system, host] = DARK_ROOTS;
  return `@media (prefers-color-scheme: dark) {${underRoot(css, system)}\n}${underRoot(css, host)}\n`;
}

/** Whether the chrome in `doc` is dark right now. */
export function isDark(doc = document) {
  const said = doc.documentElement.dataset.theme;
  if (said === 'dark' || said === 'light') return said === 'dark';
  return !!doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches;
}
