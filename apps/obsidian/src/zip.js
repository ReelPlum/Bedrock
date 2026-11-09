// Reads entries from a ZIP archive (a .bedrock note): stored and deflated
// entries, as written by bedrock-core's zip.rs. Deflate uses the platform's
// DecompressionStream, which Obsidian has on desktop and iPad.

const td = new TextDecoder();

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Entry name -> bytes for the wanted names (all if `want` is omitted).
 *  Damaged entries are skipped, never fatal. */
export async function readZip(buffer, want = null) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = new Map();
  // End of central directory: last 22+ bytes, signature 0x06054b50.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = td.decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const base = name.split('/').pop();
    if (want && !want.includes(name) && !want.includes(base)) continue;
    try {
      if (v.getUint32(local, true) !== 0x04034b50) continue;
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const raw = b.subarray(start, start + size);
      if (method === 0) out.set(base, raw.slice());
      else if (method === 8) out.set(base, await inflateRaw(raw));
    } catch (_) { /* damaged entry: skip it */ }
  }
  return out;
}

export const text = (bytes) => (bytes ? td.decode(bytes) : '');
