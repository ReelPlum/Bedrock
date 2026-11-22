// Asking for the invite code and consent when Obsidian starts, before any
// note is open. The question itself is the web app's launch gate
// (apps/web/src/consent.js), on its own page (apps/web/welcome/), so the
// consent, the code and the "Send every word" setting are stored where the
// canvas reads them: the web app's local storage. Free of Obsidian imports
// so it can be tested on its own.
//
// The page is written into each iframe (`page(probe)`, inline-app.js), as
// Obsidian refuses file requests from inside the app's windows.
//
// 1. A hidden iframe gets the page with `probe`, which answers `consent`
//    with `{ needed }` and shows nothing.
// 2. If needed, `open({ mount, onClose })` shows a window (an Obsidian Modal), and
//    `mount(el)` puts the page in it. When the person agrees, the page
//    answers `{ needed: false }` and the window closes.
//
// If the window is closed without agreeing, each note still shows the
// gate over the canvas, so Bedrock cannot be used without it.

import { HostBridge } from './bridge.js';

const PROBE_MS = 15_000;

/**
 * Resolves to `not-needed`, `agreed`, `closed` (the window was closed
 * without agreeing) or `no-answer` (the page did not load).
 *
 * @param {object} o
 * @param {Document} o.doc the document to put the hidden iframe in
 * @param {(probe: boolean) => string} o.page the welcome page's HTML, for
 *        an iframe's srcdoc (`probe`: only ask whether consent is needed)
 * @param {(w: { mount: (el: HTMLElement) => void, onClose: () => void }) => { close(): void }} o.open
 *        show a window: call `mount` with its content element when it
 *        opens, and `onClose` whenever it closes
 */
export function askAtLaunch({ doc, page, open, probeMs = PROBE_MS }) {
  const win = doc.defaultView;
  const frameIn = (parent, probe, hidden) => {
    const f = doc.createElement('iframe');
    f.className = 'bedrock-welcome-frame';
    if (hidden) f.style.display = 'none';
    f.srcdoc = page(probe);
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
            frame = frameIn(el, false, false);
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
    probe = frameIn(doc.body, true, true);
  });
}
