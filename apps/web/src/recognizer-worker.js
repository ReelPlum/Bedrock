// Handwriting recognition worker: runs the models off the main thread so
// writing never stutters.
//
//  * Text: TrOCR (small, trained on handwritten English lines), through
//    Transformers.js.
//  * Maths: Pix2Text's formula recogniser, MFR 1.5 (breezedeus/pix2text-mfr-1.5,
//    MIT), which answers in LaTeX. It is a TrOCR-style encoder-decoder, but
//    its repo keeps plain ONNX files at the top level (encoder_model.onnx,
//    decoder_model.onnx, no onnx/ folder, no merged or quantised decoder),
//    which Transformers.js can't load. So it runs directly on ONNX Runtime
//    Web here: resize to 384x384, normalise, encode once, then greedy
//    decoding (the decoder has no key/value cache, so each step re-reads the
//    tokens so far; formulas are short and the decoder is small).
//
// Everything runs on the device. Libraries are loaded on first use and each
// model is downloaded once, then cached by the browser.
//
// Messages in:  { id, kind: 'text' | 'math', image: Blob }
// Messages out: { id, text, engine } | { id, error }
//               { status: 'loading' | 'ready', kind, progress? }

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';
const ORT_DIR = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/';
export const MODELS = {
  text: 'Xenova/trocr-small-handwritten',
  math: 'breezedeus/pix2text-mfr-1.5',
};
// From the model's preprocessor_config.json and generation_config.json.
export const MFR = {
  size: 384,
  mean: 0.5,
  std: 0.5,
  start: 1, // decoder_start_token_id
  eos: 2,
  maxTokens: 160,
};
const MODEL_CACHE = 'bedrock-models-v1';

let lib = null;
const loaders = {};

function once(kind, load) {
  if (!loaders[kind]) {
    loaders[kind] = load();
    loaders[kind].catch(() => { delete loaders[kind]; });
  }
  return loaders[kind];
}

// ----- text: Transformers.js pipeline ----------------------------------------

function textPipeline() {
  return once('text', async () => {
    lib ||= await import(TRANSFORMERS);
    const model = MODELS.text;
    self.postMessage({ status: 'loading', kind: 'text', model });
    const device = 'gpu' in navigator ? 'webgpu' : 'wasm';
    const p = await lib.pipeline('image-to-text', model, {
      device,
      dtype: 'q8',
      progress_callback: (e) => {
        if (e.status === 'progress') self.postMessage({ status: 'loading', kind: 'text', model, progress: e.progress });
      },
    });
    self.postMessage({ status: 'ready', kind: 'text', model });
    return p;
  });
}

async function readText(image) {
  const p = await textPipeline();
  const img = await lib.RawImage.fromBlob(image);
  const out = await p(img, { max_new_tokens: 24 });
  return (Array.isArray(out) ? out[0] : out)?.generated_text ?? '';
}

// ----- maths: Pix2Text MFR on ONNX Runtime -------------------------------------

/** Download a file once and keep it in the Cache API, reporting progress. */
async function fetchCached(url, onProgress) {
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  const hit = cache && (await cache.match(url));
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) onProgress(got / total);
  }
  const bytes = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  await cache?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
  return bytes;
}

function mathModel() {
  return once('math', async () => {
    const model = MODELS.math;
    self.postMessage({ status: 'loading', kind: 'math', model });
    const [ort, tf] = await Promise.all([import(`${ORT_DIR}ort.min.mjs`), lib ? lib : import(TRANSFORMERS)]);
    lib ||= tf;
    ort.env.wasm.wasmPaths = ORT_DIR;
    ort.env.logLevel = 'error'; // not its CPU-detection warnings
    const base = `https://huggingface.co/${model}/resolve/main/`;
    const shares = { 'encoder_model.onnx': 0.75, 'decoder_model.onnx': 0.25 };
    const done = {};
    const progress = (name) => (f) => {
      done[name] = f;
      const p = Object.entries(shares).reduce((s, [n, w]) => s + w * (done[n] || 0), 0);
      self.postMessage({ status: 'loading', kind: 'math', model, progress: Math.round(p * 100) });
    };
    const [enc, dec, tokenizer] = await Promise.all([
      fetchCached(`${base}encoder_model.onnx`, progress('encoder_model.onnx')),
      fetchCached(`${base}decoder_model.onnx`, progress('decoder_model.onnx')),
      lib.AutoTokenizer.from_pretrained(model),
    ]);
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const encoder = await ort.InferenceSession.create(enc, opts);
    const decoder = await ort.InferenceSession.create(dec, opts);
    self.postMessage({ status: 'ready', kind: 'math', model });
    return { ort, encoder, decoder, tokenizer };
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
  const { ort, encoder, decoder, tokenizer } = await mathModel();
  const n = MFR.size;
  const pixels = new ort.Tensor('float32', await mfrPixels(image), [1, 3, n, n]);
  const encOut = await encoder.run({ [encoder.inputNames[0]]: pixels });
  const hidden = encOut[encoder.outputNames[0]];
  const idsName = decoder.inputNames.find((k) => k.includes('input_ids'));
  const hiddenName = decoder.inputNames.find((k) => k.includes('encoder_hidden_states'));
  const tokens = await mfrGreedy(async (tokens) => {
    const ids = new ort.Tensor('int64', BigInt64Array.from(tokens, BigInt), [1, tokens.length]);
    const out = await decoder.run({ [idsName]: ids, [hiddenName]: hidden });
    const logits = out.logits || out[decoder.outputNames[0]];
    const vocab = logits.dims[2];
    return logits.data.subarray((tokens.length - 1) * vocab, tokens.length * vocab);
  });
  return tokenizer.decode(tokens.slice(1), { skip_special_tokens: true }).trim();
}

self.onmessage = async (e) => {
  const { id, kind, image } = e.data;
  try {
    const text = kind === 'math' ? await readMath(image) : await readText(image);
    self.postMessage({ id, text, engine: kind === 'math' ? `${MODELS.math} (onnxruntime-web)` : `${MODELS.text} (transformers.js)` });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
