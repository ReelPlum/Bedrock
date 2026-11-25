# Fix: the plugin showed an empty view in Obsidian (Mac and iPad)

## Why

Frederik installed 0.1.0-beta.1 with BRAT. "New handwritten note" made a
note, but the view stayed empty: black on the iPad, and on a Mac only bare,
unstyled buttons. Obsidian's console on the Mac showed `style.css`,
`errors.js` and `main.js` failing with `net::ERR_BLOCKED_BY_CLIENT`.

Obsidian's desktop app (main.js of 1.15.1) cancels every `app://` request
whose frame is not Obsidian's own window (`webRequest.onBeforeRequest`). The
plugin unpacked the web app into its folder and pointed the view's iframe at
it, so the page itself opened but everything it loaded was refused. The
tests served the files over HTTP, where nothing is refused.

## What changes

- Nothing is unpacked. `build.mjs` packs each page (`index.html`,
  `welcome/index.html`) with its stylesheet and classic script inline, and
  bundles each module graph (app, welcome page, save and recogniser
  workers) into one file with esbuild.
- `src/inline-app.js` writes a page into the iframe as `srcdoc` (a page of
  Obsidian's own origin) and hands over the modules, workers, WebAssembly and
  word list as `blob:` URLs.
- The web app finds its files through `globalThis.BEDROCK_ASSETS`
  (`apps/web/src/assets.js`) when a host hands them over, and learns it is in
  a host from `globalThis.BEDROCK_HOST` (a srcdoc page has no `?host=`). A
  page's host name falls back to its origin (`collect.pageHost`).
- The browser tests refuse every request from the iframe, as Obsidian does.
- The plugin's `unpack` job and its limit are gone.

## Not changed

No data format changes. The web app in a browser loads its files as before.

## Open source used

- **esbuild** (MIT), already the plugin's bundler, now also bundles the web
  app's module graphs for the plugin.
