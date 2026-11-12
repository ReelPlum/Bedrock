// Pictures and text boxes on the page. A picture is kept as an ordinary image file inside
// the note (images/<hash>.<ext> in the .bedrock), so any tool can open it.
// This module turns a file the writer picks, pastes or drops into such a
// file, and decodes the files of an open note for drawing (the Rust core
// draws them with WebGL, under the ink).

/** Longest side a stored picture keeps; larger photos are scaled down. */
export const MAX_STORED_PX = 2560;
/** Files up to this size in a common format are kept byte for byte. */
const KEEP_BYTES = 3 * 1024 * 1024;
/** Longest side of the decoded copy on the GPU. */
const MAX_TEXTURE_PX = 4096;

const KEEP_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

async function hashName(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

function scaled(w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/**
 * Make a picture file from a File or Blob: `{ file, bytes, width, height }`.
 * Common formats that are small enough are kept as they are; others (HEIC,
 * huge photos) are re-encoded, PNG if they may be transparent, else JPEG.
 * The name is the content's hash, so the same picture is stored once.
 */
export async function preparePicture(blob) {
  const bmp = await createImageBitmap(blob);
  try {
    let { width, height } = bmp;
    let bytes;
    let ext = KEEP_TYPES[blob.type];
    if (ext && blob.size <= KEEP_BYTES && Math.max(width, height) <= MAX_STORED_PX) {
      bytes = new Uint8Array(await blob.arrayBuffer());
    } else {
      [width, height] = scaled(width, height, MAX_STORED_PX);
      const c = new OffscreenCanvas(width, height);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, 0, 0, width, height);
      const png = blob.type === 'image/png' || blob.type === 'image/gif' || blob.type === 'image/webp';
      const out = await c.convertToBlob(png ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.88 });
      ext = png ? 'png' : 'jpg';
      bytes = new Uint8Array(await out.arrayBuffer());
    }
    return { file: `images/${await hashName(bytes)}.${ext}`, bytes, width, height };
  } finally {
    bmp.close?.();
  }
}

// ----- text boxes -------------------------------------------------------------

/** Line height as a multiple of the font size (as the core's SVG export). */
export const TEXT_LINE_HEIGHT = 1.3;
const TEXT_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
const TEXT_INK = '#1c1c1e';
/** Pasted text starts at this size on screen. */
export const TEXT_SIZE_CSS = 18;

let measurer = null;
/** Size of `text` set at `fontPx`: `{ width, height, lines }`. */
export function measureText(text, fontPx) {
  measurer ??= new OffscreenCanvas(1, 1).getContext('2d');
  measurer.font = `${fontPx}px ${TEXT_FONT}`;
  const lines = text.split('\n');
  const width = Math.max(1, ...lines.map((l) => measurer.measureText(l).width));
  return { width: Math.ceil(width + 0.1 * fontPx), height: Math.ceil(lines.length * fontPx * TEXT_LINE_HEIGHT), lines };
}

/** Clean pasted text: normal line ends, no trailing blank lines, tabs as spaces. */
export function tidyText(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/\s+$/, '').slice(0, 20000);
}

/** Draw a text box's text to RGBA pixels (stretched to its box on the page). */
export function drawText(text) {
  let font = 64;
  let m = measureText(text, font);
  const k = Math.min(1, MAX_TEXTURE_PX / m.width, MAX_TEXTURE_PX / m.height);
  if (k < 1) { font = Math.max(4, Math.floor(font * k)); m = measureText(text, font); }
  const c = new OffscreenCanvas(m.width, m.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.font = `${font}px ${TEXT_FONT}`;
  g.fillStyle = TEXT_INK;
  g.textBaseline = 'alphabetic';
  const lineH = font * TEXT_LINE_HEIGHT;
  m.lines.forEach((l, i) => g.fillText(l, 0, lineH * (i + 0.8)));
  return { width: m.width, height: m.height, data: new Uint8Array(g.getImageData(0, 0, m.width, m.height).data.buffer) };
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml' };

/** Decode a stored picture file to RGBA pixels for the GPU. */
export async function decodePicture(file, bytes) {
  const type = MIME[file.split('.').pop().toLowerCase()] || '';
  const bmp = await createImageBitmap(new Blob([bytes], { type }));
  try {
    const [w, h] = scaled(bmp.width, bmp.height, MAX_TEXTURE_PX);
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, w, h);
    return { width: w, height: h, data: new Uint8Array(g.getImageData(0, 0, w, h).data.buffer) };
  } finally {
    bmp.close?.();
  }
}

/**
 * Keeps the canvas supplied with decoded pictures: call `update()` every
 * frame; files the core reports missing are decoded once, in the
 * background, then handed over.
 */
export class PictureLoader {
  constructor(canvas, requestFrame) {
    this.canvas = canvas;
    this.requestFrame = requestFrame;
    this.pending = new Set();
    this.failed = new Set();
  }

  update() {
    for (const file of this.canvas.missing_images()) {
      if (this.pending.has(file) || this.failed.has(file)) continue;
      if (file.startsWith('text:')) {
        try {
          const { width, height, data } = drawText(file.slice(5));
          this.canvas.set_image_pixels(file, width, height, data);
          this.requestFrame();
        } catch (e) {
          console.warn('could not draw a text box', e);
          this.failed.add(file);
        }
        continue;
      }
      const bytes = this.canvas.image_bytes(file);
      if (!bytes) continue;
      this.pending.add(file);
      decodePicture(file, bytes).then(({ width, height, data }) => {
        this.canvas.set_image_pixels(file, width, height, data);
        this.requestFrame();
      }).catch((e) => {
        console.warn(`could not show the picture ${file}`, e);
        this.failed.add(file); // stays a placeholder card
      }).finally(() => this.pending.delete(file));
    }
  }

  /** After the GPU was reset (context lost), everything decodes again. */
  reset() {
    this.failed.clear();
  }
}
