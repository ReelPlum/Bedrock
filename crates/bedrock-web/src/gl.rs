//! WebGL2 renderer. Everything visible on the canvas is drawn by this Rust
//! code; JavaScript only forwards events and schedules frames.

use bedrock_core::camera::Camera;
use bedrock_core::color::Rgba;
use bedrock_core::geom::Vec2;
use bedrock_core::scene::{ChunkInfo, ChunkMesh};
use std::collections::HashMap;
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{
    HtmlCanvasElement, WebGl2RenderingContext as GL, WebGlBuffer, WebGlProgram, WebGlUniformLocation,
    WebGlVertexArrayObject,
};

// Analytic antialiasing: outline vertices are pushed half a device pixel
// outwards and coverage fades from 1 to 0 across that pixel, computed from
// the exact distance to the stroke edge. This gives smooth ink without
// relying on MSAA, which iOS Safari does not reliably honour.
const INK_VS: &str = r#"#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_color;
layout(location = 2) in vec4 a_edge;      // dir.xy, edge, pad (snorm8)
layout(location = 3) in float a_half_width;
uniform vec2 u_scale;
uniform vec2 u_offset;
uniform float u_px;                       // world units per device pixel
out vec4 v_color;
out float v_dist;                         // signed distance from centre line, device px
out float v_half;                         // half width, device px
const float GROW = 0.5;
void main() {
  v_color = a_color;
  float half_px = a_half_width / u_px;
  vec2 p = a_pos + a_edge.xy * (GROW * u_px);
  v_dist = a_edge.z * (half_px + GROW);
  v_half = half_px;
  gl_Position = vec4(p * u_scale + u_offset, 0.0, 1.0);
}"#;

const INK_FS: &str = r#"#version 300 es
precision highp float;
in vec4 v_color;
in float v_dist;
in float v_half;
out vec4 o;
void main() {
  // Coverage of this pixel: 1 inside, 0.5 on the edge, 0 half a pixel out.
  float cov = clamp(v_half - abs(v_dist) + 0.5, 0.0, 1.0);
  // Hairlines thinner than a pixel fade instead of breaking up.
  cov *= clamp(v_half * 2.0, 0.0, 1.0);
  float a = v_color.a * cov;
  if (a <= 0.002) discard;
  // Used by the translucent pass: keep the best coverage per pixel.
  gl_FragDepth = 1.0 - cov;
  o = vec4(v_color.rgb * a, a);
}"#;

const PAPER_VS: &str = r#"#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}"#;

// World position = offset + css / zoom. `u_offset` is pre-reduced modulo the
// pattern spacing on the CPU (f64) so this stays precise anywhere on the canvas.
const PAPER_FS: &str = r#"#version 300 es
precision highp float;
uniform vec2 u_offset;
uniform float u_zoom;
uniform float u_spacing;
uniform float u_dpr;
uniform float u_height;
uniform int u_mode;
uniform vec3 u_bg;
uniform vec4 u_ink;
out vec4 o;
void main() {
  vec2 css = vec2(gl_FragCoord.x, u_height - gl_FragCoord.y) / u_dpr;
  vec2 world = u_offset + css / u_zoom;
  vec2 cell = (fract(world / u_spacing + 0.5) - 0.5) * u_spacing * u_zoom; // css px to nearest grid point
  float a = 0.0;
  if (u_mode == 1) {
    a = 1.0 - smoothstep(0.9, 1.6, length(cell));
  } else if (u_mode == 2) {
    float d = min(abs(cell.x), abs(cell.y));
    a = (1.0 - smoothstep(0.3, 0.9, d)) * 0.6;
  } else if (u_mode == 3) {
    a = (1.0 - smoothstep(0.3, 0.9, abs(cell.y))) * 0.6;
  }
  vec3 c = mix(u_bg, u_ink.rgb, a * u_ink.a);
  o = vec4(c, 1.0);
}"#;

fn compile(gl: &GL, kind: u32, src: &str) -> Result<web_sys::WebGlShader, String> {
    let s = gl.create_shader(kind).ok_or("create_shader failed")?;
    gl.shader_source(&s, src);
    gl.compile_shader(&s);
    if gl.get_shader_parameter(&s, GL::COMPILE_STATUS).as_bool().unwrap_or(false) {
        Ok(s)
    } else {
        Err(gl.get_shader_info_log(&s).unwrap_or_default())
    }
}

fn link(gl: &GL, vs: &str, fs: &str) -> Result<WebGlProgram, String> {
    let p = gl.create_program().ok_or("create_program failed")?;
    gl.attach_shader(&p, &compile(gl, GL::VERTEX_SHADER, vs)?);
    gl.attach_shader(&p, &compile(gl, GL::FRAGMENT_SHADER, fs)?);
    gl.link_program(&p);
    if gl.get_program_parameter(&p, GL::LINK_STATUS).as_bool().unwrap_or(false) {
        Ok(p)
    } else {
        Err(gl.get_program_info_log(&p).unwrap_or_default())
    }
}

fn f32_bytes(v: &[f32]) -> &[u8] {
    // SAFETY: f32 has no invalid bit patterns; wasm32 is little-endian, as WebGL expects.
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
}
fn u32_bytes(v: &[u32]) -> &[u8] {
    // SAFETY: as above.
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
}

fn i8_bytes(v: &[i8]) -> &[u8] {
    // SAFETY: i8 and u8 have the same size and alignment.
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len()) }
}

struct GpuMesh {
    vao: WebGlVertexArrayObject,
    buffers: [WebGlBuffer; 5],
    bounds: bedrock_core::geom::Rect,
    count: i32,
    origin: Vec2,
}

struct InkProgram {
    program: WebGlProgram,
    u_scale: Option<WebGlUniformLocation>,
    u_offset: Option<WebGlUniformLocation>,
    u_px: Option<WebGlUniformLocation>,
}

/// Paper shader, its uniforms by name, and an empty VAO for the fullscreen triangle.
type PaperProgram = (WebGlProgram, HashMap<&'static str, Option<WebGlUniformLocation>>, WebGlVertexArrayObject);

/// One WebGL2 canvas (the base scene, or the live-stroke overlay).
pub struct Layer {
    pub canvas: HtmlCanvasElement,
    gl: GL,
    ink: InkProgram,
    paper: Option<PaperProgram>,
    chunks: HashMap<u64, GpuMesh>,
    live: Option<GpuMesh>,
    stencil_ref: i32,
    width_px: u32,
    height_px: u32,
}

pub fn context(canvas: &HtmlCanvasElement, opaque: bool) -> Result<GL, JsValue> {
    let opts = js_sys::Object::new();
    let set = |k: &str, v: bool| js_sys::Reflect::set(&opts, &k.into(), &v.into());
    // Edges are antialiased in the shader, so every device looks the same and
    // no MSAA memory is spent (iOS Safari often ignores it anyway).
    set("antialias", false)?;
    set("stencil", true)?;
    set("depth", true)?;
    set("alpha", !opaque)?;
    set("premultipliedAlpha", true)?;
    set("preserveDrawingBuffer", false)?;
    // Low-latency hint: lets the browser skip compositor queuing (Chromium).
    set("desynchronized", true)?;
    js_sys::Reflect::set(&opts, &"powerPreference".into(), &"high-performance".into())?;
    let ctx = canvas
        .get_context_with_context_options("webgl2", &opts)?
        .ok_or_else(|| JsValue::from_str("WebGL2 is not available in this browser"))?;
    ctx.dyn_into::<GL>().map_err(|_| JsValue::from_str("not a WebGL2 context"))
}

impl Layer {
    pub fn new(canvas: HtmlCanvasElement, with_paper: bool) -> Result<Layer, JsValue> {
        let gl = context(&canvas, with_paper)?;
        let program = link(&gl, INK_VS, INK_FS).map_err(|e| JsValue::from_str(&e))?;
        let ink = InkProgram {
            u_scale: gl.get_uniform_location(&program, "u_scale"),
            u_offset: gl.get_uniform_location(&program, "u_offset"),
            u_px: gl.get_uniform_location(&program, "u_px"),
            program,
        };
        let paper = if with_paper {
            let p = link(&gl, PAPER_VS, PAPER_FS).map_err(|e| JsValue::from_str(&e))?;
            let mut u = HashMap::new();
            for name in ["u_offset", "u_zoom", "u_spacing", "u_dpr", "u_height", "u_mode", "u_bg", "u_ink"] {
                u.insert(name, gl.get_uniform_location(&p, name));
            }
            let vao = gl.create_vertex_array().ok_or("vao")?;
            Some((p, u, vao))
        } else {
            None
        };
        Ok(Layer {
            canvas,
            gl,
            ink,
            paper,
            chunks: HashMap::new(),
            live: None,
            stencil_ref: 0,
            width_px: 1,
            height_px: 1,
        })
    }

    pub fn is_lost(&self) -> bool {
        self.gl.is_context_lost()
    }

    pub fn resize(&mut self, css_w: f64, css_h: f64, dpr: f64) {
        self.width_px = (css_w * dpr).round().max(1.0) as u32;
        self.height_px = (css_h * dpr).round().max(1.0) as u32;
        self.canvas.set_width(self.width_px);
        self.canvas.set_height(self.height_px);
    }

    fn upload(&self, mesh: &ChunkMesh, usage: u32, reuse: Option<GpuMesh>) -> Option<GpuMesh> {
        let gl = &self.gl;
        let mut bounds = bedrock_core::geom::Rect::EMPTY;
        for p in mesh.positions.chunks(2) {
            bounds.include(Vec2::new(p[0] as f64 + mesh.origin.x, p[1] as f64 + mesh.origin.y));
        }
        let m = match reuse {
            Some(m) => m,
            None => {
                let vao = gl.create_vertex_array()?;
                let buffers = [
                    gl.create_buffer()?,
                    gl.create_buffer()?,
                    gl.create_buffer()?,
                    gl.create_buffer()?,
                    gl.create_buffer()?,
                ];
                gl.bind_vertex_array(Some(&vao));
                gl.bind_buffer(GL::ARRAY_BUFFER, Some(&buffers[0]));
                gl.enable_vertex_attrib_array(0);
                gl.vertex_attrib_pointer_with_i32(0, 2, GL::FLOAT, false, 0, 0);
                gl.bind_buffer(GL::ARRAY_BUFFER, Some(&buffers[1]));
                gl.enable_vertex_attrib_array(1);
                gl.vertex_attrib_pointer_with_i32(1, 4, GL::UNSIGNED_BYTE, true, 0, 0);
                gl.bind_buffer(GL::ARRAY_BUFFER, Some(&buffers[2]));
                gl.enable_vertex_attrib_array(2);
                gl.vertex_attrib_pointer_with_i32(2, 4, GL::BYTE, true, 0, 0);
                gl.bind_buffer(GL::ARRAY_BUFFER, Some(&buffers[3]));
                gl.enable_vertex_attrib_array(3);
                gl.vertex_attrib_pointer_with_i32(3, 1, GL::FLOAT, false, 0, 0);
                gl.bind_buffer(GL::ELEMENT_ARRAY_BUFFER, Some(&buffers[4]));
                gl.bind_vertex_array(None);
                GpuMesh { vao, buffers, bounds: bedrock_core::geom::Rect::EMPTY, count: 0, origin: Vec2::ZERO }
            }
        };
        gl.bind_vertex_array(Some(&m.vao));
        gl.bind_buffer(GL::ARRAY_BUFFER, Some(&m.buffers[0]));
        gl.buffer_data_with_u8_array(GL::ARRAY_BUFFER, f32_bytes(&mesh.positions), usage);
        gl.bind_buffer(GL::ARRAY_BUFFER, Some(&m.buffers[1]));
        gl.buffer_data_with_u8_array(GL::ARRAY_BUFFER, &mesh.colors, usage);
        gl.bind_buffer(GL::ARRAY_BUFFER, Some(&m.buffers[2]));
        gl.buffer_data_with_u8_array(GL::ARRAY_BUFFER, i8_bytes(&mesh.edges), usage);
        gl.bind_buffer(GL::ARRAY_BUFFER, Some(&m.buffers[3]));
        gl.buffer_data_with_u8_array(GL::ARRAY_BUFFER, f32_bytes(&mesh.half_widths), usage);
        gl.buffer_data_with_u8_array(GL::ELEMENT_ARRAY_BUFFER, u32_bytes(&mesh.indices), usage);
        gl.bind_vertex_array(None);
        Some(GpuMesh { count: mesh.indices.len() as i32, origin: mesh.origin, bounds, ..m })
    }

    fn free(&self, m: GpuMesh) {
        for b in &m.buffers {
            self.gl.delete_buffer(Some(b));
        }
        self.gl.delete_vertex_array(Some(&m.vao));
    }

    pub fn add_chunk(&mut self, info: &ChunkInfo, mesh: &ChunkMesh) {
        if let Some(m) = self.upload(mesh, GL::STATIC_DRAW, None) {
            if let Some(old) = self.chunks.insert(info.key, m) {
                self.free(old);
            }
        }
    }

    pub fn remove_chunk(&mut self, key: u64) {
        if let Some(m) = self.chunks.remove(&key) {
            self.free(m);
        }
    }

    fn set_viewport(&self) {
        self.gl.viewport(0, 0, self.width_px as i32, self.height_px as i32);
    }

    fn begin_ink(&self) {
        let gl = &self.gl;
        gl.use_program(Some(&self.ink.program));
        gl.enable(GL::BLEND);
        gl.blend_func(GL::ONE, GL::ONE_MINUS_SRC_ALPHA);
    }

    fn draw_mesh(&mut self, m_key: Option<u64>, cam: &Camera, dpr: f64, translucent: bool) {
        let gl = &self.gl;
        let m = match m_key {
            Some(k) => self.chunks.get(&k),
            None => self.live.as_ref(),
        };
        let Some(m) = m else { return };
        if m.count == 0 {
            return;
        }
        let (w, h) = (cam.viewport.x, cam.viewport.y);
        let z = cam.zoom;
        gl.uniform2f(self.ink.u_scale.as_ref(), (2.0 * z / w) as f32, (-2.0 * z / h) as f32);
        gl.uniform2f(
            self.ink.u_offset.as_ref(),
            ((m.origin.x - cam.offset.x) * z * 2.0 / w - 1.0) as f32,
            (1.0 - (m.origin.y - cam.offset.y) * z * 2.0 / h) as f32,
        );
        gl.uniform1f(self.ink.u_px.as_ref(), (1.0 / (z * dpr)) as f32);
        gl.bind_vertex_array(Some(&m.vao));
        if translucent {
            // A translucent stroke must blend exactly once per pixel, with the
            // best (antialiased) coverage any of its triangles has there:
            // 1) depth-only pass keeps max coverage (depth = 1 - coverage),
            // 2) colour pass draws only that fragment, once (stencil).
            let b = m.bounds.inflate(2.0 * z.recip());
            let s0 = cam.world_to_screen(b.min);
            let s1 = cam.world_to_screen(b.max);
            let sx = ((s0.x * dpr).floor().max(0.0)) as i32;
            let sy = (((h - s1.y) * dpr).floor().max(0.0)) as i32;
            let sw = (((s1.x - s0.x) * dpr).ceil() + 2.0) as i32;
            let sh = (((s1.y - s0.y) * dpr).ceil() + 2.0) as i32;
            gl.enable(GL::SCISSOR_TEST);
            gl.scissor(sx, sy, sw.max(1), sh.max(1));
            gl.clear_depth(1.0);
            gl.clear(GL::DEPTH_BUFFER_BIT);
            gl.enable(GL::DEPTH_TEST);
            gl.depth_mask(true);
            gl.depth_func(GL::LESS);
            gl.color_mask(false, false, false, false);
            gl.disable(GL::STENCIL_TEST);
            gl.draw_elements_with_i32(GL::TRIANGLES, m.count, GL::UNSIGNED_INT, 0);

            self.stencil_ref += 1;
            if self.stencil_ref > 255 {
                gl.clear_stencil(0);
                gl.clear(GL::STENCIL_BUFFER_BIT);
                self.stencil_ref = 1;
            }
            gl.color_mask(true, true, true, true);
            gl.depth_mask(false);
            gl.depth_func(GL::EQUAL);
            gl.enable(GL::STENCIL_TEST);
            gl.stencil_func(GL::NOTEQUAL, self.stencil_ref, 0xff);
            gl.stencil_op(GL::KEEP, GL::KEEP, GL::REPLACE);
            gl.draw_elements_with_i32(GL::TRIANGLES, m.count, GL::UNSIGNED_INT, 0);
            gl.disable(GL::DEPTH_TEST);
            gl.disable(GL::STENCIL_TEST);
            gl.disable(GL::SCISSOR_TEST);
        } else {
            gl.disable(GL::STENCIL_TEST);
            gl.disable(GL::DEPTH_TEST);
            gl.draw_elements_with_i32(GL::TRIANGLES, m.count, GL::UNSIGNED_INT, 0);
        }
        gl.bind_vertex_array(None);
    }

    fn clear(&mut self, color: [f32; 4]) {
        let gl = &self.gl;
        gl.disable(GL::STENCIL_TEST);
        gl.clear_color(color[0], color[1], color[2], color[3]);
        gl.clear_stencil(0);
        gl.clear_depth(1.0);
        gl.disable(GL::SCISSOR_TEST);
        gl.clear(GL::COLOR_BUFFER_BIT | GL::STENCIL_BUFFER_BIT | GL::DEPTH_BUFFER_BIT);
        self.stencil_ref = 0;
    }

    fn draw_paper(&self, cam: &Camera, dpr: f64, bg: Rgba, mode: i32) {
        let Some((p, u, vao)) = &self.paper else { return };
        let gl = &self.gl;
        gl.disable(GL::BLEND);
        gl.disable(GL::STENCIL_TEST);
        gl.use_program(Some(p));
        // Keep the pattern 16-64 css px apart at any zoom.
        let mut spacing = 32.0f64;
        while spacing * cam.zoom < 16.0 {
            spacing *= 2.0;
        }
        while spacing * cam.zoom > 64.0 && spacing > 1e-6 {
            spacing /= 2.0;
        }
        let off = Vec2::new(cam.offset.x.rem_euclid(spacing), cam.offset.y.rem_euclid(spacing));
        let g = |n: &str| u.get(n).and_then(|x| x.as_ref());
        gl.uniform2f(g("u_offset"), off.x as f32, off.y as f32);
        gl.uniform1f(g("u_zoom"), cam.zoom as f32);
        gl.uniform1f(g("u_spacing"), spacing as f32);
        gl.uniform1f(g("u_dpr"), dpr as f32);
        gl.uniform1f(g("u_height"), self.height_px as f32);
        gl.uniform1i(g("u_mode"), mode);
        gl.uniform3f(g("u_bg"), bg.r as f32 / 255.0, bg.g as f32 / 255.0, bg.b as f32 / 255.0);
        gl.uniform4f(g("u_ink"), 0.55, 0.55, 0.6, 0.55);
        gl.bind_vertex_array(Some(vao));
        gl.draw_arrays(GL::TRIANGLES, 0, 3);
        gl.bind_vertex_array(None);
    }

    /// Full scene: paper + every visible chunk in order.
    pub fn render_scene<'a>(
        &mut self,
        cam: &Camera,
        dpr: f64,
        bg: Rgba,
        paper_mode: i32,
        visible: impl Iterator<Item = &'a ChunkInfo>,
    ) {
        self.set_viewport();
        self.clear([bg.r as f32 / 255.0, bg.g as f32 / 255.0, bg.b as f32 / 255.0, 1.0]);
        self.draw_paper(cam, dpr, bg, paper_mode);
        self.begin_ink();
        for c in visible {
            self.draw_mesh(Some(c.key), cam, dpr, c.translucent);
        }
        self.gl.disable(GL::STENCIL_TEST);
    }

    /// Overlay: transparent, with just the live stroke.
    pub fn render_live(&mut self, cam: &Camera, dpr: f64, mesh: Option<(&ChunkMesh, bool)>) {
        self.set_viewport();
        self.clear([0.0, 0.0, 0.0, 0.0]);
        let Some((mesh, translucent)) = mesh else { return };
        let reuse = self.live.take();
        self.live = self.upload(mesh, GL::DYNAMIC_DRAW, reuse);
        self.begin_ink();
        self.draw_mesh(None, cam, dpr, translucent);
        self.gl.disable(GL::STENCIL_TEST);
    }

    /// Read one device pixel (RGBA). Must run right after rendering.
    pub fn read_pixel(&self, x_px: i32, y_px: i32) -> Vec<u8> {
        let mut out = vec![0u8; 4];
        let y = self.height_px as i32 - 1 - y_px;
        let _ = self.gl.read_pixels_with_opt_u8_array(x_px, y, 1, 1, GL::RGBA, GL::UNSIGNED_BYTE, Some(&mut out));
        out
    }
}
