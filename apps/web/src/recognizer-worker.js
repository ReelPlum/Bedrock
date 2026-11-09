// Handwriting recognition worker: runs the models off the main thread so
// writing never stutters.
//
//  * Text: TrOCR (small, trained on handwritten English lines).
//  * Maths: Pix2Text's formula recogniser (MFR), which answers in LaTeX.
//
// Both run on the device with Transformers.js (ONNX Runtime, WebGPU where
// available, WebAssembly otherwise). The library is loaded on first use and
// each model is downloaded once, then cached by the browser.
//
// Messages in:  { id, kind: 'text' | 'math', image: Blob }
// Messages out: { id, text, engine } | { id, error }
//               { status: 'loading' | 'ready', kind, progress? }

const LIBRARY = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';
export const MODELS = {
  text: 'Xenova/trocr-small-handwritten',
  math: 'breezedeus/pix2text-mfr',
};

let lib = null;
const pipes = {};

async function pipe(kind) {
  if (!pipes[kind]) {
    pipes[kind] = (async () => {
      lib ||= await import(LIBRARY);
      const model = MODELS[kind];
      self.postMessage({ status: 'loading', kind, model });
      const device = 'gpu' in navigator ? 'webgpu' : 'wasm';
      const p = await lib.pipeline('image-to-text', model, {
        device,
        dtype: 'q8',
        progress_callback: (e) => {
          if (e.status === 'progress') self.postMessage({ status: 'loading', kind, model, progress: e.progress });
        },
      });
      self.postMessage({ status: 'ready', kind, model });
      return p;
    })();
    pipes[kind].catch(() => { delete pipes[kind]; });
  }
  return pipes[kind];
}

self.onmessage = async (e) => {
  const { id, kind, image } = e.data;
  try {
    const p = await pipe(kind);
    const img = await lib.RawImage.fromBlob(image);
    const out = await p(img, { max_new_tokens: kind === 'math' ? 128 : 24 });
    const text = (Array.isArray(out) ? out[0] : out)?.generated_text ?? '';
    self.postMessage({ id, text, engine: `${MODELS[kind]} (transformers.js)` });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
