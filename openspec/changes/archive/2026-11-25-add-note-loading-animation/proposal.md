# A pen that writes while a note opens

## Why

Frederik wants something to look at while a note opens: a pen drawing a
line, with bounce, expressive, single-colour vector art in Bedrock's
current style. Until now the canvas sat blank (or showed the last note)
while the WebAssembly loaded or a big note was read.

## What changes

- `#note-loading` in `apps/web/index.html`: an inline SVG pen in the
  toolbar's line style (round caps, one colour: the ink `--ink` on the paper
  `--paper`) writes a loopy line, hops at the end with a squash and a
  stretch and three little sparks, the line lifts off, and the pen pops away
  and back in to start again. A 2.6 s loop, with "Opening note…" under it as
  a `role="status"` for screen readers.
- It is plain SVG and CSS keyframes. The ink is drawn with
  `stroke-dashoffset` and the pen follows the same path with CSS motion
  path (`offset-path`), on the same timeline and easing, so the nib stays on
  the end of the line. Inside the pen, separate layers rock it while it
  writes and make it hop.
- It shows from the first paint (before the scripts and WebAssembly have
  loaded), and goes when the first note is open. After that,
  `src/note-loading.js` shows it while any note opens (the notes list,
  Obsidian reloading a file changed elsewhere). It fades in only after
  150 ms, so a note that opens at once shows nothing, and goes at once
  (no fade out), so the opened note's ink shows straight away.
- Reduced motion: nothing moves; the finished line with the pen resting at
  its end is shown instead.
- The Obsidian plugin gets it for free: it inlines `index.html` and
  `style.css` into the view's page.

## Not changed

No data format. Nothing is saved or sent.

## Open source used

None. Researched first, per docs/open-source-first.md:

- **lottie-web** (MIT, Airbnb) plays After Effects animations: about 250 KB
  of JavaScript plus a JSON file, and it can only start once the scripts
  have loaded.
- **Rive** (MIT runtime) needs its WebAssembly runtime and its own editor
  for the art.
- **GSAP** is free to use but under its own licence (not open source), and
  is also JavaScript.

The written reason to build our own: the animation must show from the
first paint, while the app's own scripts and WebAssembly are still
loading, so it cannot depend on a script. SVG and CSS animations
(`stroke-dashoffset`, `offset-path`, `@keyframes`) are web standards
supported in every browser Bedrock runs in (Safari 16+ on the iPad), and
the whole animation is about 3 KB of markup and CSS with no dependency.
