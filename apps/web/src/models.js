// The recognition models, shared by the app and the recogniser worker.
//
//  * text.fast: TrOCR small (handwritten), read live as you write.
//  * text.careful: TrOCR base (handwritten), about 5x larger and more
//    accurate on untidy writing; re-reads words in the background once the
//    pen has rested. (TrOCR large exists only as unquantised ONNX, ~2 GB,
//    too much for a tablet browser.)
//  * math: Pix2Text MFR 1.5, formulas to LaTeX.
export const MODELS = {
  text: { fast: 'Xenova/trocr-small-handwritten', careful: 'Xenova/trocr-base-handwritten' },
  math: 'breezedeus/pix2text-mfr-1.5',
};
