// The + swatch: a colour input that adds the colour picked to a palette
// (the toolbar's, and the selection menu's Color view).
//
// One opening of the picker makes at most one swatch. Browsers disagree on
// when `change` fires (Safari fires it on every move in the wheel), so the
// colour is only previewed while the picker is open and committed when it
// closes: the input loses focus, the next tap elsewhere, Escape/Enter, the
// page hiding, or the picker sitting still for a moment. A commit within the
// same opening changes the swatch it made instead of adding another.

export class SwatchPicker {
  /**
   * `palette()` is the palette to add to (an array of `#rrggbb`, changed in
   * place). `preview(colour)` is called while the picker moves, `commit(colour)`
   * once per settled pick, after the palette was updated. `onOpen()` when the
   * picker is opened.
   */
  constructor(input, { palette, preview = () => {}, commit = () => {}, onOpen = () => {} }) {
    this.input = input;
    this.palette = palette;
    this.preview = preview;
    this.commit = commit;
    // { color: pending colour or null, palette, owned: colour of the swatch this opening made }
    this.pick = null;
    this.timer = 0;
    const settle = () => this.settle();
    input.addEventListener('click', () => {
      settle();
      this.pick = { color: null, palette: null, owned: null };
      onOpen();
    });
    input.addEventListener('input', (e) => { clearTimeout(this.timer); this._preview(e.target.value); });
    input.addEventListener('change', (e) => {
      this._preview(e.target.value);
      clearTimeout(this.timer);
      this.timer = setTimeout(settle, 700);
    });
    input.addEventListener('blur', settle);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Enter') settle(); });
    document.addEventListener('pointerdown', (e) => { if (e.target !== input) settle(); }, true);
    document.addEventListener('visibilitychange', () => { if (document.hidden) settle(); });
  }

  _preview(value) {
    if (!this.pick) this.pick = { color: null, palette: null, owned: null };
    this.pick.color = value;
    this.preview(value);
  }

  /** Commit the pending colour, if there is one. */
  settle() {
    clearTimeout(this.timer);
    const pick = this.pick;
    if (!pick || !pick.color) return;
    const c = pick.color.toLowerCase();
    pick.color = null;
    const palette = this.palette();
    const at = (col) => palette.findIndex((p) => p.toLowerCase() === col);
    const mine = pick.palette === palette && pick.owned ? at(pick.owned) : -1;
    if (at(c) >= 0) {
      // Already a swatch: just select it, and drop the one this opening made.
      if (mine >= 0 && at(c) !== mine) palette.splice(mine, 1);
      pick.owned = mine >= 0 && at(c) === mine ? c : null;
    } else if (mine >= 0) {
      palette[mine] = c;
      pick.owned = c;
    } else {
      palette.push(c);
      pick.owned = c;
    }
    pick.palette = palette;
    this.commit(c);
  }
}
