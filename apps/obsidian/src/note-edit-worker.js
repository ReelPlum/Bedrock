// Adds tags to saved notes and sets their paper for "Add tags…" and
// "Change paper…" in the file explorer's menu (bulk-edit.js), off
// Obsidian's main thread so tagging hundreds of notes never freezes it.
// The note is read and written by bedrock-core, as the canvas reads and
// saves it (`edit_saved_note`, bedrock_core::note_edit).
//
// The plugin hands over the compiled WebAssembly first ({ wasm }), then one
// note at a time ({ id, bytes, tags, paper, start }); each answer is
// { id, page: { bedrock } } with the new file, { id, page: null } when
// nothing changed, or { id, error }. (The protocol of the PDF reader, so
// bulk-import.js's PdfReader runs it.)
import init, { edit_saved_note } from '../../web/pkg/bedrock_web.js';

let ready = null;

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.wasm) {
    ready = init({ module_or_path: m.wasm });
    return;
  }
  try {
    if (!ready) throw new Error('the note editor was not started');
    await ready;
    const seed = crypto.getRandomValues(new Uint32Array(2));
    const tags = Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === 'string') : [];
    const out = edit_saved_note(new Uint8Array(m.bytes), tags, typeof m.paper === 'string' ? m.paper : '', m.start || Date.now(), seed[0], seed[1]);
    if (!out) {
      self.postMessage({ id: m.id, page: null });
      return;
    }
    const bedrock = out.slice().buffer;
    self.postMessage({ id: m.id, page: { bedrock } }, [bedrock]);
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err?.message || err) });
  }
};
