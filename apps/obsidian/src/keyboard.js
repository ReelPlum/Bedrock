// On the iPad the on-screen keyboard covers the bottom of Obsidian without
// resizing anything: Obsidian only sets --keyboard-height on its root element
// and fires keyboardWillShow / keyboardWillHide on the window. The canvas in
// the view's iframe sees none of that, so a text box low in the canvas (the
// word menu's link box) ended up under the keyboard. The view works out how
// much of its frame is hidden, by the keyboard or by anything else that
// shrinks the visible part of the window (the visual viewport), and tells
// the app (`inset { bottom }`), which keeps its menus above it. Free of
// Obsidian imports so it can be tested on its own and in the browser harness.

/** How many CSS px at the bottom of `frame` (an element in `win`) are
 *  hidden from view. */
export function coveredBottom(win, frame) {
  const rect = frame.getBoundingClientRect();
  if (!rect.height) return 0;
  let visible = win.innerHeight;
  const keyboard = parseFloat(win.getComputedStyle(win.document.documentElement).getPropertyValue('--keyboard-height')) || 0;
  if (keyboard > 0) visible = Math.min(visible, win.innerHeight - keyboard);
  const vv = win.visualViewport;
  if (vv && vv.height > 0) visible = Math.min(visible, vv.offsetTop + vv.height);
  return Math.max(0, Math.min(Math.round(rect.height), Math.round(rect.bottom - visible)));
}

/** Calls `tell(px)` whenever the hidden part of `frame` changes. Returns
 *  `{ covered(), stop() }`. */
export function watchKeyboard(win, frame, tell) {
  let last = 0;
  const timers = new Set();
  const check = () => {
    const now = coveredBottom(win, frame);
    if (now !== last) {
      last = now;
      tell(now);
    }
  };
  // The keyboard slides in and out, and --keyboard-height may be set just
  // after the event: look again once it has settled.
  const soon = () => {
    check();
    for (const ms of [100, 400]) {
      const t = win.setTimeout(() => { timers.delete(t); check(); }, ms);
      timers.add(t);
    }
  };
  const targets = [
    [win, ['keyboardWillShow', 'keyboardDidShow', 'keyboardWillHide', 'keyboardDidHide', 'resize']],
    [win.visualViewport, ['resize', 'scroll']],
  ].filter(([t]) => t);
  for (const [t, names] of targets) for (const n of names) t.addEventListener(n, soon);
  return {
    covered: () => (last = coveredBottom(win, frame)),
    stop() {
      for (const [t, names] of targets) for (const n of names) t.removeEventListener(n, soon);
      for (const t of timers) win.clearTimeout(t);
      timers.clear();
    },
  };
}
