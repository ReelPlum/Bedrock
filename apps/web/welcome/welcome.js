// The launch gate on its own page. The Obsidian plugin loads it when
// Obsidian starts (apps/obsidian/src/consent.js): first hidden, to ask
// whether the gate is needed, then in a window if it is. It tells the
// host with a `consent` request ({ needed }) in the protocol of
// src/host.js. Opened directly in a browser, it goes on to the app.
import * as collect from '../src/collect.js';
import { showGate, gateStyles } from '../src/consent.js';

const inHost = new URLSearchParams(location.search).has('host') && window.parent !== window;
let seq = 0;
const tell = (needed) => {
  if (inHost) window.parent.postMessage({ bedrock: 1, seq: `w${++seq}`, method: 'consent', args: { needed } }, '*');
  else if (!needed) location.replace('../');
};

const probe = new URLSearchParams(location.search).has('probe');
if (!collect.gateNeeded()) {
  tell(false);
} else if (probe) {
  tell(true);
} else {
  gateStyles();
  showGate().then(() => tell(collect.gateNeeded()));
}
window.welcome = { ready: true };
