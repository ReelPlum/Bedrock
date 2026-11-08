// Background saver. Keeps its own copy of the open note (a NoteMirror, in
// Rust) that the page updates with small change messages, and writes the
// .bedrock file here, so saving a large note never stalls the pen.
//
// Messages (each gets one reply with the same `seq`):
//   { reset: Uint8Array }  replace the copy with a whole note
//   { ops: { meta, touched, added, index } }  apply changes (see NoteMirror.apply)
//   { export: true }  also reply with the .bedrock bytes as `data`
// Replies carry `hash` (the copy's fingerprint) or `error`.
import init, { NoteMirror } from '../pkg/bedrock_web.js';

let mirror = null;
const ready = init().then(() => { mirror = new NoteMirror(); });

self.onmessage = async (e) => {
  const m = e.data;
  try {
    await ready;
    if (m.reset) mirror.reset(m.reset);
    if (m.ops) mirror.apply(m.ops.meta ?? undefined, m.ops.touched, m.ops.added, Uint32Array.from(m.ops.index));
    const out = { seq: m.seq, hash: mirror.content_hash() };
    if (m.export) {
      out.data = mirror.export_bedrock();
      self.postMessage(out, [out.data.buffer]);
    } else {
      self.postMessage(out);
    }
  } catch (err) {
    self.postMessage({ seq: m.seq, error: String(err && err.message ? err.message : err) });
  }
};
