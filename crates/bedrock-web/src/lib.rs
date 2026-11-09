//! WebAssembly entry point for the Bedrock web app.
//!
//! JavaScript creates a [`Canvas`] with two stacked `<canvas>` elements:
//! a base layer for committed ink (redrawn only when the scene or camera
//! changes) and a light overlay for the stroke being written (redrawn on
//! every pen sample). Both are rendered by Rust through WebGL2.

mod gl;

pub use bedrock_core;
use bedrock_core::brush::{Brush, BrushKind, LineStyle};
use bedrock_core::color::Rgba;
use bedrock_core::document::{Change, Document};
use bedrock_core::engine::{Engine, PointerKind, ScreenSample, Tool};
use bedrock_core::format;
use bedrock_core::geom::Vec2;
use bedrock_core::mirror;
use bedrock_core::scene::{ChunkMesh, Scene};
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

fn pointer_kind(kind: &str) -> PointerKind {
    match kind {
        "pen" => PointerKind::Pen,
        "eraser" => PointerKind::PenEraser,
        "touch" => PointerKind::Touch,
        _ => PointerKind::Mouse,
    }
}

fn paper_mode(p: &str) -> i32 {
    match p {
        "dots" => 1,
        "grid" => 2,
        "lines" => 3,
        _ => 0,
    }
}

fn seed(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | lo as u64
}

#[wasm_bindgen]
pub struct Canvas {
    engine: Engine,
    scene: Scene,
    base: gl::Layer,
    overlay: gl::Layer,
    css: (f64, f64),
    dpr: f64,
}

#[wasm_bindgen]
impl Canvas {
    /// `seed_hi`/`seed_lo`: 64 random bits (crypto.getRandomValues) for stroke ids.
    #[wasm_bindgen(constructor)]
    pub fn new(
        base: HtmlCanvasElement,
        overlay: HtmlCanvasElement,
        seed_hi: u32,
        seed_lo: u32,
    ) -> Result<Canvas, JsValue> {
        Ok(Canvas {
            engine: Engine::new(seed(seed_hi, seed_lo)),
            scene: Scene::new(),
            base: gl::Layer::new(base, true)?,
            overlay: gl::Layer::new(overlay, false)?,
            css: (1.0, 1.0),
            dpr: 1.0,
        })
    }

    /// Recreate GPU state after the browser lost and restored the WebGL context.
    pub fn restore_gpu(&mut self) -> Result<(), JsValue> {
        let base = self.base.canvas.clone();
        let overlay = self.overlay.canvas.clone();
        self.base = gl::Layer::new(base, true)?;
        self.overlay = gl::Layer::new(overlay, false)?;
        self.scene = Scene::new();
        self.resize(self.css.0, self.css.1, self.dpr);
        Ok(())
    }

    pub fn resize(&mut self, css_width: f64, css_height: f64, dpr: f64) {
        self.css = (css_width, css_height);
        self.dpr = dpr.clamp(0.5, 4.0);
        self.base.resize(css_width, css_height, self.dpr);
        self.overlay.resize(css_width, css_height, self.dpr);
        self.engine.resize(css_width, css_height);
    }

    // ----- input ----------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn pointer_down(
        &mut self,
        id: i32,
        kind: &str,
        x: f64,
        y: f64,
        pressure: f32,
        altitude: f32,
        azimuth: f32,
        time: f64,
    ) {
        self.engine.pointer_down(id, pointer_kind(kind), ScreenSample { x, y, pressure, altitude, azimuth, time });
    }

    #[allow(clippy::too_many_arguments)]
    pub fn pointer_move(
        &mut self,
        id: i32,
        kind: &str,
        x: f64,
        y: f64,
        pressure: f32,
        altitude: f32,
        azimuth: f32,
        time: f64,
    ) {
        self.engine.pointer_move(id, pointer_kind(kind), ScreenSample { x, y, pressure, altitude, azimuth, time });
    }

    /// Predicted samples, flat `[x, y, pressure, altitude, azimuth, time, ...]`.
    pub fn pointer_predicted(&mut self, id: i32, samples: &[f64]) {
        let s: Vec<ScreenSample> = samples
            .as_chunks::<6>()
            .0
            .iter()
            .map(|c| ScreenSample {
                x: c[0],
                y: c[1],
                pressure: c[2] as f32,
                altitude: c[3] as f32,
                azimuth: c[4] as f32,
                time: c[5],
            })
            .collect();
        self.engine.set_predicted(id, &s);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn pointer_up(
        &mut self,
        id: i32,
        kind: &str,
        x: f64,
        y: f64,
        pressure: f32,
        altitude: f32,
        azimuth: f32,
        time: f64,
    ) {
        self.engine.pointer_up(id, pointer_kind(kind), Some(ScreenSample { x, y, pressure, altitude, azimuth, time }));
    }

    pub fn pointer_cancel(&mut self, id: i32, kind: &str) {
        self.engine.pointer_cancel(id, pointer_kind(kind));
    }

    pub fn is_drawing(&self) -> bool {
        self.engine.is_drawing()
    }

    pub fn pan(&mut self, dx: f64, dy: f64) {
        self.engine.pan(dx, dy);
    }

    pub fn zoom_at(&mut self, x: f64, y: f64, factor: f64) {
        self.engine.zoom_at(x, y, factor);
    }

    // ----- tools ----------------------------------------------------------

    /// `kind`: pen | pencil | fountain | marker | highlighter. `color`: #rrggbb[aa].
    pub fn set_brush(&mut self, kind: &str, color: &str, size: f32) -> Result<(), JsValue> {
        let kind = BrushKind::from_name(kind).ok_or_else(|| JsValue::from_str("unknown brush"))?;
        let color = Rgba::parse(color).ok_or_else(|| JsValue::from_str("invalid color"))?;
        let (style, stabilizer) = (self.engine.brush.style, self.engine.brush.stabilizer);
        self.engine.brush =
            Brush::new(kind, color, size.clamp(0.2, 200.0)).with_style(style).with_stabilizer(stabilizer);
        Ok(())
    }

    /// Line style (`solid` | `dashed` | `dotted`) and stabiliser amount (0..1)
    /// for strokes drawn from now on. Kept across `set_brush` calls.
    pub fn set_brush_style(&mut self, style: &str, stabilizer: f32) -> Result<(), JsValue> {
        let style = LineStyle::from_name(style).ok_or_else(|| JsValue::from_str("unknown line style"))?;
        self.engine.brush = self.engine.brush.with_style(style).with_stabilizer(stabilizer);
        Ok(())
    }

    /// Draw everything again on the next frame. Used when the page becomes
    /// visible again: a browser may drop a WebGL frame drawn while hidden
    /// (e.g. behind the iPad file picker), and nothing else would redraw it.
    pub fn redraw(&mut self) {
        self.engine.invalidate();
    }

    /// Minimap area `[x0, y0, x1, y1]` in world units: the drawing, widened
    /// as far as needed to keep the camera's view in sight.
    pub fn minimap_region(&self) -> Vec<f64> {
        let ink = self.engine.doc.bounds();
        let view = self.engine.camera.visible_world();
        let r = bedrock_core::overview::region(&ink, &view);
        vec![r.min.x, r.min.y, r.max.x, r.max.y]
    }

    /// The drawing's bounding box `[x0, y0, x1, y1]`, empty if there is no ink.
    pub fn ink_bounds(&self) -> Vec<f64> {
        let r = self.engine.doc.bounds();
        if r.is_empty() {
            return Vec::new();
        }
        vec![r.min.x, r.min.y, r.max.x, r.max.y]
    }

    /// Zoom limits `[min, max]`.
    pub fn zoom_limits(&self) -> Vec<f64> {
        vec![bedrock_core::camera::MIN_ZOOM, bedrock_core::camera::MAX_ZOOM]
    }

    /// The camera's view `[x0, y0, x1, y1]` in world units.
    pub fn view_rect(&self) -> Vec<f64> {
        let r = self.engine.camera.visible_world();
        vec![r.min.x, r.min.y, r.max.x, r.max.y]
    }

    /// Centre the view on world point (x, y), keeping the zoom.
    pub fn center_on(&mut self, x: f64, y: f64) {
        if !(x.is_finite() && y.is_finite()) {
            return;
        }
        let zoom = self.engine.camera.zoom;
        self.engine.camera.center_on(Vec2::new(x, y), zoom);
        self.engine.invalidate();
    }

    /// Simplified strokes for the minimap (see `overview::polylines`).
    pub fn minimap_strokes(&self, tolerance: f64) -> Vec<f64> {
        bedrock_core::overview::polylines(&self.engine.doc, tolerance)
    }

    /// Swap in another document. The scene is rebuilt from scratch: it only
    /// syncs when the revision changes, and a freshly opened note can have
    /// the same revision as the one before it (bug: opened notes stayed
    /// blank until you drew something).
    fn replace_document(&mut self, doc: Document) {
        self.engine.set_document(doc);
        self.base.clear_chunks();
        self.scene = Scene::new();
        self.engine.invalidate();
    }

    /// Pressure feel for this device, -1 (firm) ..= 1 (soft), 0 = linear.
    /// Only changes how pressure is drawn; the file keeps raw pressure.
    pub fn set_pressure_softness(&mut self, softness: f32) {
        if (bedrock_core::pen::pressure_softness() - softness).abs() < 1e-6 {
            return;
        }
        bedrock_core::pen::set_pressure_softness(softness);
        self.base.clear_chunks();
        self.scene = Scene::new();
        self.engine.invalidate();
    }

    /// `draw` | `erase-stroke` | `erase-partial`
    pub fn set_tool(&mut self, tool: &str) {
        self.engine.tool = match tool {
            "erase-stroke" => Tool::EraseStroke,
            "erase-partial" => Tool::ErasePartial,
            _ => Tool::Draw,
        };
    }

    pub fn set_eraser_size(&mut self, css_px: f64) {
        self.engine.eraser_size = css_px.clamp(2.0, 200.0);
    }

    pub fn set_finger_drawing(&mut self, on: bool) {
        self.engine.finger_drawing = on;
    }

    pub fn undo(&mut self) -> bool {
        self.engine.undo()
    }
    pub fn redo(&mut self) -> bool {
        self.engine.redo()
    }
    pub fn can_undo(&self) -> bool {
        self.engine.doc.can_undo()
    }
    pub fn can_redo(&self) -> bool {
        self.engine.doc.can_redo()
    }

    // ----- view -----------------------------------------------------------

    /// `[offset_x, offset_y, zoom]`
    pub fn camera(&self) -> Vec<f64> {
        let c = &self.engine.camera;
        vec![c.offset.x, c.offset.y, c.zoom]
    }

    pub fn set_camera(&mut self, x: f64, y: f64, zoom: f64) {
        if x.is_finite() && y.is_finite() && zoom.is_finite() && zoom > 0.0 {
            self.engine.camera.offset = Vec2::new(x, y);
            self.engine.camera.zoom = zoom.clamp(bedrock_core::camera::MIN_ZOOM, bedrock_core::camera::MAX_ZOOM);
            self.engine.camera.clamp();
            self.engine.invalidate();
        }
    }

    pub fn fit_content(&mut self) {
        let b = self.engine.doc.bounds();
        self.engine.camera.fit(&b, 40.0);
        self.engine.invalidate();
    }

    pub fn needs_render(&self) -> bool {
        self.engine.needs_render() || self.base.is_lost()
    }

    /// Draw whatever changed. Returns true if anything was drawn.
    pub fn render(&mut self) -> bool {
        if !self.engine.needs_render() {
            return false;
        }
        if self.engine.needs_scene_render() {
            self.render_scene();
        }
        if self.engine.needs_live_render() {
            self.render_live();
        }
        self.engine.mark_rendered();
        true
    }

    fn render_scene(&mut self) {
        let diff = self.scene.sync(&self.engine.doc);
        for k in diff.removed {
            self.base.remove_chunk(k);
        }
        for (info, mesh) in &diff.added {
            self.base.add_chunk(info, mesh);
        }
        let view = self.engine.camera.visible_world();
        let doc = &self.engine.doc;
        self.base.render_scene(
            &self.engine.camera,
            self.dpr,
            doc.background,
            paper_mode(&doc.paper),
            self.scene.visible(&view),
        );
    }

    fn render_live(&mut self) {
        let mesh = match (self.engine.live_mesh(), self.engine.live_stroke()) {
            (Some(m), Some(s)) => {
                let mut cm = ChunkMesh::default();
                cm.append_mesh(&m, s);
                Some(cm)
            }
            _ => None,
        };
        self.overlay.render_live(&self.engine.camera, self.dpr, mesh.as_ref());
    }

    /// Test hook: render everything now and read the base layer's pixel at a
    /// CSS position as `[r, g, b, a]`.
    pub fn pixel_at(&mut self, css_x: f64, css_y: f64) -> Vec<u8> {
        self.render_scene();
        self.base.read_pixel((css_x * self.dpr) as i32, (css_y * self.dpr) as i32)
    }

    pub fn chunk_count(&self) -> usize {
        self.scene.chunk_count()
    }

    // ----- document -------------------------------------------------------

    pub fn stroke_count(&self) -> usize {
        self.engine.doc.len()
    }

    pub fn revision(&self) -> f64 {
        self.engine.doc.revision() as f64
    }

    /// Drain the change feed as `[{type: "added"|"removed", id}]` — used for
    /// autosave and, later, live handwriting recognition.
    pub fn take_changes(&mut self) -> js_sys::Array {
        let out = js_sys::Array::new();
        for c in self.engine.doc.take_changes() {
            let o = js_sys::Object::new();
            let (t, id) = match c {
                Change::Added(id) => ("added", id),
                Change::Removed(id) => ("removed", id),
            };
            let _ = js_sys::Reflect::set(&o, &"type".into(), &t.into());
            let _ = js_sys::Reflect::set(&o, &"id".into(), &id.to_string().into());
            out.push(&o);
        }
        out
    }

    /// One stroke as JSON (same shape as in note.json), for recognisers.
    pub fn stroke_json(&self, id: &str) -> Option<String> {
        let id = bedrock_core::stroke::StrokeId::parse(id)?;
        let s = self.engine.doc.find(id)?;
        let mut d = Document::new(0);
        d.set_strokes(vec![s.clone()]);
        let v: serde_json::Value = serde_json::from_str(&format::to_json(&d)).ok()?;
        v.get("strokes").and_then(|a| a.get(0)).map(|s| s.to_string())
    }

    pub fn title(&self) -> String {
        self.engine.doc.title.clone()
    }
    pub fn set_title(&mut self, t: &str) {
        self.engine.doc.title = t.to_string();
    }
    pub fn paper(&self) -> String {
        self.engine.doc.paper.clone()
    }
    pub fn set_paper(&mut self, p: &str) {
        self.engine.doc.paper = p.to_string();
        self.engine.invalidate();
    }
    pub fn set_times(&mut self, created: f64, modified: f64) {
        self.engine.doc.created = created;
        self.engine.doc.modified = modified;
    }

    /// Start a fresh, empty note.
    pub fn new_document(&mut self, seed_hi: u32, seed_lo: u32) {
        self.replace_document(Document::new(seed(seed_hi, seed_lo)));
    }

    /// `.bedrock` file bytes (ZIP).
    pub fn export_bedrock(&self) -> Vec<u8> {
        format::to_bedrock(&self.engine.doc)
    }

    /// Standalone SVG with the note data embedded.
    pub fn export_svg(&self) -> String {
        format::to_svg(&self.engine.doc)
    }

    pub fn export_json(&self) -> String {
        format::to_json(&self.engine.doc)
    }

    /// Note fields other than strokes (title, paper, times, ...) as note JSON.
    pub fn meta_json(&self) -> String {
        format::to_json(&mirror::meta_only(&self.engine.doc))
    }

    /// Position of a stroke in drawing order, or -1.
    pub fn stroke_index(&self, id: &str) -> i32 {
        bedrock_core::stroke::StrokeId::parse(id)
            .and_then(|id| self.engine.doc.strokes().iter().position(|s| s.id == id))
            .map_or(-1, |i| i as i32)
    }

    /// Fingerprint of the strokes (ids, order and sample counts), to check
    /// that the background saver's copy matches.
    pub fn content_hash(&self) -> String {
        mirror::content_hash(&self.engine.doc)
    }

    /// Open a `.bedrock`, Bedrock `.svg` or note `.json`. Returns warnings
    /// about damaged data that was skipped (empty for a healthy file).
    pub fn load(&mut self, bytes: &[u8], seed_hi: u32, seed_lo: u32) -> Result<js_sys::Array, JsValue> {
        let loaded =
            format::load_bytes(bytes, seed(seed_hi, seed_lo)).map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.replace_document(loaded.doc);
        Ok(loaded.warnings.into_iter().map(JsValue::from).collect())
    }
}

/// Builds a ZIP archive from JavaScript (used for "export all notes").
#[wasm_bindgen]
#[derive(Default)]
pub struct ZipBuilder {
    files: Vec<(String, Vec<u8>)>,
}

#[wasm_bindgen]
impl ZipBuilder {
    #[wasm_bindgen(constructor)]
    pub fn new() -> ZipBuilder {
        ZipBuilder::default()
    }

    pub fn add(&mut self, name: &str, bytes: &[u8]) {
        self.files.push((name.to_string(), bytes.to_vec()));
    }

    pub fn finish(&self) -> Vec<u8> {
        let refs: Vec<(&str, &[u8])> = self.files.iter().map(|(n, b)| (n.as_str(), b.as_slice())).collect();
        bedrock_core::zip::write(&refs)
    }
}

/// Note title stored in a file, without opening it on the canvas (for the library).
#[wasm_bindgen]
pub fn peek_title(bytes: &[u8]) -> Option<String> {
    format::load_bytes(bytes, 0).ok().map(|l| l.doc.title)
}

/// The background saver's copy of a note (see `bedrock_core::mirror`). It
/// lives in a Web Worker, so writing a large note never stalls drawing.
#[wasm_bindgen]
#[derive(Default)]
pub struct NoteMirror {
    inner: mirror::Mirror,
}

#[wasm_bindgen]
impl NoteMirror {
    #[wasm_bindgen(constructor)]
    pub fn new() -> NoteMirror {
        NoteMirror::default()
    }

    /// Replace the copy with a whole note (`.bedrock`, SVG or JSON bytes).
    pub fn reset(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        self.inner.reset(bytes).map_err(|e| JsValue::from_str(&e))
    }

    /// See `bedrock_core::mirror::Mirror::apply`.
    pub fn apply(
        &mut self,
        meta: Option<String>,
        touched: Vec<String>,
        added: &str,
        index: &[u32],
    ) -> Result<(), JsValue> {
        self.inner.apply(meta.as_deref(), &touched, added, index).map_err(|e| JsValue::from_str(&e))
    }

    pub fn content_hash(&self) -> String {
        mirror::content_hash(self.inner.doc())
    }

    pub fn stroke_count(&self) -> usize {
        self.inner.doc().len()
    }

    pub fn export_bedrock(&self) -> Vec<u8> {
        format::to_bedrock(self.inner.doc())
    }
}
