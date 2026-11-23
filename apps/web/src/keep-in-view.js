// Keeps the text box being typed in visible above whatever covers the bottom
// of the page. Inside Obsidian on the iPad the on-screen keyboard covers the
// canvas without resizing it; the plugin says how much is hidden
// (`inset { bottom }`, apps/obsidian/src/keyboard.js). When the focused box
// would be under it, the whole page slides up just enough, the way Safari
// pans a page for its keyboard, and slides back when typing ends.
// Menus that place themselves above the inset (the word menu) need no slide.

const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);
const GAP = 12;

/** A box that brings up the keyboard. */
export function isTextField(el) {
  if (!el || el.disabled || el.readOnly) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_INPUTS.has((el.getAttribute('type') || '').toLowerCase());
}

export class KeepInView {
  constructor(doc = document) {
    this.doc = doc;
    this.inset = 0;
    this.pan = 0;
    doc.addEventListener('focusin', () => this.update());
    // Wait a moment: focus may be moving to another box.
    doc.addEventListener('focusout', () => setTimeout(() => this.update(), 0));
  }

  /** The bottom `px` of the page are hidden. */
  setInset(px) {
    this.inset = Math.max(0, Number(px) || 0);
    this.update();
  }

  /** How far the page must slide up so the focused box is in sight. */
  needed() {
    const el = this.doc.activeElement;
    if (!this.inset || !isTextField(el)) return 0;
    const win = this.doc.defaultView;
    // Where the box is with the page not slid (the body starts at the top
    // of the page; it may be mid-slide).
    const r = el.getBoundingClientRect();
    const slid = this.doc.body.getBoundingClientRect().top;
    const bottom = r.bottom - slid;
    const top = r.top - slid;
    const limit = win.innerHeight - this.inset - GAP;
    if (bottom <= limit) return 0;
    // Never so far that the box's top leaves the screen.
    return Math.round(Math.max(0, Math.min(bottom - limit, this.inset, top - GAP)));
  }

  update() {
    const pan = this.needed();
    if (pan === this.pan) return;
    this.pan = pan;
    const body = this.doc.body;
    body.style.transition = 'transform 0.2s ease-out';
    body.style.transform = pan ? `translateY(${-pan}px)` : '';
  }
}
