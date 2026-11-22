// Where the app finds its own files (WebAssembly, workers, word list).
// Normally next to the code. A host that cannot serve files hands them over
// instead: the Obsidian plugin runs the app in a page it writes itself,
// because Obsidian refuses every file request from a page inside a view,
// and passes each file as a blob: URL in `globalThis.BEDROCK_ASSETS`, keyed
// by its path in apps/web (see apps/obsidian/src/inline-app.js).

/** The address of the app's file `path` (e.g. 'pkg/bedrock_web_bg.wasm').
 *  `near` gives the usual address next to the code; it is only called when
 *  no host handed the file over (in a page the host wrote, the code's own
 *  address is a blob: URL that nothing can be resolved against). */
export function asset(path, near = () => path) {
  const handed = globalThis.BEDROCK_ASSETS;
  return (handed && handed[path]) || near();
}

/** True when the host handed the app its files. */
export const handedOver = () => !!globalThis.BEDROCK_ASSETS;
