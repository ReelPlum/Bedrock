// The pen that writes while a note opens (openspec saving-and-opening).
// The drawing is plain SVG and CSS in index.html, shown from the first
// paint so it covers start-up (the WebAssembly loading) too; this only
// says when it shows and when it goes. CSS waits a moment before fading
// it in, so a note that opens at once shows nothing. It goes at once, with
// no fade, so the opened note's ink shows straight away.

export class NoteLoading {
  /** `el` is #note-loading. If it is showing already (the page has just
   *  loaded), that counts as one open in progress until `started()`. */
  constructor(el) {
    this.el = el;
    this.open = el && !el.hidden ? 1 : 0;
  }

  get showing() { return !!this.el && !this.el.hidden; }

  show() {
    if (!this.el) return;
    this.open++;
    this.el.hidden = false;
  }

  hide() {
    if (!this.el) return;
    this.open = Math.max(0, this.open - 1);
    if (!this.open) this.el.hidden = true;
  }

  /** Runs `job` (opening a note) with the pen showing. */
  async during(job) {
    this.show();
    try { return await job(); } finally { this.hide(); }
  }

  /** The app has started and its first note is open: the pen that showed
   *  from the first paint goes. */
  started() {
    if (this.open) this.hide();
  }

  /** Start-up failed: it goes, out of the way of the message. */
  stop() {
    if (!this.el) return;
    this.open = 0;
    this.el.hidden = true;
  }
}
