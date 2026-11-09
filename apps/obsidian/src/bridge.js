// The host side of the protocol in apps/web/src/host.js: answers the web
// app's requests (read and write the note file, pick and open notes) and
// sends it events (save now, reload). Free of Obsidian imports so it can be
// tested on its own and reused by other hosts.

export class HostBridge {
  /** `frame()` returns the iframe's window; `handlers` maps request names
   *  (read, write, get-kv, set-kv, pick-note, open-link, ready) to async
   *  functions of the request's args. */
  constructor(frame, handlers) {
    this.frame = frame;
    this.handlers = handlers;
    this.seq = 0;
    this.waiting = new Map();
    this.onMessage = (e) => this.handle(e);
  }

  /** Attach to the window that holds the iframe. */
  listen(win) {
    this.win = win;
    win.addEventListener('message', this.onMessage);
  }

  close() {
    this.win?.removeEventListener('message', this.onMessage);
    for (const w of this.waiting.values()) w.resolve(null);
    this.waiting.clear();
  }

  async handle(e) {
    const m = e.data;
    const frame = this.frame();
    if (!frame || e.source !== frame || !m || m.bedrock !== 1) return;
    if (m.reply != null) {
      const w = this.waiting.get(m.reply);
      this.waiting.delete(m.reply);
      if (w) (m.error != null ? w.reject(new Error(m.error)) : w.resolve(m.result));
      return;
    }
    if (m.method == null) return;
    let result = null;
    let error = null;
    try {
      const h = this.handlers[m.method];
      if (!h) throw new Error(`unknown request ${m.method}`);
      result = await h(m.args || {});
    } catch (err) {
      error = String(err?.message || err);
    }
    frame.postMessage({ bedrock: 1, reply: m.seq, result: result ?? null, error }, '*');
  }

  /** Send the app an event; resolves with its answer (null on timeout). */
  send(event, args = {}, timeoutMs = 5000) {
    const frame = this.frame();
    if (!frame) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const id = `h${++this.seq}`;
      const timer = setTimeout(() => { this.waiting.delete(id); resolve(null); }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      frame.postMessage({ bedrock: 1, seq: id, event, args }, '*');
    });
  }
}
