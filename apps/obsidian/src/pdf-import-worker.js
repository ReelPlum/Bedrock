// Reads PDFs for the bulk import in the settings (bulk-import.js), off
// Obsidian's main thread so it never freezes. The same reader as importing
// a PDF into an open note: crates/bedrock-pdf's `import_pdf_as_one_note`.
// The plugin hands over the compiled WebAssembly first ({ wasm }), then one
// PDF at a time ({ id, bytes, start, paper }, paper being the
// "Paper for new notes" setting); each answer is { id, page } (null
// when no page has ink or pictures) or { id, error }.
import init, { import_pdf_as_one_note } from '../../web/pkg/bedrock_pdf.js';

let ready = null;

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.wasm) {
    ready = init({ module_or_path: m.wasm });
    return;
  }
  try {
    if (!ready) throw new Error('the PDF reader was not started');
    await ready;
    const seed = crypto.getRandomValues(new Uint32Array(2));
    const page = import_pdf_as_one_note(new Uint8Array(m.bytes), seed[0], seed[1], m.start || Date.now(), typeof m.paper === 'string' ? m.paper : undefined);
    if (!page) {
      self.postMessage({ id: m.id, page: null });
      return;
    }
    const bedrock = page.bedrock.slice().buffer;
    self.postMessage({ id: m.id, page: { bedrock, warnings: [...page.warnings], strokes: page.strokes } }, [bedrock]);
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err?.message || err) });
  }
};
