//! Handwriting from PDF files: GoodNotes exports and similar.
//!
//! Note apps export ink as vector paths, one path per pen stroke, in the
//! order it was written. GoodNotes draws each stroke as a filled outline
//! made of short pieces (one closed subpath per piece, out along one edge
//! and back along the other); other apps stroke the centre line instead.
//! Both become Bedrock strokes here: the centre line is the outward half of
//! each piece (the pen is thin next to the letters, so its edge is close
//! enough), and the width is the piece's area over its length.
//!
//! A PDF keeps no timing or pressure. Strokes get times as if written at an
//! even speed, in their order on the page, and a middle pressure. The
//! handwriting reader only uses shapes and order, so that is enough.
//!
//! GoodNotes also hides its own reading of the handwriting in the page as
//! invisible text. Each piece of it is matched to the word under it and kept
//! as that word's recognised text (engine [`ENGINE`]).
//!
//! Pictures come across where they sit on the page: JPEGs as they are, and
//! raw pixels (any bit depth, grey, RGB, CMYK or palette, with a soft mask
//! as transparency) as PNG files.
//!
//! The file itself is read by the `hayro-syntax` crate: its objects, the
//! page tree, and streams with their filters (Flate, LZW, ASCII85 and the
//! rest, with predictors). What is here is what Bedrock adds: form XObjects,
//! pictures, colours, transparency and text positions are followed to find
//! the ink. Visible text and inline images are left out and reported. PNG
//! files are written by the `png` crate.

use std::collections::HashMap;
use std::io::Read;

use hayro_syntax::content::UntypedIter;
use hayro_syntax::object::{Dict, Name, Object, Stream};
use hayro_syntax::page::Resources;
use hayro_syntax::{Filter, LoadPdfError, Pdf};

use crate::brush::{Brush, BrushKind};
use crate::color::Rgba;
use crate::document::{Document, Image, RecognizedText};
use crate::geom::{Rect, Vec2};
use crate::input::InputPoint;
use crate::stroke::{InputDevice, Stroke};
use crate::words;

/// Engine name for readings taken from a PDF's text layer.
pub const ENGINE: &str = "pdf-text";
/// Assumed writing speed, page units (points) per millisecond.
const SPEED: f64 = 0.1;
/// Assumed pause between strokes, milliseconds.
const GAP_MS: f64 = 150.0;
/// A filled piece wider than this is a shape, not ink (points).
const MAX_INK_WIDTH: f64 = 40.0;
/// World units per input pixel given to imported strokes (see
/// [`Stroke::input_scale`]).
const INPUT_SCALE: f64 = 0.05;
/// Straight pieces each curve in a path is drawn with.
const CURVE_STEPS: usize = 6;
const MAX_STREAM: usize = 128 * 1024 * 1024;
const MAX_DEPTH: usize = 12;

/// One imported page.
#[derive(Debug)]
pub struct PdfPage {
    pub doc: Document,
    /// Readings from the text layer that were attached to words.
    pub readings: usize,
    /// What was left out, in plain words.
    pub warnings: Vec<String>,
}

/// True if `bytes` look like a PDF file.
pub fn is_pdf(bytes: &[u8]) -> bool {
    bytes.len() > 8 && bytes[..bytes.len().min(1024)].windows(5).any(|w| w == b"%PDF-")
}

/// Every page with ink as a note. `start_ms` is the time given to the first
/// stroke (Unix ms); `seed` makes the stroke ids (see [`Document::new`]).
pub fn import(bytes: &[u8], seed: u64, start_ms: f64) -> Result<Vec<PdfPage>, String> {
    if !is_pdf(bytes) {
        return Err("not a PDF file".into());
    }
    let pdf = Pdf::new(bytes.to_vec()).map_err(|e| match e {
        LoadPdfError::Decryption(_) => "this PDF is locked with a password".to_string(),
        LoadPdfError::Invalid => "no pages found in this PDF".to_string(),
    })?;
    let pages = pdf.pages();
    if pages.is_empty() {
        return Err("no pages found in this PDF".into());
    }
    let mut out = Vec::new();
    let mut t = start_ms;
    let mut pictures = Pictures::new();
    for (i, page) in pages.iter().enumerate() {
        let mut ink = Ink::default();
        run(&page_content(page.raw()), page.resources(), IDENTITY, &mut ink, 0);
        let seed = seed.wrapping_add((i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let mut p = build_page(&ink, media_box(page.raw()), seed, &mut t, &mut pictures);
        if !p.doc.is_empty() || !p.doc.images().is_empty() {
            p.doc.created = start_ms;
            p.doc.modified = start_ms;
            out.push(p);
        }
    }
    Ok(out)
}

/// The page's media box: its own, or the nearest one up the page tree, or
/// US Letter. Read here in full precision, so ink lands where it always has.
fn media_box(page: &Dict<'_>) -> Rect {
    let mut node = page.clone();
    for _ in 0..64 {
        if let Some(v) = node.get::<[f64; 4]>("MediaBox") {
            return Rect::new(Vec2::new(v[0].min(v[2]), v[1].min(v[3])), Vec2::new(v[0].max(v[2]), v[1].max(v[3])));
        }
        match node.get::<Dict<'_>>("Parent") {
            Some(parent) => node = parent,
            None => break,
        }
    }
    Rect::new(Vec2::ZERO, Vec2::new(612.0, 792.0))
}

// ---- Content streams ----------------------------------------------------------

type Matrix = [f64; 6];
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn mul(m: &Matrix, n: &Matrix) -> Matrix {
    [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ]
}
fn apply(m: &Matrix, x: f64, y: f64) -> Vec2 {
    Vec2::new(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

/// A filled or stroked path, in page space (PDF units, y up).
#[derive(Debug, Clone)]
struct InkPath {
    pieces: Vec<Vec<Vec2>>,
    color: [f64; 3],
    alpha: f64,
    /// Line width for a stroked path; None for a filled outline.
    line: Option<f64>,
}

#[derive(Debug, Clone)]
struct Span {
    at: Vec2,
    size: f64,
    text: String,
    invisible: bool,
}

#[derive(Default)]
struct Ink<'a> {
    paths: Vec<InkPath>,
    spans: Vec<Span>,
    /// Pictures drawn, each with the matrix that places it.
    pictures: Vec<(Stream<'a>, Matrix)>,
    /// Pictures that cannot be brought in (inline images).
    skipped_pictures: usize,
}

#[derive(Clone)]
struct GState {
    ctm: Matrix,
    fill: [f64; 3],
    stroke: [f64; 3],
    fill_alpha: f64,
    stroke_alpha: f64,
    line_width: f64,
}

fn color_of(args: &[f64]) -> Option<[f64; 3]> {
    match args.len() {
        1 => Some([args[0]; 3]),
        3 => Some([args[0], args[1], args[2]]),
        4 => {
            let k = 1.0 - args[3];
            Some([(1.0 - args[0]) * k, (1.0 - args[1]) * k, (1.0 - args[2]) * k])
        }
        _ => None,
    }
}

fn run<'a>(content: &[u8], res: &Resources<'a>, ctm: Matrix, ink: &mut Ink<'a>, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    let mut gs = GState { ctm, fill: [0.0; 3], stroke: [0.0; 3], fill_alpha: 1.0, stroke_alpha: 1.0, line_width: 1.0 };
    let mut stack: Vec<GState> = Vec::new();
    let mut path: Vec<Vec<Vec2>> = Vec::new();
    let mut has_rect = false;
    let mut cur = Vec2::ZERO;
    // Text state.
    let (mut tm, mut tlm) = (IDENTITY, IDENTITY);
    let (mut size, mut leading, mut mode) = (1.0, 0.0, 0.0);
    let mut ops = UntypedIter::new(content);
    let mut n: Vec<f64> = Vec::new();
    while let Some(ins) = ops.next() {
        n.clear();
        n.extend(ins.operands().filter_map(|a| match a {
            Object::Number(v) => Some(v.as_f64()),
            _ => None,
        }));
        let last = |k: usize| -> Option<&[f64]> { (n.len() >= k).then(|| &n[n.len() - k..]) };
        let name = || match ins.operands().last() {
            Some(Object::Name(name)) => Some(name),
            _ => None,
        };
        let op = std::str::from_utf8(ins.operator).unwrap_or("");
        match op {
            "q" => stack.push(gs.clone()),
            "Q" => {
                if let Some(s) = stack.pop() {
                    gs = s;
                }
            }
            "cm" => {
                if let Some(m) = last(6) {
                    gs.ctm = mul(&[m[0], m[1], m[2], m[3], m[4], m[5]], &gs.ctm);
                }
            }
            "w" => {
                if let Some(v) = last(1) {
                    gs.line_width = v[0];
                }
            }
            "g" | "rg" | "k" | "sc" | "scn" => {
                if let Some(c) = color_of(&n) {
                    gs.fill = c;
                }
            }
            "G" | "RG" | "K" | "SC" | "SCN" => {
                if let Some(c) = color_of(&n) {
                    gs.stroke = c;
                }
            }
            "cs" => gs.fill = [0.0; 3],
            "CS" => gs.stroke = [0.0; 3],
            "gs" => {
                if let Some(d) = name().and_then(|name| res.get_ext_g_state(name)) {
                    if let Some(a) = d.get::<f64>("ca") {
                        gs.fill_alpha = a;
                    }
                    if let Some(a) = d.get::<f64>("CA") {
                        gs.stroke_alpha = a;
                    }
                    if let Some(w) = d.get::<f64>("LW") {
                        gs.line_width = w;
                    }
                }
            }
            "m" => {
                if let Some(p) = last(2) {
                    cur = apply(&gs.ctm, p[0], p[1]);
                    path.push(vec![cur]);
                }
            }
            "l" => {
                if let (Some(p), Some(sub)) = (last(2), path.last_mut()) {
                    cur = apply(&gs.ctm, p[0], p[1]);
                    sub.push(cur);
                }
            }
            "c" | "v" | "y" => {
                let need = if op == "c" { 6 } else { 4 };
                if let (Some(p), Some(sub)) = (last(need), path.last_mut()) {
                    let pts: Vec<Vec2> = p.chunks(2).map(|c| apply(&gs.ctm, c[0], c[1])).collect();
                    let (c1, c2, end) = match op {
                        "c" => (pts[0], pts[1], pts[2]),
                        "v" => (cur, pts[0], pts[1]),
                        _ => (pts[0], pts[1], pts[1]),
                    };
                    // Points along the curve: enough to follow a pen
                    // stroke's outline around a bend.
                    for k in 1..=CURVE_STEPS {
                        let t = k as f64 / CURVE_STEPS as f64;
                        let u = 1.0 - t;
                        sub.push(
                            cur * (u * u * u) + c1 * (3.0 * u * u * t) + c2 * (3.0 * u * t * t) + end * (t * t * t),
                        );
                    }
                    cur = end;
                }
            }
            "re" => {
                has_rect = true;
                path.push(Vec::new());
            }
            "h" => {}
            "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" => {
                if !has_rect && !path.is_empty() {
                    ink.paths.push(InkPath {
                        pieces: std::mem::take(&mut path),
                        color: gs.fill,
                        alpha: gs.fill_alpha,
                        line: None,
                    });
                }
                path.clear();
                has_rect = false;
            }
            "S" | "s" => {
                if !has_rect && !path.is_empty() {
                    let scale = (gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2]).abs().sqrt();
                    ink.paths.push(InkPath {
                        pieces: std::mem::take(&mut path),
                        color: gs.stroke,
                        alpha: gs.stroke_alpha,
                        line: Some((gs.line_width * scale).max(0.1)),
                    });
                }
                path.clear();
                has_rect = false;
            }
            "n" => {
                path.clear();
                has_rect = false;
            }
            "BT" => {
                tm = IDENTITY;
                tlm = IDENTITY;
            }
            "Tf" => {
                if let Some(v) = last(1) {
                    size = v[0];
                }
            }
            "Tr" => {
                if let Some(v) = last(1) {
                    mode = v[0];
                }
            }
            "TL" => {
                if let Some(v) = last(1) {
                    leading = v[0];
                }
            }
            "Tm" => {
                if let Some(m) = last(6) {
                    tm = [m[0], m[1], m[2], m[3], m[4], m[5]];
                    tlm = tm;
                }
            }
            "Td" | "TD" => {
                if let Some(v) = last(2) {
                    if op == "TD" {
                        leading = -v[1];
                    }
                    tlm = mul(&[1.0, 0.0, 0.0, 1.0, v[0], v[1]], &tlm);
                    tm = tlm;
                }
            }
            "T*" => {
                tlm = mul(&[1.0, 0.0, 0.0, 1.0, 0.0, -leading], &tlm);
                tm = tlm;
            }
            "Tj" | "TJ" | "'" | "\"" => {
                if op == "'" || op == "\"" {
                    tlm = mul(&[1.0, 0.0, 0.0, 1.0, 0.0, -leading], &tlm);
                    tm = tlm;
                }
                let mut bytes = Vec::new();
                for a in ins.operands() {
                    match a {
                        Object::String(s) => bytes.extend_from_slice(s.as_bytes()),
                        Object::Array(items) => {
                            for i in items.iter::<Object<'_>>() {
                                if let Object::String(s) = i {
                                    bytes.extend_from_slice(s.as_bytes());
                                }
                            }
                        }
                        _ => {}
                    }
                }
                let text: String =
                    bytes.iter().filter(|b| b.is_ascii_graphic() || **b == b' ').map(|&b| b as char).collect();
                let m = mul(&tm, &gs.ctm);
                let h = (m[2] * m[2] + m[3] * m[3]).sqrt() * size.abs();
                if !text.trim().is_empty() {
                    ink.spans.push(Span {
                        at: apply(&m, 0.0, 0.0),
                        size: h,
                        text: text.trim().to_string(),
                        invisible: mode == 3.0 || mode == 7.0,
                    });
                }
            }
            "Do" => {
                if let Some(xo) = name().and_then(|name| res.get_x_object(name)) {
                    let d = xo.dict();
                    let subtype = d.get::<Name<'_>>("Subtype");
                    match subtype.as_ref().map(|s| s.as_str()) {
                        Some("Form") => {
                            let m = d.get::<[f64; 6]>("Matrix").unwrap_or(IDENTITY);
                            let sub_res =
                                d.get::<Dict<'_>>("Resources").map(Resources::new).unwrap_or_else(|| res.clone());
                            if let Some(data) = unpack(&xo) {
                                run(&data, &sub_res, mul(&m, &gs.ctm), ink, depth + 1);
                            }
                        }
                        Some("Image") => ink.pictures.push((xo, gs.ctm)),
                        _ => {}
                    }
                }
            }
            // An inline image: the reader has already stepped over its data.
            "BI" => ink.skipped_pictures += 1,
            _ => {}
        }
    }
}

/// The page's content streams, unpacked and joined.
fn page_content(page: &Dict<'_>) -> Vec<u8> {
    let streams = match page.get::<Object<'_>>("Contents") {
        Some(Object::Stream(s)) => vec![s],
        Some(Object::Array(a)) => a.iter::<Stream<'_>>().collect(),
        _ => Vec::new(),
    };
    let mut out = Vec::new();
    for s in streams {
        if let Some(data) = unpack(&s) {
            if out.len() + data.len() > MAX_STREAM {
                break;
            }
            out.extend_from_slice(&data);
            out.push(b'\n');
        }
    }
    out
}

/// A stream's data with its filters undone, or None if a filter is not
/// supported or the data would unpack to more than [`MAX_STREAM`] bytes.
/// `hayro-syntax` sets no limit of its own, so a small crafted file could
/// otherwise fill the memory.
fn unpack<'a>(s: &Stream<'a>) -> Option<std::borrow::Cow<'a, [u8]>> {
    if !unpacks_small(&s.raw_data(), &s.filters()) {
        return None;
    }
    s.decoded_data().ok().filter(|d| d.len() <= MAX_STREAM)
}

/// True if `raw`, run through `filters`, cannot come to more than
/// [`MAX_STREAM`] bytes. A first Flate filter is measured without keeping
/// what it unpacks; later ones are judged by the most any filter can grow
/// data (predictors and the text filters only shrink it).
fn unpacks_small(raw: &[u8], filters: &[Filter]) -> bool {
    let mut most = raw.len() as u128;
    for (i, f) in filters.iter().enumerate() {
        most = match f {
            Filter::FlateDecode if i == 0 => inflated_len(raw).map_or(most * 1032, |n| n as u128),
            Filter::FlateDecode => most * 1032,
            Filter::LzwDecode => most * 2731,
            Filter::RunLengthDecode => most * 128,
            _ => most,
        };
    }
    most <= MAX_STREAM as u128
}

/// How long zlib (or raw Deflate) data is once unpacked, counting no further
/// than [`MAX_STREAM`] + 1. None if neither can be read at all.
fn inflated_len(raw: &[u8]) -> Option<usize> {
    fn count(mut r: impl Read) -> Option<usize> {
        let mut buf = [0u8; 16 * 1024];
        let mut n = 0;
        while n <= MAX_STREAM {
            match r.read(&mut buf) {
                Ok(0) => return Some(n),
                Ok(k) => n += k,
                Err(_) if n > 0 => return Some(n),
                Err(_) => return None,
            }
        }
        Some(n)
    }
    count(flate2::read::ZlibDecoder::new(raw)).or_else(|| count(flate2::read::DeflateDecoder::new(raw)))
}

// ---- Pictures -----------------------------------------------------------------

/// Pictures already made, by object and mirroring, so one drawn on every
/// page (a paper template, say) is decoded once: its file name and bytes.
type Pictures = HashMap<(u32, (bool, bool)), Option<(String, Vec<u8>)>>;

/// Largest picture brought in, in pixels.
const MAX_PIXELS: usize = 16_777_216;

/// A picture's colour space.
#[derive(Debug, Clone)]
enum Space {
    Gray,
    Rgb,
    Cmyk,
    /// A palette: `base` colours, `table` holding one entry per index.
    Indexed(Box<Space>, Vec<u8>),
}

impl Space {
    fn of(o: &Object<'_>, depth: usize) -> Option<Space> {
        if depth > 4 {
            return None;
        }
        let by_count = |n: f64| match n as usize {
            1 => Some(Space::Gray),
            3 => Some(Space::Rgb),
            4 => Some(Space::Cmyk),
            _ => None,
        };
        match o {
            Object::Name(n) => match n.as_str() {
                "DeviceGray" | "G" | "CalGray" => Some(Space::Gray),
                "DeviceRGB" | "RGB" | "CalRGB" => Some(Space::Rgb),
                "DeviceCMYK" | "CMYK" => Some(Space::Cmyk),
                _ => None,
            },
            Object::Array(a) => {
                let items: Vec<Object<'_>> = a.iter::<Object<'_>>().collect();
                let Object::Name(kind) = items.first()? else { return None };
                match kind.as_str() {
                    "ICCBased" => {
                        let d = match items.get(1)? {
                            Object::Stream(s) => s.dict().clone(),
                            Object::Dict(d) => d.clone(),
                            _ => return None,
                        };
                        match d.get::<f64>("N") {
                            Some(n) => by_count(n),
                            None => Space::of(&d.get::<Object<'_>>("Alternate")?, depth + 1),
                        }
                    }
                    "CalRGB" => Some(Space::Rgb),
                    "CalGray" => Some(Space::Gray),
                    "Indexed" | "I" => {
                        let base = Space::of(items.get(1)?, depth + 1)?;
                        if matches!(base, Space::Indexed(..)) {
                            return None;
                        }
                        let table = match items.get(3)? {
                            Object::Stream(s) => unpack(s)?.into_owned(),
                            Object::String(b) => b.as_bytes().to_vec(),
                            _ => return None,
                        };
                        Some(Space::Indexed(Box::new(base), table))
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    }

    fn components(&self) -> usize {
        match self {
            Space::Gray | Space::Indexed(..) => 1,
            Space::Rgb => 3,
            Space::Cmyk => 4,
        }
    }
}

/// Grey or RGB bytes for one pixel's colour values (0 to 1 each).
fn to_pixel(space: &Space, v: &[f64], out: &mut Vec<u8>) {
    let b = |x: f64| (x.clamp(0.0, 1.0) * 255.0).round() as u8;
    match space {
        Space::Gray => out.push(b(v[0])),
        Space::Rgb => out.extend([b(v[0]), b(v[1]), b(v[2])]),
        Space::Cmyk => {
            let c = color_of(v).unwrap_or([0.0; 3]);
            out.extend([b(c[0]), b(c[1]), b(c[2])]);
        }
        Space::Indexed(..) => {}
    }
}

/// The picture's samples as 8 bit grey (1 channel) or RGB (3 channels).
fn pixels(s: &Stream<'_>) -> Option<(usize, usize, usize, Vec<u8>)> {
    let d = s.dict();
    let num = |k: &str| d.get::<f64>(k);
    let (w, h) = (num("Width")? as usize, num("Height")? as usize);
    if w == 0 || h == 0 || w.checked_mul(h)? > MAX_PIXELS {
        return None;
    }
    if d.get::<bool>("ImageMask") == Some(true) {
        return None; // a stencil, not a picture
    }
    let bpc = num("BitsPerComponent").unwrap_or(8.0) as usize;
    if ![1, 2, 4, 8, 16].contains(&bpc) {
        return None;
    }
    let space = match d.get::<Object<'_>>("ColorSpace") {
        Some(c) => Space::of(&c, 0)?,
        None => Space::Gray,
    };
    let comps = space.components();
    let data = unpack(s)?;
    let row = (w * comps * bpc).div_ceil(8);
    if data.len() < row * h {
        return None;
    }
    let max = ((1u32 << bpc) - 1) as f64;
    let decode: Vec<f64> = d.get::<Vec<f64>>("Decode").unwrap_or_default();
    let sample = |r: &[u8], i: usize| -> u32 {
        match bpc {
            8 => r[i] as u32,
            16 => u16::from_be_bytes([r[2 * i], r[2 * i + 1]]) as u32,
            _ => {
                let bit = i * bpc;
                ((r[bit / 8] >> (8 - bpc - bit % 8)) as u32) & ((1 << bpc) - 1)
            }
        }
    };
    let out_space = match &space {
        Space::Indexed(base, _) => base.as_ref().clone(),
        s => s.clone(),
    };
    let channels = if matches!(out_space, Space::Gray) { 1 } else { 3 };
    let mut px = Vec::with_capacity(w * h * channels);
    let mut v = vec![0.0; 4];
    for y in 0..h {
        let r = &data[y * row..(y + 1) * row];
        for x in 0..w {
            match &space {
                Space::Indexed(base, table) => {
                    let k = base.components();
                    let at = sample(r, x) as usize * k;
                    for (c, slot) in v.iter_mut().enumerate().take(k) {
                        *slot = table.get(at + c).copied().unwrap_or(0) as f64 / 255.0;
                    }
                }
                _ => {
                    for (c, slot) in v.iter_mut().enumerate().take(comps) {
                        let s = sample(r, x * comps + c) as f64 / max;
                        *slot = match (decode.get(2 * c), decode.get(2 * c + 1)) {
                            (Some(lo), Some(hi)) => lo + s * (hi - lo),
                            _ => s,
                        };
                    }
                }
            }
            to_pixel(&out_space, &v, &mut px);
        }
    }
    Some((w, h, channels, px))
}

/// Zlib data unpacked, up to [`MAX_STREAM`].
fn inflate(data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    flate2::read::ZlibDecoder::new(data).take(MAX_STREAM as u64 + 1).read_to_end(&mut out).ok()?;
    (out.len() <= MAX_STREAM).then_some(out)
}

/// A picture as a file for the note: the JPEG as stored, or its pixels
/// (with any soft mask as transparency) as a PNG. `flip` mirrors the pixels
/// (across, down) when the page draws the picture mirrored.
fn picture(s: &Stream<'_>, flip: (bool, bool)) -> Option<(Vec<u8>, &'static str)> {
    let filters = s.filters();
    if let Some((Filter::DctDecode, before)) = filters.split_last() {
        // The JPEG is kept as it is, so only what wraps it is undone.
        let jpeg = match before {
            [] => s.raw_data().into_owned(),
            [Filter::FlateDecode] => inflate(&s.raw_data())?,
            _ => return None,
        };
        return jpeg.starts_with(&[0xFF, 0xD8]).then_some((jpeg, "jpg"));
    }
    let (w, h, mut channels, mut px) = pixels(s)?;
    if let Some((mw, mh, mc, mask)) = s.dict().get::<Stream<'_>>("SMask").and_then(|m| pixels(&m)) {
        let mut with_alpha = Vec::with_capacity(w * h * (channels + 1));
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * channels;
                with_alpha.extend_from_slice(&px[i..i + channels]);
                let (mx, my) = (x * mw / w, y * mh / h);
                with_alpha.push(mask[(my * mw + mx) * mc]);
            }
        }
        px = with_alpha;
        channels += 1;
    }
    if flip.0 || flip.1 {
        let mut out = Vec::with_capacity(px.len());
        for y in 0..h {
            let sy = if flip.1 { h - 1 - y } else { y };
            for x in 0..w {
                let sx = if flip.0 { w - 1 - x } else { x };
                let i = (sy * w + sx) * channels;
                out.extend_from_slice(&px[i..i + channels]);
            }
        }
        px = out;
    }
    Some((png(w, h, channels, &px)?, "png"))
}

/// A PNG file of 8 bit pixels: 1 (grey), 2 (grey, alpha), 3 (RGB) or 4
/// (RGBA) channels.
fn png(w: usize, h: usize, channels: usize, px: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, w as u32, h as u32);
    encoder.set_color(match channels {
        1 => png::ColorType::Grayscale,
        2 => png::ColorType::GrayscaleAlpha,
        3 => png::ColorType::Rgb,
        _ => png::ColorType::Rgba,
    });
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_deflate_compression(png::DeflateCompression::Level(9));
    encoder.set_filter(png::Filter::NoFilter);
    let mut writer = encoder.write_header().ok()?;
    writer.write_image_data(px).ok()?;
    writer.finish().ok()?;
    Some(out)
}

/// Puts the page's pictures on the note, under the ink, where they sit on
/// the page. Returns how many could not be brought in.
fn place_pictures(
    doc: &mut Document,
    placed: &[(Stream<'_>, Matrix)],
    to_page: &dyn Fn(Vec2) -> Vec2,
    done: &mut Pictures,
) -> usize {
    let mut images = doc.images().to_vec();
    let mut left_out = 0;
    for (stream, m) in placed {
        // The picture fills the unit square; its first row is at the top (y = 1).
        let p00 = to_page(apply(m, 0.0, 0.0));
        let p10 = to_page(apply(m, 1.0, 0.0));
        let p01 = to_page(apply(m, 0.0, 1.0));
        let p11 = to_page(apply(m, 1.0, 1.0));
        let mut r = Rect::EMPTY;
        for p in [p00, p10, p01, p11] {
            r.include(p);
        }
        if !(r.width() >= 0.5 && r.height() >= 0.5) {
            continue; // nothing to see
        }
        let flip = (p10.x < p00.x, p01.y > p00.y);
        let made = done.entry((stream.obj_id().obj_number, flip)).or_insert_with(|| {
            picture(stream, flip).map(|(bytes, ext)| {
                let name =
                    format!("{}{:08x}{:08x}.{ext}", crate::format::IMAGES_DIR, crate::zip::crc32(&bytes), bytes.len());
                (name, bytes)
            })
        });
        let Some((name, bytes)) = made else {
            left_out += 1;
            continue;
        };
        let name = name.clone();
        doc.assets.entry(name.clone()).or_insert_with(|| bytes.clone());
        images.push(Image {
            id: doc.next_id(),
            file: name,
            text: None,
            x: r.min.x,
            y: r.min.y,
            w: r.width(),
            h: r.height(),
        });
    }
    doc.set_images(images);
    left_out
}

// ---- Ink to strokes -------------------------------------------------------------

fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

fn area(poly: &[Vec2]) -> f64 {
    let mut a = 0.0;
    for i in 0..poly.len() {
        let (p, q) = (poly[i], poly[(i + 1) % poly.len()]);
        a += p.x * q.y - q.x * p.y;
    }
    (a * 0.5).abs()
}

/// One piece of a filled stroke outline as a short stretch of centre line,
/// and how wide it is.
///
/// Pens draw a stroke as many short overlapping pieces, each a closed
/// outline around a stretch of the line: GoodNotes as four-cornered pieces
/// with flat ends, Apple Notes as capsules with round ends drawn with
/// curves. The piece's long axis (where its points spread the most) finds
/// its two ends; between them the outline runs along both sides of the
/// line, and the centre line is halfway between the two sides. A
/// round-ended piece reaches half its width past the line's end, so its
/// centre line is shortened by that much at each end.
struct Stretch {
    points: Vec<Vec2>,
    width: f64,
    /// Round ends: the points run on into them, to be trimmed.
    round: bool,
}

/// `n` points spread evenly along a polyline, ends included.
fn resample(line: &[Vec2], n: usize) -> Vec<Vec2> {
    let total: f64 = line.windows(2).map(|w| w[0].distance(w[1])).sum();
    if line.len() < 2 || total < 1e-12 {
        return vec![line[0]; n];
    }
    let mut out = Vec::with_capacity(n);
    let (mut i, mut walked) = (0, 0.0);
    for k in 0..n {
        let want = total * k as f64 / (n - 1) as f64;
        while i + 2 < line.len() && walked + line[i].distance(line[i + 1]) < want {
            walked += line[i].distance(line[i + 1]);
            i += 1;
        }
        let seg = line[i].distance(line[i + 1]);
        let t = if seg > 1e-12 { ((want - walked) / seg).clamp(0.0, 1.0) } else { 0.0 };
        out.push(line[i].lerp(line[i + 1], t));
    }
    out
}

/// A polyline with `start` taken off its start and `end` off its end, but
/// never all of it: at least its middle point is left.
fn trim_ends(line: &[Vec2], start: f64, end: f64) -> Vec<Vec2> {
    let total: f64 = line.windows(2).map(|w| w[0].distance(w[1])).sum();
    if line.len() < 2 || total < 1e-9 {
        return line.to_vec();
    }
    let keep = (total - start - end).max(0.0);
    let (start, end) = if keep > 0.0 { (start, end) } else { (total * 0.5, total * 0.5) };
    let at = |d: f64| -> (usize, Vec2) {
        let mut walked = 0.0;
        for i in 0..line.len() - 1 {
            let seg = line[i].distance(line[i + 1]);
            if walked + seg >= d {
                let t = if seg > 1e-12 { (d - walked) / seg } else { 0.0 };
                return (i, line[i].lerp(line[i + 1], t));
            }
            walked += seg;
        }
        (line.len() - 2, line[line.len() - 1])
    };
    let (i, a) = at(start);
    let (j, b) = at(total - end);
    let mut out = vec![a];
    out.extend_from_slice(&line[i + 1..=j]);
    out.push(b);
    out
}

fn stretch(piece: &[Vec2]) -> Option<Stretch> {
    let n = piece.len();
    if n < 3 {
        return None;
    }
    // A dab of the pen (Apple Notes draws one at each pen sample): a
    // point, as wide as the circle.
    let mut r = Rect::EMPTY;
    for p in piece {
        r.include(*p);
    }
    let d = r.width().max(r.height());
    if n > 4
        && r.width().min(r.height()) > 0.85 * d
        && (area(piece) / (std::f64::consts::FRAC_PI_4 * d * d) - 1.0).abs() < 0.15
    {
        return Some(Stretch { points: vec![(r.min + r.max) * 0.5], width: d, round: false });
    }
    let mean = piece.iter().fold(Vec2::ZERO, |s, p| s + *p) * (1.0 / n as f64);
    let (mut sxx, mut syy, mut sxy) = (0.0, 0.0, 0.0);
    for p in piece {
        let d = *p - mean;
        sxx += d.x * d.x;
        syy += d.y * d.y;
        sxy += d.x * d.y;
    }
    let angle = 0.5 * (2.0 * sxy).atan2(sxx - syy);
    let dir = Vec2::new(angle.cos(), angle.sin());
    let along = |p: &Vec2| (*p - mean).dot(dir);
    let pick = |better: fn(f64, f64) -> bool| {
        (0..n).fold(0, |best, i| if better(along(&piece[i]), along(&piece[best])) { i } else { best })
    };
    let (i0, i1) = (pick(|a, b| a < b), pick(|a, b| a > b));
    if i0 == i1 {
        return None;
    }
    // The outline from one end to the other, one way round and the other.
    let mut side_a = vec![piece[i0]];
    let mut i = i0;
    while i != i1 {
        i = (i + 1) % n;
        side_a.push(piece[i]);
    }
    let mut side_b = vec![piece[i0]];
    let mut i = i0;
    while i != i1 {
        i = (i + n - 1) % n;
        side_b.push(piece[i]);
    }
    let a_len: f64 = side_a.windows(2).map(|w| w[0].distance(w[1])).sum();
    let steps = ((a_len / 0.5).ceil() as usize).clamp(2, 48) + 1;
    // Halfway between each point of one side and the nearest point of the
    // other: the two sides can be of different lengths where the ends are
    // of different widths.
    let nearest = |p: Vec2, line: &[Vec2]| {
        line.windows(2)
            .map(|w| {
                let d = w[1] - w[0];
                let t = if d.dot(d) > 1e-18 { ((p - w[0]).dot(d) / d.dot(d)).clamp(0.0, 1.0) } else { 0.0 };
                w[0] + d * t
            })
            .min_by(|x, y| x.distance(p).total_cmp(&y.distance(p)))
            .unwrap_or(line[0])
    };
    let pairs: Vec<(Vec2, Vec2)> = resample(&side_a, steps).into_iter().map(|p| (p, nearest(p, &side_b))).collect();
    let centre: Vec<Vec2> = pairs.iter().map(|(p, q)| (*p + *q) * 0.5).collect();
    let length: f64 = centre.windows(2).map(|w| w[0].distance(w[1])).sum();
    if length < 1e-9 {
        return None;
    }
    // Across the middle, from one side to the other.
    let (p, q) = pairs[pairs.len() / 2];
    let width = p.distance(q);
    // Four corners and straight sides: flat ends. Curves: round ends.
    let round = n > 4;
    Some(Stretch { points: centre, width, round })
}

/// The centre line of one filled stroke outline, in page space, with the
/// width at each point; and the outline's typical width.
fn centre_line(pieces: &[Vec<Vec2>]) -> Option<(Vec<(Vec2, f64)>, f64)> {
    let mut stretches: Vec<Stretch> = pieces.iter().filter_map(|p| stretch(p)).collect();
    if stretches.is_empty() {
        // A dot: as wide as it is.
        let mut r = Rect::EMPTY;
        for p in pieces.iter().flatten() {
            r.include(*p);
        }
        if r.is_empty() {
            return None;
        }
        let w = r.width().max(r.height());
        return Some((vec![((r.min + r.max) * 0.5, w)], w));
    }
    // The pieces come in writing order, but each one's own direction is
    // not known: turn each to start where the one before ended.
    for i in 0..stretches.len() {
        let (from, to) = (stretches[i].points[0], *stretches[i].points.last().unwrap());
        let flip = if i == 0 {
            stretches.get(1).is_some_and(|next| {
                let (nf, nt) = (next.points[0], *next.points.last().unwrap());
                let near = |p: Vec2| p.distance(nf).min(p.distance(nt));
                near(from) < near(to)
            })
        } else {
            let end = *stretches[i - 1].points.last().unwrap();
            end.distance(to) < end.distance(from)
        };
        if flip {
            stretches[i].points.reverse();
        }
    }
    // Inside a round end the halfway points bend towards one side, so it
    // is cut off: half the width at the stroke's own ends (where the pen
    // stopped at the end's centre), the whole width where pieces meet
    // (the next piece, or the dab there, carries the line on).
    let last = stretches.len() - 1;
    for (i, s) in stretches.iter_mut().enumerate() {
        if s.round {
            let (start, end) = (if i == 0 { 0.5 } else { 1.0 }, if i == last { 0.5 } else { 1.0 });
            s.points = trim_ends(&s.points, s.width * start, s.width * end);
        }
    }
    let mut line: Vec<(Vec2, f64)> = Vec::new();
    for s in &stretches {
        for &p in &s.points {
            if line.last().is_none_or(|l| l.0.distance(p) > 0.05) {
                line.push((p, s.width));
            }
        }
    }
    // The pieces' own lines meet with small kinks: one gentle pass of
    // averaging with the neighbours evens them out, keeping the ends.
    if line.len() > 2 {
        let raw = line.clone();
        for i in 1..raw.len() - 1 {
            let (a, b, c) = (raw[i - 1], raw[i], raw[i + 1]);
            line[i] = ((a.0 + b.0 * 2.0 + c.0) * 0.25, (a.1 + b.1 * 2.0 + c.1) * 0.25);
        }
    }
    let mut widths: Vec<f64> = stretches.iter().map(|s| s.width).collect();
    Some((line, median(&mut widths)))
}

/// The pressure at which the pen draws a line `width` wide with a brush
/// of `size` (its width at full pressure): the inverse of the pen's
/// `size * (0.3 + 0.7 * pressure^0.8)` in [`Brush::footprint`].
fn pressure_for(width: f64, size: f64) -> f32 {
    if size <= 0.0 {
        return 1.0;
    }
    let r = ((width / size - 0.3) / 0.7).clamp(0.0, 1.0);
    r.powf(1.0 / 0.8) as f32
}

fn build_page(ink: &Ink<'_>, media: Rect, seed: u64, t: &mut f64, pictures: &mut Pictures) -> PdfPage {
    let mut doc = Document::new(seed);
    doc.paper = "plain".into();
    let to_page = |p: Vec2| Vec2::new(p.x - media.min.x, media.max.y - p.y);
    let mut strokes = Vec::new();
    let mut warnings = Vec::new();
    let mut shapes = 0;
    for path in &ink.paths {
        if path.color.iter().all(|c| *c > 0.97) {
            continue; // white: paper or an eraser trace
        }
        // Each line: its points with the width there.
        let lines: Vec<Vec<(Vec2, f64)>> = match path.line {
            None => match centre_line(&path.pieces) {
                Some((l, w)) if w <= MAX_INK_WIDTH => vec![l],
                _ => {
                    shapes += 1;
                    continue;
                }
            },
            Some(w) => {
                path.pieces.iter().filter(|p| !p.is_empty()).map(|p| p.iter().map(|q| (*q, w)).collect()).collect()
            }
        };
        for line in lines {
            // The brush is as wide as the line's widest point; narrower
            // points press lighter, so the line keeps the widths the PDF
            // drew (see `pressure_for`).
            let size = line.iter().map(|p| p.1).fold(0.0, f64::max);
            let pts: Vec<(Vec2, f64)> = line.into_iter().map(|(p, w)| (to_page(p), w)).collect();
            let mut points = Vec::with_capacity(pts.len());
            let mut along = 0.0;
            for (i, (p, w)) in pts.iter().enumerate() {
                if i > 0 {
                    along += p.distance(pts[i - 1].0);
                }
                points.push(InputPoint {
                    x: p.x,
                    y: p.y,
                    pressure: pressure_for(*w, size),
                    altitude: std::f32::consts::FRAC_PI_2,
                    azimuth: 0.0,
                    t: (along / SPEED).round(),
                });
            }
            let c = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
            let kind = if path.alpha < 0.95 { BrushKind::Highlighter } else { BrushKind::Pen };
            let brush = Brush {
                // The PDF holds the line as drawn, thin ends and all: draw
                // exactly those widths, with no taper or speed of our own.
                pressure: Some(1.0),
                speed: Some(0.0),
                taper_start: Some(0.0),
                taper_end: Some(0.0),
                // A highlighter draws four times its size.
                ..Brush::new(
                    kind,
                    Rgba::rgb(c(path.color[0]), c(path.color[1]), c(path.color[2])),
                    if kind == BrushKind::Highlighter { size / 4.0 } else { size } as f32,
                )
            };
            let id = doc.next_id();
            let duration = along / SPEED;
            let mut stroke = Stroke::new(id, brush, t.round(), InputDevice::Pen, points);
            // The PDF's points are exact, not whole screen pixels: smooth
            // them only as much as a pen drawn at high zoom, so small
            // handwriting keeps its shape.
            stroke.input_scale = INPUT_SCALE;
            strokes.push(stroke);
            *t += duration + GAP_MS;
        }
    }
    doc.set_strokes(strokes);
    let readings = attach_readings(&mut doc, &ink.spans, &to_page);
    let left_out = place_pictures(&mut doc, &ink.pictures, &to_page, pictures) + ink.skipped_pictures;
    if left_out > 0 {
        warnings.push(format!("{left_out} picture{} left out", if left_out == 1 { "" } else { "s" }));
    }
    let typed = ink.spans.iter().filter(|s| !s.invisible).count();
    if typed > 0 {
        warnings.push(format!("{typed} piece{} of typed text left out", if typed == 1 { "" } else { "s" }));
    }
    if shapes > 0 {
        warnings.push(format!("{shapes} filled shape{} left out", if shapes == 1 { "" } else { "s" }));
    }
    PdfPage { doc, readings, warnings }
}

/// Finds where the text layer sits on the ink. GoodNotes places it with a
/// large offset, so the two are lined up: first by their bounds, then by
/// moving the text towards the ink under it until it settles.
fn align(spans: &[Vec2], ink: &[Vec2]) -> Option<Vec2> {
    if spans.is_empty() || ink.is_empty() {
        return None;
    }
    let bounds = |ps: &[Vec2]| {
        let mut r = Rect::EMPTY;
        for p in ps {
            r.include(*p);
        }
        r
    };
    let (sb, ib) = (bounds(spans), bounds(ink));
    let mut off = sb.min - ib.min;
    const CELL: f64 = 64.0;
    let mut grid: HashMap<(i64, i64), Vec<Vec2>> = HashMap::new();
    for p in ink {
        grid.entry(((p.x / CELL).floor() as i64, (p.y / CELL).floor() as i64)).or_default().push(*p);
    }
    let nearest = |q: Vec2| -> Option<Vec2> {
        let (cx, cy) = ((q.x / CELL).floor() as i64, (q.y / CELL).floor() as i64);
        let mut best: Option<(f64, Vec2)> = None;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for p in grid.get(&(cx + dx, cy + dy)).into_iter().flatten() {
                    let d = p.distance(q);
                    if best.is_none_or(|b| d < b.0) {
                        best = Some((d, *p));
                    }
                }
            }
        }
        best.map(|b| b.1)
    };
    let mut matched = 0;
    for _ in 0..6 {
        let (mut dx, mut dy) = (Vec::new(), Vec::new());
        for s in spans {
            let q = *s - off;
            if let Some(p) = nearest(q) {
                dx.push(q.x - p.x);
                dy.push(q.y - p.y);
            }
        }
        matched = dx.len();
        if matched == 0 {
            return None;
        }
        off = off + Vec2::new(median(&mut dx), median(&mut dy));
    }
    (matched * 10 >= spans.len() * 3).then_some(off)
}

/// Keeps the hidden text layer's readings as the words' recognised text.
/// Returns how many words got one.
fn attach_readings(doc: &mut Document, spans: &[Span], to_page: &dyn Fn(Vec2) -> Vec2) -> usize {
    let hidden: Vec<Span> =
        spans.iter().filter(|s| s.invisible).map(|s| Span { at: to_page(s.at), ..s.clone() }).collect();
    let ink: Vec<Vec2> = doc.strokes().iter().flat_map(|s| s.points.iter().map(|p| p.pos())).collect();
    // A span's anchor: a little above its baseline, inside the letters.
    let anchor = |s: &Span| s.at - Vec2::new(0.0, s.size * 0.3);
    let anchors: Vec<Vec2> = hidden.iter().map(anchor).collect();
    let Some(off) = align(&anchors, &ink) else { return 0 };
    let layout = words::layout(doc);
    let mut per_word: HashMap<usize, Vec<(f64, &Span)>> = HashMap::new();
    for (s, a) in hidden.iter().zip(&anchors) {
        let q = *a - off;
        let mut best: Option<(f64, usize)> = None;
        for (i, w) in layout.words.iter().enumerate() {
            let lh = layout.lines[w.line].letter_height;
            let r = w.bounds.inflate(lh * 0.4);
            if r.contains(q) {
                let a = r.width() * r.height();
                if best.is_none_or(|b| a < b.0) {
                    best = Some((a, i));
                }
            }
        }
        if let Some((_, i)) = best {
            per_word.entry(i).or_default().push((q.x, s));
        }
    }
    let mut n = 0;
    for (i, mut parts) in per_word {
        parts.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut text = String::new();
        let mut end = f64::NEG_INFINITY;
        let mut prev: f64 = 0.0;
        for (x, s) in parts {
            // Pieces far apart are two words the layout put together.
            if !text.is_empty() && x - end > s.size.max(prev) * 0.6 {
                text.push(' ');
            }
            text.push_str(&s.text);
            end = x + s.text.chars().count() as f64 * s.size * 0.5;
            prev = s.size;
        }
        let w = &layout.words[i];
        doc.recognition.push(RecognizedText {
            id: format!("{:016x}", w.id),
            text,
            strokes: w.strokes.clone(),
            alternatives: Vec::new(),
            confidence: None,
            language: Some("en".into()),
            engine: Some(ENGINE.into()),
        });
        n += 1;
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small PDF like a GoodNotes export: each stroke a filled outline of
    /// pieces, plus an invisible text layer placed with a large offset.
    pub(crate) fn sample_pdf(compress: bool) -> Vec<u8> {
        let mut c = String::new();
        c.push_str("q 1 1 1 sc 0 0 600 400 re f Q\n");
        // Three "letters": short strokes 20 units tall, at x = 100, 130, 160
        // (one word), and one at x = 300 (another word). y up in the PDF.
        let mut stroke = |x: f64, y: f64, color: &str| {
            c.push_str(&format!("{color} sc\n"));
            // Two pieces from (x, y) to (x+5, y+10) to (x+10, y+20), each a thin
            // closed outline 2 units wide.
            for (a, b) in [((x, y), (x + 5.0, y + 10.0)), ((x + 5.0, y + 10.0), (x + 10.0, y + 20.0))] {
                c.push_str(&format!(
                    "{} {} m {} {} l {} {} l {} {} l h ",
                    a.0,
                    a.1,
                    b.0,
                    b.1,
                    b.0 + 2.0,
                    b.1,
                    a.0 + 2.0,
                    a.1
                ));
            }
            c.push_str("f\n");
        };
        stroke(100.0, 300.0, "0.1 0.1 0.1");
        stroke(115.0, 300.0, "0.1 0.1 0.1");
        stroke(130.0, 300.0, "0.1 0.1 0.1");
        stroke(300.0, 300.0, "0.8 0.1 0.1");
        // Hidden text, 5000 units away, as GoodNotes does.
        c.push_str("3 Tr q 1 0 0 1 5100 5302 cm BT 20 0 0 20 0 0 Tm /F1 1 Tf (h\\151) Tj ET Q\n");
        c.push_str("q 1 0 0 1 5300 5302 cm BT 20 0 0 20 0 0 Tm /F1 1 Tf [(o) -5 (k)] TJ ET Q\n");
        c.push_str("0 Tr BT 12 0 0 12 50 50 Tm /F1 1 Tf (typed) Tj ET\n");
        let (data, filter) =
            if compress { (zlib(c.as_bytes()), " /Filter /FlateDecode") } else { (c.into_bytes(), "") };
        let mut pdf = b"%PDF-1.4\n".to_vec();
        pdf.extend_from_slice(b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n");
        pdf.extend_from_slice(b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 600 400] >> endobj\n");
        pdf.extend_from_slice(b"3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << >> >> endobj\n");
        pdf.extend_from_slice(format!("4 0 obj << /Length 5 0 R{filter} >>\nstream\n").as_bytes());
        pdf.extend_from_slice(&data);
        pdf.extend_from_slice(b"\nendstream\nendobj\n");
        pdf.extend_from_slice(format!("5 0 obj {} endobj\n", data.len()).as_bytes());
        pdf.extend_from_slice(b"trailer << /Root 1 0 R >>\n%%EOF\n");
        pdf
    }

    #[test]
    fn pdf_strokes_become_note_strokes_in_writing_order() {
        for compress in [false, true] {
            let pages = import(&sample_pdf(compress), 7, 1_000.0).unwrap();
            assert_eq!(pages.len(), 1);
            let doc = &pages[0].doc;
            assert_eq!(doc.len(), 4, "the white background is not ink");
            let s = &doc.strokes()[0];
            // Centre line from (100, 300) up to (110, 320) in PDF space: y is
            // flipped (page height 400), so it runs from y = 100 to y = 80.
            let first = s.points.first().unwrap();
            let last = s.points.last().unwrap();
            assert!((first.x - 100.0).abs() < 0.5 && (first.y - 100.0).abs() < 0.5, "{first:?}");
            assert!((last.x - 110.0).abs() < 2.5 && (last.y - 80.0).abs() < 2.5, "{last:?}");
            assert!((s.brush.size - 2.0).abs() < 0.6, "width {}", s.brush.size);
            assert_eq!(doc.strokes()[3].brush.color, Rgba::rgb(204, 26, 26));
            // Times: in order, as if written at an even speed.
            let starts: Vec<f64> = doc.strokes().iter().map(|s| s.start_time).collect();
            assert!(starts.windows(2).all(|w| w[1] > w[0]));
            assert_eq!(starts[0], 1_000.0);
            assert!(s.points.windows(2).all(|w| w[1].t >= w[0].t));
        }
    }

    #[test]
    fn pdf_hidden_text_becomes_the_words_reading() {
        let pages = import(&sample_pdf(true), 7, 0.0).unwrap();
        let p = &pages[0];
        assert_eq!(p.readings, 2);
        let mut texts: Vec<(&str, usize)> =
            p.doc.recognition.iter().map(|r| (r.text.as_str(), r.strokes.len())).collect();
        texts.sort();
        assert_eq!(texts, [("hi", 3), ("ok", 1)]);
        assert!(p.doc.recognition.iter().all(|r| r.engine.as_deref() == Some(ENGINE)));
        assert!(p.warnings.iter().any(|w| w.contains("typed text")), "{:?}", p.warnings);
    }

    #[test]
    fn pdf_damaged_or_not_a_pdf_is_refused_without_panicking() {
        assert!(import(b"hello", 0, 0.0).is_err());
        assert!(import(b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj", 0, 0.0).unwrap_err().contains("no pages"));
        let full = sample_pdf(true);
        for cut in [20, 100, 200, full.len() / 2, full.len() - 30] {
            let _ = import(&full[..cut], 0, 0.0);
        }
        let mut junk = full.clone();
        for i in (300..junk.len()).step_by(7) {
            junk[i] = b'(';
        }
        let _ = import(&junk, 0, 0.0);
    }

    /// A page whose content stream is `data` with `filter`.
    fn one_page(data: &[u8], filter: &str) -> Vec<u8> {
        let mut pdf = b"%PDF-1.7\n".to_vec();
        pdf.extend_from_slice(b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n");
        pdf.extend_from_slice(b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n");
        pdf.extend_from_slice(
            b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >> endobj\n",
        );
        pdf.extend_from_slice(format!("4 0 obj << /Length {} /Filter {filter} >>\nstream\n", data.len()).as_bytes());
        pdf.extend_from_slice(data);
        pdf.extend_from_slice(b"\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
        pdf
    }

    #[test]
    fn pdf_streams_in_any_standard_filter_are_read() {
        // ASCII hex around Flate: the hand-written reader only knew Flate.
        let ink = b"0 g 50 50 m 55 60 l 57 60 l 52 50 l h f";
        let hex: String = zlib(ink).iter().map(|b| format!("{b:02x}")).collect::<String>() + ">";
        let doc = &import(&one_page(hex.as_bytes(), "[/ASCIIHexDecode /FlateDecode]"), 1, 0.0).unwrap()[0].doc;
        assert_eq!(doc.len(), 1);
    }

    #[test]
    fn pdf_stream_that_unpacks_too_large_is_left_out() {
        // A few hundred kilobytes that would unpack past the limit: the page
        // is read as empty instead of filling memory.
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        let block = vec![b' '; 1 << 20];
        for _ in 0..(MAX_STREAM >> 20) + 1 {
            std::io::Write::write_all(&mut z, &block).unwrap();
        }
        let bomb = z.finish().unwrap();
        assert!(bomb.len() < 1 << 20, "{}", bomb.len());
        assert!(import(&one_page(&bomb, "/FlateDecode"), 1, 0.0).unwrap().is_empty());
        assert!(!unpacks_small(&bomb, &[Filter::FlateDecode]));
        // Behind another filter it cannot be measured, so it is judged by
        // how far Flate can grow data at most.
        assert!(!unpacks_small(&vec![b'0'; 200_000], &[Filter::Ascii85Decode, Filter::FlateDecode]));
        assert!(unpacks_small(&vec![b'0'; 1_000], &[Filter::Ascii85Decode, Filter::FlateDecode]));
        assert!(unpacks_small(&zlib(b"0 g"), &[Filter::FlateDecode]));
    }

    #[test]
    fn pdf_stroked_paths_and_form_xobjects_are_read_too() {
        let c = b"q 2 w 0 0 1 RG 10 10 m 20 30 l 30 10 l S Q /Fm1 Do";
        let form = b"0 g 50 50 m 55 60 l 57 60 l 52 50 l h f";
        let mut pdf = b"%PDF-1.7\n".to_vec();
        pdf.extend_from_slice(b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n");
        pdf.extend_from_slice(b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n");
        pdf.extend_from_slice(b"3 0 obj << /Type /Page /MediaBox [0 0 100 100] /Contents [4 0 R] /Resources << /XObject << /Fm1 6 0 R >> >> >> endobj\n");
        pdf.extend_from_slice(format!("4 0 obj << /Length {} >>\nstream\n", c.len()).as_bytes());
        pdf.extend_from_slice(c);
        pdf.extend_from_slice(b"\nendstream endobj\n");
        pdf.extend_from_slice(
            format!(
                "6 0 obj << /Type /XObject /Subtype /Form /Matrix [1 0 0 1 10 0] /Length {} >>\nstream\n",
                form.len()
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(form);
        pdf.extend_from_slice(b"\nendstream endobj\n");
        let doc = &import(&pdf, 1, 0.0).unwrap()[0].doc;
        assert_eq!(doc.len(), 2);
        let s = &doc.strokes()[0];
        assert_eq!(s.points.len(), 3);
        assert_eq!((s.points[1].x, s.points[1].y), (20.0, 70.0));
        assert_eq!(s.brush.size, 2.0);
        assert_eq!(s.brush.color, Rgba::rgb(0, 0, 255));
        assert!((doc.strokes()[1].points[0].x - 60.0).abs() < 0.01, "the form's matrix moves it");
    }

    /// A one page PDF (100 by 100) with `content` as its page.
    fn page_pdf(content: &str) -> Vec<u8> {
        let mut pdf = b"%PDF-1.3\n".to_vec();
        pdf.extend_from_slice(b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n");
        pdf.extend_from_slice(b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n");
        pdf.extend_from_slice(
            b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >> endobj\n",
        );
        pdf.extend_from_slice(format!("4 0 obj << /Length {} >>\nstream\n", content.len()).as_bytes());
        pdf.extend_from_slice(content.as_bytes());
        pdf.extend_from_slice(b"\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
        pdf
    }

    /// One stroke the way Apple Notes writes it to a PDF: a fill of short
    /// overlapping capsules (round ends drawn with curves), one between
    /// each two pen samples, with a round dab at every sample, each piece's
    /// outline starting at an arbitrary side. `samples` are (x, y, width).
    fn apple_notes_stroke(samples: &[(f64, f64, f64)]) -> String {
        const K: f64 = 0.552_284_8; // a quarter circle as a cubic
        let mut c = String::from("0.1 0.1 0.1 sc\n");
        // Quarter circles around `centre` through the directions `turns`.
        let arc = |c: &mut String, centre: Vec2, r: f64, turns: &[Vec2]| {
            for t in turns.windows(2) {
                let (a, b) = (t[0], t[1]);
                let (c1, c2, end) = (centre + (a + b * K) * r, centre + (b + a * K) * r, centre + b * r);
                c.push_str(&format!("{:.4} {:.4} {:.4} {:.4} {:.4} {:.4} c ", c1.x, c1.y, c2.x, c2.y, end.x, end.y));
            }
        };
        for (i, w) in samples.windows(2).enumerate() {
            let (p, q) = (Vec2::new(w[0].0, w[0].1), Vec2::new(w[1].0, w[1].1));
            let (rp, rq) = (w[0].2 / 2.0, w[1].2 / 2.0);
            let n = (q - p).normalized().perp();
            let (dab, dab_r) = (q, rq);
            // Start on one side or the other, at one end or the other.
            let (p, q, rp, rq, n) = if i % 2 == 0 { (p, q, rp, rq, n) } else { (q, p, rq, rp, n * -1.0) };
            let a = p + n * rp;
            c.push_str(&format!("{:.4} {:.4} m ", a.x, a.y));
            let b = q + n * rq;
            c.push_str(&format!("{:.4} {:.4} l ", b.x, b.y));
            let d = (q - p).normalized();
            arc(&mut c, q, rq, &[n, d, n * -1.0]);
            let e = p - n * rp;
            c.push_str(&format!("{:.4} {:.4} l ", e.x, e.y));
            arc(&mut c, p, rp, &[n * -1.0, d * -1.0, n]);
            c.push_str("h ");
            // A dab at the sample.
            let f = dab + Vec2::new(dab_r, 0.0);
            c.push_str(&format!("{:.4} {:.4} m ", f.x, f.y));
            let (x, y) = (Vec2::new(1.0, 0.0), Vec2::new(0.0, 1.0));
            arc(&mut c, dab, dab_r, &[x, y, x * -1.0, y * -1.0, x]);
            c.push_str("h\n");
        }
        c.push_str("f\n");
        c
    }

    #[test]
    fn pdf_strokes_drawn_as_round_pieces_keep_their_line_and_widths() {
        // Bug: Apple Notes PDFs came in with every stroke zigzagging from
        // one side of its outline to the other, all lines thinner than
        // drawn, and small writing smoothed out of shape.
        // An arch 30 wide and 16 tall, as small handwriting, thin at the
        // ends and 1.6 wide at the top.
        let samples: Vec<(f64, f64, f64)> = (0..=24)
            .map(|k| {
                let t = k as f64 / 24.0;
                let a = std::f64::consts::PI * t;
                (35.0 + 15.0 * (1.0 - a.cos()), 40.0 + 16.0 * a.sin(), 0.4 + 1.2 * a.sin())
            })
            .collect();
        let doc = &import(&page_pdf(&apple_notes_stroke(&samples)), 1, 0.0).unwrap()[0].doc;
        assert_eq!(doc.len(), 1, "one stroke");
        let s = &doc.strokes()[0];
        // The line through the pen's samples, in note space (y down).
        let path: Vec<Vec2> = samples.iter().map(|p| Vec2::new(p.0, 100.0 - p.1)).collect();
        let off = |p: Vec2| {
            path.windows(2).map(|w| crate::geom::point_segment_distance(p, w[0], w[1])).fold(f64::INFINITY, f64::min)
        };
        for p in &s.points {
            assert!(off(p.pos()) < 0.15, "{:?} is {} off the line", p.pos(), off(p.pos()));
        }
        // It runs the whole way, start to end.
        assert!(s.points.first().unwrap().pos().distance(path[0]) < 0.5);
        assert!(s.points.last().unwrap().pos().distance(path[24]) < 0.5);
        // As wide as drawn: the brush is the widest point, and narrow
        // points press lighter so the pen draws them as narrow.
        assert!((s.brush.size - 1.6).abs() < 0.15, "size {}", s.brush.size);
        let top = s.points.iter().min_by(|a, b| a.y.total_cmp(&b.y)).unwrap();
        let end = s.points.first().unwrap();
        let drawn = |p: &InputPoint| s.brush.footprint(p, 0.0).width as f64;
        assert!((drawn(top) - 1.6).abs() < 0.2, "top {}", drawn(top));
        assert!(drawn(end) < 0.8, "end {}", drawn(end));
        assert_eq!((s.brush.taper_start, s.brush.taper_end, s.brush.speed), (Some(0.0), Some(0.0), Some(0.0)));
        // Exact points: not smoothed like whole screen pixels.
        assert!(s.input_scale < 0.1);
    }

    #[test]
    fn imported_strokes_keep_their_shape_through_the_pens_smoothing() {
        // Imported strokes carry made-up timing, so the Ink Stroke Modeler
        // smooths them like pen input: small handwriting must keep its
        // shape (the arch from the Apple Notes test, 30 wide).
        let samples: Vec<(f64, f64, f64)> = (0..=24)
            .map(|k| {
                let a = std::f64::consts::PI * k as f64 / 24.0;
                (35.0 + 15.0 * (1.0 - a.cos()), 40.0 + 16.0 * a.sin(), 0.4 + 1.2 * a.sin())
            })
            .collect();
        let doc = &import(&page_pdf(&apple_notes_stroke(&samples)), 1, 0.0).unwrap()[0].doc;
        let s = &doc.strokes()[0];
        let path: Vec<Vec2> = samples.iter().map(|p| Vec2::new(p.0, 100.0 - p.1)).collect();
        let off = |p: Vec2| {
            path.windows(2).map(|w| crate::geom::point_segment_distance(p, w[0], w[1])).fold(f64::INFINITY, f64::min)
        };
        let smoothed = crate::pen::filter_points(&s.points, s.input_scale);
        for p in &smoothed {
            assert!(off(p.pos()) < 0.15, "{:?} is {} off the line", p.pos(), off(p.pos()));
        }
    }

    /// The pixels of a PNG file: (width, height, channels, pixels).
    fn read_png(b: &[u8]) -> (usize, usize, usize, Vec<u8>) {
        let mut reader = png::Decoder::new(std::io::Cursor::new(b)).read_info().expect("a PNG file");
        let mut px = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut px).unwrap();
        assert_eq!(info.bit_depth, png::BitDepth::Eight, "8 bits");
        px.truncate(info.buffer_size());
        (info.width as usize, info.height as usize, info.color_type.samples(), px)
    }

    /// Data packed with zlib, as a PDF's Flate filter keeps it.
    fn zlib(data: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        z.write_all(data).unwrap();
        z.finish().unwrap()
    }

    #[test]
    fn pdf_pictures_come_across_where_they_sit_on_the_page() {
        let z = zlib;
        let jpeg = b"\xFF\xD8\xFF\xE0fake jpeg\xFF\xD9".to_vec();
        // (number, dictionary, stream data)
        let objects: Vec<(u32, String, Vec<u8>)> = vec![
            (
                4,
                String::new(),
                b"q 40 0 0 20 10 70 cm /Im1 Do Q q 30 0 0 -10 100 30 cm /Im2 Do Q \
                  q 20 0 0 20 150 10 cm /Im3 Do Q q 10 0 0 10 150 60 cm /Im4 Do Q q 5 0 0 5 0 0 cm /Im5 Do Q"
                    .to_vec(),
            ),
            // 2x2 RGB: red, green / blue, white.
            (
                5,
                "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode".into(),
                z(&[255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]),
            ),
            // 1x2 grey, black over white, stored with the PNG "up" predictor,
            // with a soft mask; drawn upside down.
            (
                6,
                "/Type /XObject /Subtype /Image /Width 1 /Height 2 /ColorSpace [/ICCBased 9 0 R] /BitsPerComponent 8 \
                 /Filter /FlateDecode /DecodeParms << /Predictor 12 /Colors 1 /Columns 1 >> /SMask 10 0 R"
                    .into(),
                z(&[2, 0, 2, 255]),
            ),
            (7, "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode".into(), jpeg.clone()),
            // 2x1 palette, 1 bit: red, blue.
            (
                8,
                "/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace [/Indexed /DeviceRGB 1 <ff00000000ff>] /BitsPerComponent 1".into(),
                vec![0b0100_0000],
            ),
            (9, "/N 1".into(), Vec::new()),
            (10, "/Type /XObject /Subtype /Image /Width 1 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8".into(), vec![255, 128]),
            // JPEG 2000 is not supported.
            (11, "/Type /XObject /Subtype /Image /Width 1 /Height 1 /Filter /JPXDecode".into(), vec![0]),
        ];
        let mut pdf = b"%PDF-1.7\n".to_vec();
        pdf.extend_from_slice(b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n");
        pdf.extend_from_slice(b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n");
        pdf.extend_from_slice(
            b"3 0 obj << /Type /Page /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /XObject \
              << /Im1 5 0 R /Im2 6 0 R /Im3 7 0 R /Im4 8 0 R /Im5 11 0 R >> >> >> endobj\n",
        );
        for (n, dict, data) in &objects {
            pdf.extend_from_slice(format!("{n} 0 obj << {dict} /Length {} >>\nstream\n", data.len()).as_bytes());
            pdf.extend_from_slice(data);
            pdf.extend_from_slice(b"\nendstream endobj\n");
        }
        let pages = import(&pdf, 1, 0.0).unwrap();
        assert_eq!(pages.len(), 1, "a page with only pictures is kept");
        let (doc, warnings) = (&pages[0].doc, &pages[0].warnings);
        assert_eq!(warnings, &vec!["1 picture left out".to_string()]);
        let images = doc.images();
        assert_eq!(images.len(), 4);
        let at = |i: usize| (images[i].x, images[i].y, images[i].w, images[i].h);
        let file = |i: usize| &doc.assets[&images[i].file];

        assert_eq!(at(0), (10.0, 10.0, 40.0, 20.0), "y flipped to the note's top-down page");
        assert!(images[0].file.starts_with("images/") && images[0].file.ends_with(".png"));
        assert_eq!(read_png(file(0)), (2, 2, 3, vec![255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]));

        assert_eq!(at(1), (100.0, 70.0, 30.0, 10.0));
        // Upside down on the page, so white is on top; grey with alpha.
        assert_eq!(read_png(file(1)), (1, 2, 2, vec![255, 128, 0, 255]));

        assert!(images[2].file.ends_with(".jpg"));
        assert_eq!(file(2), &jpeg, "a JPEG is kept as it is");

        assert_eq!(read_png(file(3)), (2, 1, 3, vec![255, 0, 0, 0, 0, 255]));

        // The note is saved with its pictures and reads back the same.
        let bundle = crate::format::to_bedrock(doc);
        let back = crate::format::load_bytes(&bundle, 2).unwrap().doc;
        assert_eq!(back.images(), doc.images());
        assert_eq!(back.assets[&images[0].file], *file(0));
    }
}
