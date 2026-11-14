//! PDF import as its own WebAssembly module. PDF reading (`hayro-syntax`,
//! `png`) is about a tenth of the app, and most people never open a PDF, so
//! the web app loads this module only when one is opened
//! (`apps/web/src/main.js`). See `bedrock_core::pdf`.

use bedrock_core::format;
use wasm_bindgen::prelude::*;

/// The pages of a PDF (a GoodNotes export or similar) with their
/// handwriting as notes: `[{ bedrock: Uint8Array, strokes, readings,
/// warnings: string[] }]`, one per page that has ink.
#[wasm_bindgen]
pub fn import_pdf(bytes: &[u8], seed_hi: u32, seed_lo: u32, start_ms: f64) -> Result<js_sys::Array, JsValue> {
    let seed = ((seed_hi as u64) << 32) | seed_lo as u64;
    let pages = bedrock_core::pdf::import(bytes, seed, start_ms).map_err(|e| JsValue::from_str(&e))?;
    let out = js_sys::Array::new();
    for p in pages {
        let o = js_sys::Object::new();
        let set = |k: &str, v: &JsValue| js_sys::Reflect::set(&o, &JsValue::from_str(k), v).map(|_| ());
        set("bedrock", &js_sys::Uint8Array::from(format::to_bedrock(&p.doc).as_slice()).into())?;
        set("strokes", &JsValue::from(p.doc.len() as u32))?;
        set("readings", &JsValue::from(p.readings as u32))?;
        set("warnings", &p.warnings.into_iter().map(JsValue::from).collect::<js_sys::Array>().into())?;
        out.push(&o);
    }
    Ok(out)
}
