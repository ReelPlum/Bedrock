// Handwriting recognition worker: runs the models off the main thread so
// writing never stutters.
//
//  * Text: TrOCR (trained on handwritten English lines), through
//    Transformers.js: small for live reading, base for the careful re-read
//    (see models.js).
//  * Maths: Pix2Text's formula recogniser, MFR 1.5 (breezedeus/pix2text-mfr-1.5,
//    MIT), which answers in LaTeX. It is a TrOCR-style encoder-decoder, but
//    its repo keeps plain ONNX files at the top level (encoder_model.onnx,
//    decoder_model.onnx, no onnx/ folder, no merged or quantised decoder),
//    which Transformers.js's encoder-decoder loader can't use. So its two
//    files are loaded as plain models and run here: resize to 384x384,
//    normalise, encode once, then greedy decoding (the decoder has no
//    key/value cache, so each step re-reads the tokens so far; formulas are
//    short and the decoder is small).
//
// One ONNX Runtime for all models: iPad Safari can't start a second
// WebAssembly runtime next to Transformers.js's own ("no available backend
// found ... RangeError: Out of memory"). So the formula model is loaded
// through Transformers.js too, as two plain single-file models (its encoder
// and decoder, with the files' real names), and run on Transformers.js's
// sessions directly with greedy decoding.
//
// Everything runs on the device. Libraries are loaded on first use and each
// model is downloaded once, then cached by the browser.
//
// Messages in:  { id, kind: 'text' | 'math', image: Blob, quality?: 'fast' | 'careful' }
// Messages out: { id, text, engine } | { id, error }
//               { status: 'loading' | 'ready', kind, progress? }

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';
import { MODELS } from './models.js';

// From the model's preprocessor_config.json and generation_config.json.
export const MFR = {
  size: 384,
  mean: 0.5,
  std: 0.5,
  start: 1, // decoder_start_token_id
  eos: 2,
  maxTokens: 160,
};

let lib = null;
const loaders = {};

/** Transformers.js, with its own ONNX Runtime (the only one in the page). */
export async function libraries() {
  if (!lib) {
    lib = await import(TRANSFORMERS);
    const wasm = lib.env?.backends?.onnx?.wasm;
    if (wasm) wasm.numThreads = 1; // no cross-origin isolation, and less memory
  }
  return lib;
}

function once(kind, load) {
  if (!loaders[kind]) {
    loaders[kind] = load();
    loaders[kind].catch(() => { delete loaders[kind]; });
  }
  return loaders[kind];
}

// ----- text: Transformers.js pipeline ----------------------------------------

function textPipeline(quality) {
  return once(`text-${quality}`, async () => {
    await libraries();
    const model = MODELS.text[quality];
    self.postMessage({ status: 'loading', kind: 'text', model });
    const p = await lib.pipeline('image-to-text', model, {
      dtype: 'q8',
      session_options: { enableCpuMemArena: false, enableMemPattern: false },
      progress_callback: (e) => {
        if (e.status === 'progress') self.postMessage({ status: 'loading', kind: 'text', model, progress: e.progress });
      },
    });
    self.postMessage({ status: 'ready', kind: 'text', model });
    return p;
  });
}

async function readText(image, quality) {
  const p = await textPipeline(quality);
  const img = await lib.RawImage.fromBlob(image);
  const out = await p(img, { max_new_tokens: 24 });
  return (Array.isArray(out) ? out[0] : out)?.generated_text ?? '';
}

// ----- maths: Pix2Text MFR on ONNX Runtime -------------------------------------

// No arena or memory patterns: lower peak memory, which iPad Safari's
// WebAssembly limit needs more than the last bit of speed.
const LEAN = { enableCpuMemArena: false, enableMemPattern: false };

function mathModel() {
  return once('math', async () => {
    const model = MODELS.math;
    self.postMessage({ status: 'loading', kind: 'math', model });
    await libraries();
    const shares = { encoder_model: 0.75, decoder_model: 0.25 };
    const done = {};
    // Each file as a plain one-file model: config says "no special
    // structure", the file name is the real one, at the repo's top level.
    const part = (name) => lib.AutoModel.from_pretrained(model, {
      config: { model_type: 'bert' },
      model_file_name: name,
      subfolder: '',
      dtype: 'fp32',
      session_options: LEAN,
      progress_callback: (e) => {
        if (e.status !== 'progress' || !String(e.file || '').includes(name)) return;
        done[name] = (e.progress || 0) / 100;
        const p = Object.entries(shares).reduce((s, [n, w]) => s + w * (done[n] || 0), 0);
        self.postMessage({ status: 'loading', kind: 'math', model, progress: Math.round(p * 100) });
      },
    });
    const [enc, dec, tokenizer] = await Promise.all([part('encoder_model'), part('decoder_model'), lib.AutoTokenizer.from_pretrained(model)]);
    self.postMessage({ status: 'ready', kind: 'math', model });
    return { enc, dec, encoder: enc.sessions.model, decoder: dec.sessions.model, tokenizer };
  });
}

/** PNG -> [1, 3, 384, 384] floats, stretched like TrOCRProcessor does. */
export async function mfrPixels(image) {
  const n = MFR.size;
  const bmp = await createImageBitmap(image);
  const c = new OffscreenCanvas(n, n);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.fillStyle = '#fff';
  g.fillRect(0, 0, n, n);
  g.drawImage(bmp, 0, 0, n, n);
  const rgba = g.getImageData(0, 0, n, n).data;
  const out = new Float32Array(3 * n * n);
  for (let i = 0; i < n * n; i++) {
    for (let ch = 0; ch < 3; ch++) out[ch * n * n + i] = (rgba[i * 4 + ch] / 255 - MFR.mean) / MFR.std;
  }
  return out;
}

/** Greedy decoding: `next(tokens)` gives the logits for the token after
 *  `tokens`. Returns the tokens, starting with the start token. */
export async function mfrGreedy(next, maxTokens = MFR.maxTokens) {
  const tokens = [MFR.start];
  for (let step = 0; step < maxTokens; step++) {
    const row = await next(tokens);
    let best = 0;
    for (let v = 1; v < row.length; v++) if (row[v] > row[best]) best = v;
    if (best === MFR.eos) break;
    tokens.push(best);
  }
  return tokens;
}

async function readMath(image) {
  const { encoder, decoder, tokenizer } = await mathModel();
  const n = MFR.size;
  // Transformers.js tensors wrap ONNX Runtime ones (`ort_tensor`), which its
  // sessions take directly.
  const ortTensor = (type, data, dims) => new lib.Tensor(type, data, dims).ort_tensor;
  const pixels = ortTensor('float32', await mfrPixels(image), [1, 3, n, n]);
  const encOut = await encoder.run({ [encoder.inputNames[0]]: pixels });
  const hidden = encOut[encoder.outputNames[0]];
  const idsName = decoder.inputNames.find((k) => k.includes('input_ids'));
  const hiddenName = decoder.inputNames.find((k) => k.includes('encoder_hidden_states'));
  const tokens = await mfrGreedy(async (tokens) => {
    const ids = ortTensor('int64', BigInt64Array.from(tokens, BigInt), [1, tokens.length]);
    const out = await decoder.run({ [idsName]: ids, [hiddenName]: hidden });
    const logits = out.logits || out[decoder.outputNames[0]];
    const vocab = logits.dims[2];
    return logits.data.subarray((tokens.length - 1) * vocab, tokens.length * vocab);
  });
  return tokenizer.decode(tokens.slice(1), { skip_special_tokens: true }).trim();
}

/** Free a model's memory until it is needed again. */
async function release(name) {
  const p = loaders[name];
  if (!p) return;
  delete loaders[name];
  const m = await p.catch(() => null);
  for (const x of [m, m?.enc, m?.dec]) await x?.dispose?.();
}

self.onmessage = async (e) => {
  if (e.data.release) return release(e.data.release);
  const { id, kind, image } = e.data;
  const quality = e.data.quality === 'careful' ? 'careful' : 'fast';
  try {
    const text = kind === 'math' ? await readMath(image) : await readText(image, quality);
    self.postMessage({ id, text, engine: kind === 'math' ? `${MODELS.math} (onnxruntime-web)` : `${MODELS.text[quality]} (transformers.js)` });
  } catch (err) {
    const model = kind === 'math' ? MODELS.math : MODELS.text[quality];
    self.postMessage({ id, error: `${model}: ${String(err && err.message ? err.message : err)}` });
  }
};
