# Fix: Bedrock failed to start after the Duplicate update

## Why

Frederik opened the app after PR #14 merged and got "Bedrock failed to
start: null is not an object (evaluating '$('wm-duplicate').addEventListener')".
The service worker checked scripts with the server but fetched the page
itself (index.html) with the browser's normal caching, and GitHub Pages lets
browsers keep files for 10 minutes. So the new `main.js` ran against the old
page, which had no Duplicate button. Any update that adds an element to the
page could do the same.

## What changes

- The service worker checks the page with the server too (`no-cache`), like
  every other file. Its cache name moves to `bedrock-v25` so the fixed worker
  installs.
- If the app still fails to start, it reloads once by itself (once per tab
  session, never inside the Obsidian plugin). If that does not help, the
  message gets a Reload button.

## Not changed

No data format changes.
