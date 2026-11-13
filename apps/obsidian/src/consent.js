// Asking for the invite code and consent when Obsidian starts, before any
// note is open. The question itself is the web app's launch gate
// (apps/web/src/consent.js), on its own page (apps/web/welcome/), so the
// consent, the code and the "Send every word" setting are stored where the
// canvas reads them: the web app's local storage. Free of Obsidian imports
// so it can be tested on its own.
//
// 1. A hidden iframe loads the page with `probe`, which answers `consent`
//    with `{ needed }` and shows nothing.
// 2. If needed, `open({ mount, onClose })` shows a window (an Obsidian Modal), and
//    `mount(el)` puts the page in it. When the person agrees, the page
//    answers `{ needed: false }` and the window closes.
//
// If the window is closed without agreeing, each note still shows the
// gate over the canvas, so Bedrock cannot be used without it.

import { HostBridge } from './bridge.js';

const PROBE_MS = 15_000;

/** The address of the welcome page next to the unpacked web app. */
export function welcomeUrl(appUrl) {
  return appUrl.replace(/index\.html(\?|$)/, 'welcome/index.html$1');
}

/**
 * Resolves to `not-needed`, `agreed`, `closed` (the window was closed
 * without agreeing) or `no-answer` (the page did not load).
 *
 * @param {object} o
 * @param {Document} o.doc the document to put the hidden iframe in
 * @param {string} o.url the welcome page (`welcomeUrl`), with `?host=…`
 * @param {(w: { mount: (el: HTMLElement) => void, onClose: () => void }) => { close(): void }} o.open
 *        show a window: call `mount` with its content element when it
 *        opens, and `onClose` whenever it closes
 */
export function askAtLaunch({ doc, url, open, probeMs = PROBE_MS }) {
  const join = (extra) => `${url}${url.includes('?') ? '&' : '?'}${extra}`;
  const win = doc.defaultView;
  const frameIn = (parent, src, hidden) => {
    const f = doc.createElement('iframe');
    f.className = 'bedrock-welcome-frame';
    if (hidden) f.style.display = 'none';
    f.src = src;
    parent.append(f);
    return f;
  };

  return new Promise((resolve) => {
    let probe = null;
    let probeBridge = null;
    const endProbe = () => { probeBridge?.close(); probe?.remove(); probe = probeBridge = null; };
    const timer = setTimeout(() => { endProbe(); resolve('no-answer'); }, probeMs);

    probeBridge = new HostBridge(() => probe?.contentWindow, {
      consent: async ({ needed } = {}) => {
        clearTimeout(timer);
        // Answer first, then take the probe away.
        setTimeout(endProbe, 0);
        if (!needed) return resolve('not-needed');
        let frame = null;
        let bridge = null;
        let done = false;
        const finish = (how) => {
          if (done) return;
          done = true;
          bridge?.close();
          frame?.remove();
          resolve(how);
        };
        const shown = open({
          mount: (el) => {
            frame = frameIn(el, url, false);
            bridge = new HostBridge(() => frame?.contentWindow, {
              consent: async ({ needed: still } = {}) => {
                if (!still) { finish('agreed'); setTimeout(() => shown.close(), 0); }
                return null;
              },
            });
            bridge.listen(win);
          },
          onClose: () => finish('closed'),
        });
        return null;
      },
    });
    probeBridge.listen(win);
    probe = frameIn(doc.body, join('probe=1'), true);
  });
}
