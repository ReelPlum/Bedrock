//! # The Bedrock note format
//!
//! A note is saved as **one SVG file** (`*.bedrock.svg`):
//!
//! * Any browser, image viewer or vector editor can open it and shows the
//!   handwriting as ordinary vector paths. If Bedrock ever disappears, notes
//!   are still readable, printable and convertible.
//! * The exact pen data lives inside the same file as plain JSON in
//!   `<metadata id="bedrock-note">`, so Bedrock (or anyone, see
//!   `docs/note-format.md`) can restore every stroke losslessly.
//!
//! The JSON is also accepted on its own (`*.bedrock.json`).

use crate::brush::{Brush, BrushKind};
use crate::color::Rgba;
use crate::document::{Document, RecognizedText};
use crate::input::InputPoint;
use crate::points_bin;
use crate::stroke::{InputDevice, Stroke, StrokeId};
use crate::tessellate;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::borrow::Cow;
use std::collections::HashMap;
use std::f32::consts::FRAC_PI_2;
use std::fmt;

pub const FORMAT_NAME: &str = "bedrock-note";
/// The version a bare `note.json` export and the JSON inside an SVG export
/// are written with: every sample is in the JSON.
pub const FORMAT_VERSION: u32 = 1;
/// The version `note.json` inside a `.bedrock` is written with when its
/// samples are in `points.bin` (strokes without `points`).
pub const CONTAINER_VERSION: u32 = 2;
/// The newest version this reader knows.
pub const READ_VERSION: u32 = 2;
/// Default per-point channel layout of the flat `points` array.
pub const CHANNELS: [&str; 6] = ["x", "y", "pressure", "altitude", "azimuth", "t"];
const METADATA_OPEN: &str = "<metadata id=\"bedrock-note\">";

#[derive(Debug, PartialEq)]
pub enum FormatError {
    NotABedrockNote,
    Json(String),
    Invalid(String),
}

impl fmt::Display for FormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FormatError::NotABedrockNote => write!(f, "this file does not contain a Bedrock note"),
            FormatError::Json(e) => write!(f, "the note data is not valid JSON: {e}"),
            FormatError::Invalid(e) => write!(f, "the note data is invalid: {e}"),
        }
    }
}

impl std::error::Error for FormatError {}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StrokeJson {
    id: StrokeId,
    brush: Brush,
    #[serde(default)]
    device: InputDevice,
    /// Unix epoch ms of the first sample.
    #[serde(default)]
    start: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    derived_from: Vec<StrokeId>,
    /// World units per input pixel when drawn (1 / zoom); omitted when 1.
    #[serde(default = "one", skip_serializing_if = "is_one")]
    input_scale: f64,
    /// Flat list, `channels.len()` numbers per sample.
    points: Vec<f64>,
}

/// Positions are stored to 1/1000 of a world unit: at the deepest zoom
/// (250%) that is under 0.002 screen pixels, so saving never moves ink.
/// (It was 1/100, which was 0.64 px at the old 6400% limit.)
pub const POSITION_DECIMALS: i32 = 3;

fn one() -> f64 {
    1.0
}

fn is_one(v: &f64) -> bool {
    *v == 1.0
}

fn round(v: f64, decimals: i32) -> f64 {
    let m = 10f64.powi(decimals);
    let r = (v * m).round() / m;
    if r == 0.0 {
        0.0
    } else {
        r
    }
}

/// Serialise the note data as JSON (the payload embedded in the SVG).
pub fn to_json(doc: &Document) -> String {
    json_with(doc, true)
}

fn json_with(doc: &Document, recognition: bool) -> String {
    serde_json::to_string(&Value::Object(json_value(doc, recognition))).expect("json")
}

/// The decimals each channel of [`CHANNELS`] is saved with.
const CHANNEL_DECIMALS: [u32; 6] = [POSITION_DECIMALS as u32, POSITION_DECIMALS as u32, 3, 3, 3, 1];

fn json_value(doc: &Document, recognition: bool) -> Map<String, Value> {
    json_value_with(doc, recognition, None)
}

/// The note as JSON. With `binary`, each stroke whose samples
/// [`points_bin`] can hold exactly gets no `points`; its steps are pushed
/// to `binary` instead, in stroke order.
fn json_value_with(doc: &Document, recognition: bool, mut binary: Option<&mut Vec<Vec<i64>>>) -> Map<String, Value> {
    let channels = points_channels();
    let mut root = Map::new();
    root.insert("format".into(), FORMAT_NAME.into());
    root.insert("version".into(), FORMAT_VERSION.into());
    root.insert("title".into(), doc.title.clone().into());
    root.insert("created".into(), doc.created.into());
    root.insert("modified".into(), doc.modified.into());
    root.insert("background".into(), doc.background.to_hex().into());
    root.insert("paper".into(), doc.paper.clone().into());
    root.insert("units".into(), "px".into());
    root.insert("channels".into(), CHANNELS.iter().map(|c| Value::from(*c)).collect::<Vec<_>>().into());
    let strokes: Vec<Value> = doc
        .strokes()
        .iter()
        .map(|s| {
            let mut points = Vec::with_capacity(s.points.len() * CHANNELS.len());
            for p in &s.points {
                points.extend_from_slice(&[
                    round(p.x, CHANNEL_DECIMALS[0] as i32),
                    round(p.y, CHANNEL_DECIMALS[1] as i32),
                    round(p.pressure as f64, CHANNEL_DECIMALS[2] as i32),
                    round(p.altitude as f64, CHANNEL_DECIMALS[3] as i32),
                    round(p.azimuth as f64, CHANNEL_DECIMALS[4] as i32),
                    round(p.t, CHANNEL_DECIMALS[5] as i32),
                ]);
            }
            let steps = binary.as_ref().and_then(|_| points_bin::stroke_steps(&points, &channels));
            let in_binary = steps.is_some();
            if let (Some(b), Some(steps)) = (binary.as_mut(), steps) {
                b.push(steps);
                points = Vec::new();
            }
            let mut v = serde_json::to_value(StrokeJson {
                id: s.id,
                brush: s.brush,
                device: s.device,
                start: round(s.start_time, 1),
                derived_from: s.derived_from.clone(),
                input_scale: round(s.input_scale, 6),
                points,
            })
            .expect("stroke serialises");
            if in_binary {
                v.as_object_mut().expect("a stroke is an object").remove("points");
            }
            v
        })
        .collect();
    root.insert("strokes".into(), strokes.into());
    if recognition {
        root.insert("recognition".into(), serde_json::to_value(&doc.recognition).expect("recognition serialises"));
    }
    let links = doc.live_links();
    if !links.is_empty() {
        root.insert("links".into(), serde_json::to_value(&links).expect("links serialise"));
    }
    let kinds = doc.live_kinds();
    if !kinds.is_empty() {
        root.insert("kinds".into(), serde_json::to_value(&kinds).expect("kinds serialise"));
    }
    let groups = doc.live_groups();
    if !groups.is_empty() {
        root.insert("groups".into(), serde_json::to_value(&groups).expect("groups serialise"));
    }
    // Pictures and text boxes share one stacking order; each list keeps it.
    let place = |i: &crate::document::Image, what: (&str, Value)| {
        serde_json::json!({
            "id": i.id, what.0: what.1,
            "x": round(i.x, POSITION_DECIMALS), "y": round(i.y, POSITION_DECIMALS),
            "w": round(i.w, POSITION_DECIMALS), "h": round(i.h, POSITION_DECIMALS),
        })
    };
    let images: Vec<Value> =
        doc.images().iter().filter(|i| i.text.is_none()).map(|i| place(i, ("file", i.file.clone().into()))).collect();
    if !images.is_empty() {
        root.insert("images".into(), images.into());
    }
    let texts: Vec<Value> =
        doc.images().iter().filter_map(|i| i.text.as_ref().map(|t| place(i, ("text", t.clone().into())))).collect();
    if !texts.is_empty() {
        root.insert("texts".into(), texts.into());
    }
    for (k, v) in &doc.extra {
        root.entry(k.clone()).or_insert_with(|| v.clone());
    }
    root
}

const KNOWN_KEYS: [&str; 17] = [
    "format",
    "pointsFile",
    "version",
    "title",
    "created",
    "modified",
    "background",
    "paper",
    "units",
    "channels",
    "strokes",
    "recognition",
    "links",
    "groups",
    "kinds",
    "images",
    "texts",
];

/// A loaded note plus anything that had to be repaired or skipped.
#[derive(Debug)]
pub struct Loaded {
    pub doc: Document,
    /// Human readable notes about damaged data that was skipped or fixed.
    /// Empty for a healthy file.
    pub warnings: Vec<String>,
}

/// Parse note JSON. Damaged strokes are skipped (and reported) instead of
/// failing the whole note: recovering most of a note beats losing all of it.
pub fn from_json(json: &str, seed: u64) -> Result<Loaded, FormatError> {
    let root: Value = serde_json::from_str(json).map_err(|e| FormatError::Json(e.to_string()))?;
    from_value(root, Vec::new(), seed)
}

fn from_value(root: Value, mut warnings: Vec<String>, seed: u64) -> Result<Loaded, FormatError> {
    let obj = root.as_object().ok_or(FormatError::NotABedrockNote)?;
    if obj.get("format").and_then(Value::as_str) != Some(FORMAT_NAME) {
        return Err(FormatError::NotABedrockNote);
    }
    let mut doc = Document::new(seed);
    if let Some(v) = obj.get("version").and_then(Value::as_u64) {
        if v > READ_VERSION as u64 {
            warnings.push(format!("note was written by a newer Bedrock (format {v}); unknown data is kept as-is"));
        }
    }
    doc.title = obj.get("title").and_then(Value::as_str).unwrap_or_default().to_string();
    doc.created = obj.get("created").and_then(Value::as_f64).unwrap_or(0.0);
    doc.modified = obj.get("modified").and_then(Value::as_f64).unwrap_or(0.0);
    if let Some(bg) = obj.get("background").and_then(Value::as_str).and_then(Rgba::parse) {
        doc.background = bg;
    }
    if let Some(p) = obj.get("paper").and_then(Value::as_str) {
        doc.paper = p.to_string();
    }
    let channels: Vec<String> = match obj.get("channels").map(|v| serde_json::from_value::<Vec<String>>(v.clone())) {
        Some(Ok(c)) if c.iter().any(|c| c == "x") && c.iter().any(|c| c == "y") => c,
        Some(_) => return Err(FormatError::Invalid("channels must be a list including \"x\" and \"y\"".into())),
        None => CHANNELS.iter().map(|s| s.to_string()).collect(),
    };
    let stride = channels.len();
    let col = |name: &str| channels.iter().position(|c| c == name);
    let (cx, cy) = (col("x").unwrap(), col("y").unwrap());
    let (cp, calt, caz, ct) = (col("pressure"), col("altitude"), col("azimuth"), col("t"));

    let mut strokes = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let raw_strokes = match obj.get("strokes") {
        Some(Value::Array(a)) => a.clone(),
        None => Vec::new(),
        Some(_) => {
            warnings.push("\"strokes\" is not a list; no ink could be read".into());
            Vec::new()
        }
    };
    for (i, v) in raw_strokes.into_iter().enumerate() {
        let mut sj: StrokeJson = match serde_json::from_value(v) {
            Ok(s) => s,
            Err(e) => {
                warnings.push(format!("stroke {i} skipped: {e}"));
                continue;
            }
        };
        if !sj.points.len().is_multiple_of(stride) {
            warnings.push(format!("stroke {i}: incomplete last sample dropped"));
            let keep = sj.points.len() - sj.points.len() % stride;
            sj.points.truncate(keep);
        }
        if !seen.insert(sj.id) {
            let fresh = doc.next_id();
            warnings.push(format!("stroke {i}: duplicate id {} replaced with {fresh}", sj.id));
            sj.id = fresh;
            seen.insert(fresh);
        }
        let get = |chunk: &[f64], c: Option<usize>, default: f64| c.map(|c| chunk[c]).unwrap_or(default);
        let mut dropped = 0;
        let points: Vec<InputPoint> = sj
            .points
            .chunks_exact(stride)
            .filter(|c| {
                let ok = c[cx].is_finite() && c[cy].is_finite();
                if !ok {
                    dropped += 1;
                }
                ok
            })
            .map(|c| {
                InputPoint {
                    x: c[cx],
                    y: c[cy],
                    pressure: get(c, cp, 0.5) as f32,
                    altitude: get(c, calt, FRAC_PI_2 as f64) as f32,
                    azimuth: get(c, caz, 0.0) as f32,
                    t: get(c, ct, 0.0),
                }
                .sanitized()
            })
            .collect();
        if dropped > 0 {
            warnings.push(format!("stroke {i}: {dropped} damaged samples dropped"));
        }
        let mut brush = sj.brush;
        if !brush.size.is_finite() || brush.size <= 0.0 {
            warnings.push(format!("stroke {i}: invalid brush size replaced"));
            brush.size = Brush::default().size;
        }
        let mut s = Stroke::new(sj.id, brush, if sj.start.is_finite() { sj.start } else { 0.0 }, sj.device, points);
        s.derived_from = sj.derived_from;
        s.input_scale = if sj.input_scale.is_finite() && sj.input_scale > 0.0 { sj.input_scale } else { 1.0 };
        strokes.push(s);
    }
    doc.set_strokes(strokes);
    doc.take_changes();
    if let Some(r) = obj.get("recognition") {
        match serde_json::from_value::<Vec<RecognizedText>>(r.clone()) {
            Ok(r) => doc.recognition = r,
            Err(e) => warnings.push(format!("recognised text skipped: {e}")),
        }
    }
    if let Some(l) = obj.get("links") {
        match serde_json::from_value::<Vec<crate::document::Link>>(l.clone()) {
            Ok(l) => doc.links = l,
            Err(e) => warnings.push(format!("links skipped: {e}")),
        }
    }
    if let Some(k) = obj.get("kinds") {
        match serde_json::from_value::<Vec<crate::document::KindOverride>>(k.clone()) {
            Ok(k) => doc.kinds = k,
            Err(e) => warnings.push(format!("text or maths settings skipped: {e}")),
        }
    }
    if let Some(g) = obj.get("groups") {
        match serde_json::from_value::<Vec<Vec<StrokeId>>>(g.clone()) {
            Ok(g) => doc.groups = g,
            Err(e) => warnings.push(format!("word groups skipped: {e}")),
        }
    }
    let mut images = Vec::new();
    for (key, what) in [("images", "picture"), ("texts", "text box")] {
        for v in obj.get(key).and_then(|v| v.as_array()).into_iter().flatten() {
            match serde_json::from_value::<crate::document::Image>(v.clone()) {
                Ok(i)
                    if (key == "texts") != i.text.is_none()
                        && (i.text.is_some() || !i.file.is_empty())
                        && [i.x, i.y, i.w, i.h].iter().all(|n| n.is_finite())
                        && i.w > 0.0
                        && i.h > 0.0 =>
                {
                    images.push(i)
                }
                Ok(_) => warnings.push(format!("a broken {what} was skipped")),
                Err(e) => warnings.push(format!("a {what} was skipped: {e}")),
            }
        }
    }
    if !images.is_empty() {
        doc.set_images(images);
    }
    for (k, v) in obj {
        if !KNOWN_KEYS.contains(&k.as_str()) {
            doc.extra.insert(k.clone(), v.clone());
        }
    }
    Ok(Loaded { doc, warnings })
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if (c as u32) < 0x20 && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

fn fmt_num(v: f64) -> String {
    fmt_num_at(v, 2)
}

fn fmt_num_at(v: f64, decimals: usize) -> String {
    let r = round(v, decimals as i32);
    let s = format!("{r:.decimals$}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" {
        "0".into()
    } else {
        s.to_string()
    }
}

/// Decimals of outline points in `preview.svg`: 0.1 world units, a tenth of
/// a pixel at 100%, is finer than the thumbnail is ever shown, and about a
/// fifth smaller than 2 decimals. The full SVG export keeps 2. The ink
/// itself is in `note.json` and `points.bin`, never rounded by this.
const PREVIEW_DECIMALS: usize = 1;

fn path_data(points: &[crate::geom::Vec2], decimals: usize) -> String {
    let mut d = String::with_capacity(points.len() * 14);
    for (i, p) in points.iter().enumerate() {
        d.push_str(if i == 0 { "M" } else { "L" });
        d.push_str(&fmt_num_at(p.x, decimals));
        d.push(' ');
        d.push_str(&fmt_num_at(p.y, decimals));
    }
    d.push('Z');
    d
}

/// Write the note as a self-contained SVG with the note JSON embedded.
pub fn to_svg(doc: &Document) -> String {
    svg_with(doc, true)
}

fn svg_with(doc: &Document, embed_data: bool) -> String {
    let b = doc.bounds();
    let b = if b.is_empty() {
        crate::geom::Rect::new(crate::geom::Vec2::ZERO, crate::geom::Vec2::new(800.0, 600.0))
    } else {
        b.inflate(20.0)
    };
    let (x, y, w, h) = (fmt_num(b.min.x), fmt_num(b.min.y), fmt_num(b.width()), fmt_num(b.height()));
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{x} {y} {w} {h}\" width=\"{w}\" height=\"{h}\">\n"
    ));
    out.push_str(&format!(
        "<title>{}</title>\n",
        xml_escape(if doc.title.is_empty() { "Bedrock note" } else { &doc.title })
    ));
    // "]]>" can only occur inside JSON strings, where ">" is equivalent.
    if embed_data {
        let json = to_json(doc).replace("]]>", "]]\\u003e");
        out.push_str(METADATA_OPEN);
        out.push_str("<![CDATA[");
        out.push_str(&json);
        out.push_str("]]></metadata>\n");
    }
    out.push_str(&format!(
        "<rect x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\" fill=\"{}\"/>\n",
        doc.background.to_hex_rgb()
    ));
    // Pictures sit under all ink. The full export embeds them; the preview
    // inside a .bedrock refers to the picture files next to it.
    if !doc.images().is_empty() {
        out.push_str("<g id=\"images\">\n");
        for i in doc.images() {
            if let Some(t) = &i.text {
                let lines: Vec<&str> = t.split('\n').collect();
                let line_h = i.h / lines.len().max(1) as f64;
                out.push_str(&format!(
                    "<text id=\"i{}\" font-family=\"-apple-system, system-ui, sans-serif\" font-size=\"{}\" fill=\"#1c1c1e\">",
                    i.id,
                    fmt_num(line_h / TEXT_LINE_HEIGHT)
                ));
                for (k, l) in lines.iter().enumerate() {
                    out.push_str(&format!(
                        "<tspan x=\"{}\" y=\"{}\">{}</tspan>",
                        fmt_num(i.x),
                        fmt_num(i.y + line_h * (k as f64 + 0.8)),
                        xml_escape(l)
                    ));
                }
                out.push_str("</text>\n");
                continue;
            }
            let href = match (embed_data, doc.assets.get(&i.file)) {
                (true, Some(bytes)) => format!("data:{};base64,{}", image_mime(&i.file), base64(bytes)),
                _ => xml_escape(&i.file),
            };
            out.push_str(&format!(
                "<image id=\"i{}\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" preserveAspectRatio=\"none\" href=\"{}\"/>\n",
                i.id,
                fmt_num(i.x),
                fmt_num(i.y),
                fmt_num(i.w),
                fmt_num(i.h),
                href
            ));
        }
        out.push_str("</g>\n");
    }
    // Highlighter sits underneath ink, matching the on-screen renderer.
    for (group, highlight) in [("highlights", true), ("ink", false)] {
        out.push_str(&format!("<g id=\"{group}\">\n"));
        for s in doc.strokes().iter().filter(|s| (s.brush.kind == BrushKind::Highlighter) == highlight) {
            // The preview is a thumbnail: a coarser outline is plenty and
            // keeps saving fast. The full SVG export keeps every detail.
            let samples = if embed_data { tessellate::samples(s) } else { tessellate::samples_coarse(s, 4.0) };
            if samples.is_empty() {
                continue;
            }
            let opacity = samples.iter().map(|s| s.opacity as f64).sum::<f64>() / samples.len() as f64;
            let decimals = if embed_data { 2 } else { PREVIEW_DECIMALS };
            let d: String = tessellate::outlines_for(s, &samples).iter().map(|o| path_data(o, decimals)).collect();
            out.push_str(&format!("<path id=\"s{}\" d=\"{}\" fill=\"{}\"", s.id, d, s.brush.color.to_hex_rgb()));
            if opacity < 0.999 {
                out.push_str(&format!(" fill-opacity=\"{}\"", round(opacity, 3)));
            }
            out.push_str("/>\n");
        }
        out.push_str("</g>\n");
    }
    out.push_str("</svg>\n");
    out
}

/// Line height of text boxes, as a multiple of the font size.
pub const TEXT_LINE_HEIGHT: f64 = 1.3;

/// The media type of a picture file, from its extension.
pub fn image_mime(file: &str) -> &'static str {
    let ext = file.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// An SVG file read as XML, or None if it is not well formed (cut short,
/// say). DTDs are allowed, as some drawing programs write one.
fn parse_svg(svg: &str) -> Option<roxmltree::Document<'_>> {
    let options = roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() };
    roxmltree::Document::parse_with_options(svg, options).ok()
}

/// Extract the JSON payload from a Bedrock SVG.
pub fn extract_json(svg: &str) -> Option<Cow<'_, str>> {
    json_in(parse_svg(svg).as_ref(), svg)
}

/// The note JSON in `<metadata id="bedrock-note">`. Read as XML, so a file
/// another program re-saved (other quotes, attribute order, escaped text in
/// place of CDATA) still opens; read as plain text when the file is not
/// well formed XML, so one cut short still gives its note, which comes
/// first.
fn json_in<'a>(xml: Option<&roxmltree::Document<'_>>, svg: &'a str) -> Option<Cow<'a, str>> {
    if let Some(xml) = xml {
        let meta = xml.descendants().find(|n| n.has_tag_name("metadata") && n.attribute("id") == Some(FORMAT_NAME))?;
        let text: String = meta.children().filter_map(|c| c.text()).collect();
        return Some(Cow::Owned(text.trim().to_string()));
    }
    let start = svg.find(METADATA_OPEN)? + METADATA_OPEN.len();
    let rest = svg[start..].trim_start();
    let rest = rest.strip_prefix("<![CDATA[")?;
    let end = rest.find("]]>")?;
    Some(Cow::Borrowed(&rest[..end]))
}

/// Load either a Bedrock SVG or bare note JSON.
pub fn load(text: &str, seed: u64) -> Result<Loaded, FormatError> {
    let t = text.trim_start_matches('\u{feff}').trim_start();
    if t.starts_with('{') {
        from_json(t, seed)
    } else {
        let xml = parse_svg(t);
        let json = json_in(xml.as_ref(), t).ok_or(FormatError::NotABedrockNote)?;
        let mut loaded = from_json(&json, seed)?;
        pictures_from_svg(xml.as_ref(), t, &mut loaded);
        Ok(loaded)
    }
}

/// The SVG export embeds each picture's file in its `<image>` as a
/// `data:` URL; give those files back so a re-saved note keeps them.
fn pictures_from_svg(xml: Option<&roxmltree::Document<'_>>, svg: &str, loaded: &mut Loaded) {
    let wanted: Vec<(StrokeId, String)> = loaded
        .doc
        .images()
        .iter()
        .filter(|i| i.text.is_none() && !i.file.is_empty() && !loaded.doc.assets.contains_key(&i.file))
        .map(|i| (i.id, i.file.clone()))
        .collect();
    if wanted.is_empty() {
        return;
    }
    // `href` or `xlink:href`, by the picture's id.
    let hrefs: HashMap<&str, &str> = match xml {
        Some(xml) => xml
            .descendants()
            .filter(|n| n.has_tag_name("image"))
            .filter_map(|n| Some((n.attribute("id")?, n.attributes().find(|a| a.name() == "href")?.value())))
            .collect(),
        None => HashMap::new(),
    };
    for (id, file) in wanted {
        let key = format!("i{id}");
        let href = match xml {
            Some(_) => hrefs.get(key.as_str()).copied(),
            None => svg.find(&format!("<image id=\"{key}\"")).and_then(|at| {
                let tag = &svg[at..at + svg[at..].find('>').unwrap_or(svg.len() - at)];
                tag.split("href=\"").nth(1).and_then(|h| h.split('"').next())
            }),
        };
        let Some(data) = href.and_then(|h| h.strip_prefix("data:")) else { continue };
        match data.split_once(";base64,").and_then(|(_, b)| unbase64(b.trim())) {
            Some(bytes) => {
                loaded.doc.assets.insert(file, bytes);
            }
            None => loaded.warnings.push(format!("the picture {file} embedded in the SVG is damaged and was left out")),
        }
    }
}

/// Standard base64, with or without its `=` padding (other tools that
/// re-save an SVG do not always keep it).
fn unbase64(text: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::STANDARD_NO_PAD;
    STANDARD_NO_PAD.decode(text.trim_end_matches('=')).ok()
}

// ----- .bedrock container ---------------------------------------------------

pub const NOTE_JSON: &str = "note.json";
pub const RECOGNIZED_JSON: &str = "recognized.json";
pub const PREVIEW_SVG: &str = "preview.svg";
pub const README_TXT: &str = "README.txt";
pub const LINKS_MD: &str = "links.md";
/// Folder of picture files in a `.bedrock`.
pub const IMAGES_DIR: &str = "images/";

const README: &str = "This is a Bedrock note: an ordinary ZIP archive.\n\n\
preview.svg      the note as a picture; opens in any web browser\n\
note.json        every pen stroke: brush, times, and which channels it records\n\
points.bin       the raw samples of those strokes (x, y, pressure, tilt, time), in a\n\
                 small binary form described in the format document\n\
recognized.json  text recognised from the handwriting, linked to stroke ids\n\
links.md         the note's links as Markdown ([[Note]] and [text](https://...))\n\
images/          pictures placed on the page, as ordinary image files\n\n\
The format is documented at https://github.com/ReelPlum/Bedrock/blob/main/docs/note-format.md\n";

/// Recognition output lives in its own file so it can never corrupt ink.
pub fn recognition_json(doc: &Document) -> String {
    serde_json::json!({
        "format": "bedrock-recognition",
        "version": FORMAT_VERSION,
        "items": doc.recognition,
    })
    .to_string()
}

/// The note's links as Markdown, one per line: `[[Name]]` for notes (the
/// form Obsidian's graph understands) and `[text](url)` for web addresses.
/// The authoritative copy is `links` in note.json, tied to the strokes.
pub fn links_markdown(doc: &Document) -> String {
    let mut out = format!("# Links in {}\n\n", if doc.title.is_empty() { "this note" } else { &doc.title });
    let esc = |t: &str| t.replace('[', "\\[").replace(']', "\\]");
    for l in doc.live_links() {
        let text = l.text.as_deref().filter(|t| !t.is_empty());
        let line = match l.kind.as_str() {
            "note" => match text {
                Some(t) if t != l.target => format!("[[{}|{}]]", l.target, esc(t)),
                _ => format!("[[{}]]", l.target),
            },
            _ => format!("[{}](<{}>)", esc(text.unwrap_or(&l.target)), l.target),
        };
        out.push_str(&format!("- {line}\n"));
    }
    out
}

/// Name of the binary samples entry in a `.bedrock` (see [`points_bin`]).
pub const POINTS_BIN: &str = "points.bin";

fn points_channels() -> Vec<points_bin::Channel> {
    CHANNELS
        .iter()
        .zip(CHANNEL_DECIMALS)
        .map(|(n, d)| points_bin::Channel { name: n.to_string(), decimals: d })
        .collect()
}

/// Note JSON without the recognition block (which goes to `recognized.json`),
/// and `points.bin`: each stroke's samples move from `note.json` into the
/// binary file when every value can be stored there exactly, which is
/// always for what Bedrock writes. A stroke whose values could not keeps
/// them in `note.json`.
fn note_json_for_container(doc: &Document) -> (String, Option<Vec<u8>>) {
    let mut records = Vec::new();
    let mut root = json_value_with(doc, false, Some(&mut records));
    let channels = points_channels();
    let bin = (!records.is_empty()).then(|| {
        root.insert("version".into(), CONTAINER_VERSION.into());
        root.insert("pointsFile".into(), POINTS_BIN.into());
        points_bin::encode(&channels, &records)
    });
    (serde_json::to_string(&Value::Object(root)).expect("json"), bin)
}

/// Put the samples from `points.bin` back into the strokes of `note.json`
/// that have none, in order, so the rest of reading is the same for every
/// version. Problems become warnings; a stroke left without samples is then
/// reported and skipped like any damaged stroke.
fn attach_points(root: &mut Value, bin: Option<&[u8]>, warnings: &mut Vec<String>) {
    let Some(obj) = root.as_object_mut() else { return };
    let Some(file) = obj.get("pointsFile").and_then(Value::as_str).map(str::to_string) else { return };
    let decoded = match bin.map(points_bin::decode) {
        Some(Ok(d)) => d,
        Some(Err(e)) => {
            warnings.push(format!("{file} is damaged ({e}); its ink could not be read"));
            return;
        }
        None => {
            warnings.push(format!("{file} is missing; its ink could not be read"));
            return;
        }
    };
    let names: Vec<String> = match obj.get("channels") {
        Some(c) => serde_json::from_value(c.clone()).unwrap_or_default(),
        None => CHANNELS.iter().map(|s| s.to_string()).collect(),
    };
    if decoded.channels.iter().map(|c| &c.name).ne(names.iter()) {
        warnings.push(format!("{file} does not match the channels in note.json; its ink could not be read"));
        return;
    }
    let mut records = decoded.strokes.into_iter();
    if let Some(Value::Array(strokes)) = obj.get_mut("strokes") {
        for s in strokes.iter_mut().filter_map(Value::as_object_mut).filter(|s| !s.contains_key("points")) {
            match records.next() {
                Some(r) => {
                    s.insert("points".into(), r.into_iter().map(Value::from).collect::<Vec<_>>().into());
                }
                None => break,
            }
        }
    }
    let left = records.count();
    if left > 0 {
        warnings.push(format!("{file} holds {left} more strokes than note.json names; they were left out"));
    }
}

/// SVG preview without the embedded data (the container already has it).
pub fn to_preview_svg(doc: &Document) -> String {
    svg_with(doc, false)
}

/// Write a `.bedrock` file (ZIP: note.json, recognized.json, links.md,
/// preview.svg, README.txt).
pub fn to_bedrock(doc: &Document) -> Vec<u8> {
    to_bedrock_at(doc, crate::zip::SAVE_LEVEL)
}

/// [`to_bedrock`] compressed for a file that leaves the device: the same
/// entries, a little smaller, slower to write.
pub fn to_bedrock_for_sharing(doc: &Document) -> Vec<u8> {
    to_bedrock_at(doc, crate::zip::SHARE_LEVEL)
}

fn to_bedrock_at(doc: &Document, level: i64) -> Vec<u8> {
    let (note, points) = note_json_for_container(doc);
    let rec = recognition_json(doc);
    let preview = to_preview_svg(doc);
    let links = links_markdown(doc);
    let mut files: Vec<(&str, &[u8])> = vec![(NOTE_JSON, note.as_bytes())];
    if let Some(p) = &points {
        files.push((POINTS_BIN, p));
    }
    files.extend([
        (RECOGNIZED_JSON, rec.as_bytes()),
        (LINKS_MD, links.as_bytes()),
        (PREVIEW_SVG, preview.as_bytes()),
        (README_TXT, README.as_bytes()),
    ]);
    files.extend(doc.used_assets());
    crate::zip::write_at(&files, level)
}

/// Load any supported file: `.bedrock` (ZIP), Bedrock SVG, or note JSON.
pub fn load_bytes(bytes: &[u8], seed: u64) -> Result<Loaded, FormatError> {
    if !crate::zip::is_zip(bytes) {
        let text = std::str::from_utf8(bytes).map_err(|_| FormatError::NotABedrockNote)?;
        return load(text, seed);
    }
    let (files, problems) = crate::zip::read(bytes).map_err(|e| FormatError::Invalid(e.to_string()))?;
    let find = |n: &str| files.iter().find(|(name, _)| name == n || name.ends_with(&format!("/{n}"))).map(|(_, d)| d);
    let mut loaded = match find(NOTE_JSON) {
        Some(d) => {
            let mut root: Value =
                serde_json::from_str(&String::from_utf8_lossy(d)).map_err(|e| FormatError::Json(e.to_string()))?;
            let mut warnings = Vec::new();
            let file = root.get("pointsFile").and_then(Value::as_str).map(str::to_string);
            attach_points(&mut root, file.as_deref().and_then(&find).map(|d| d.as_slice()), &mut warnings);
            from_value(root, warnings, seed)?
        }
        None => {
            // note.json is damaged: fall back to the data embedded in an SVG, if any.
            let svg = find(PREVIEW_SVG).map(|d| String::from_utf8_lossy(d).into_owned());
            match svg.as_deref().and_then(extract_json) {
                Some(j) => from_json(&j, seed)?,
                None => {
                    return Err(FormatError::Invalid(format!(
                        "note.json is missing or damaged ({})",
                        problems.join("; ")
                    )))
                }
            }
        }
    };
    loaded.warnings.extend(problems);
    for (name, data) in &files {
        if let Some(i) = name.find(IMAGES_DIR) {
            loaded.doc.assets.insert(name[i..].to_string(), data.clone());
        }
    }
    for i in loaded.doc.images().iter().filter(|i| i.text.is_none()) {
        if !loaded.doc.assets.contains_key(&i.file) {
            loaded.warnings.push(format!("the picture {} is missing from the note", i.file));
        }
    }
    if let Some(d) = find(RECOGNIZED_JSON) {
        let parsed = serde_json::from_slice::<Value>(d)
            .ok()
            .and_then(|v| v.get("items").cloned())
            .and_then(|items| serde_json::from_value::<Vec<RecognizedText>>(items).ok());
        match parsed {
            Some(items) => loaded.doc.recognition = items,
            None => loaded.warnings.push("recognized.json is damaged and was ignored".into()),
        }
    }
    Ok(loaded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_doc() -> Document {
        let mut d = Document::new(5);
        d.title = "Maths <homework> & \"notes\" ]]>".into();
        d.created = 1_731_000_000_000.0;
        d.modified = 1_731_000_100_000.0;
        d.paper = "grid".into();
        for (i, kind) in BrushKind::ALL.into_iter().enumerate() {
            let id = d.next_id();
            let pts = (0..8)
                .map(|k| {
                    InputPoint::new(i as f64 * 30.0 + k as f64 * 3.3, k as f64 * 1.7, 0.1 * k as f32)
                        .with_tilt(0.9, 1.2)
                        .at(k as f64 * 4.2)
                })
                .collect();
            let mut s = Stroke::new(
                id,
                Brush::new(kind, Rgba::rgb(10, 20, 200), 3.0),
                1_731_000_000_500.0 + i as f64,
                InputDevice::Pen,
                pts,
            );
            if i == 2 {
                s.derived_from = vec![StrokeId(77)];
            }
            d.add_stroke(s);
        }
        let first = d.strokes()[0].id;
        d.recognition.push(RecognizedText {
            id: "r1".into(),
            text: "x²".into(),
            strokes: vec![first],
            alternatives: vec!["x2".into()],
            confidence: Some(0.8),
            language: Some("en".into()),
            engine: Some("test".into()),
        });
        d
    }

    fn assert_same(a: &Document, b: &Document) {
        assert_eq!(a.title, b.title);
        assert_eq!(a.created, b.created);
        assert_eq!(a.background, b.background);
        assert_eq!(a.paper, b.paper);
        assert_eq!(a.len(), b.len());
        assert_eq!(a.recognition, b.recognition);
        for (x, y) in a.strokes().iter().zip(b.strokes()) {
            assert_eq!(x.id, y.id);
            assert_eq!(x.brush, y.brush);
            assert_eq!(x.start_time, y.start_time);
            assert_eq!(x.derived_from, y.derived_from);
            assert_eq!(x.points.len(), y.points.len());
            for (p, q) in x.points.iter().zip(&y.points) {
                assert!((p.x - q.x).abs() <= 0.005 && (p.y - q.y).abs() <= 0.005);
                assert!((p.pressure - q.pressure).abs() <= 0.0005);
                assert!((p.altitude - q.altitude).abs() <= 0.0005);
                assert!((p.t - q.t).abs() <= 0.05);
            }
        }
    }

    #[test]
    fn json_roundtrip() {
        let d = sample_doc();
        let back = from_json(&to_json(&d), 1).unwrap().doc;
        assert_same(&d, &back);
    }

    #[test]
    fn svg_roundtrip_and_is_viewable() {
        let d = sample_doc();
        let svg = to_svg(&d);
        assert!(svg.starts_with("<?xml"));
        assert!(svg.contains("<svg xmlns=\"http://www.w3.org/2000/svg\""));
        assert_eq!(svg.matches("<path ").count(), d.len());
        assert!(svg.contains("<title>Maths &lt;homework&gt; &amp; &quot;notes&quot; ]]&gt;</title>"));
        let back = load(&svg, 1).unwrap().doc;
        assert_same(&d, &back);
    }

    /// Regression: a title containing "]]>" must not terminate the CDATA block.
    #[test]
    fn cdata_terminator_in_text_is_escaped() {
        let d = sample_doc();
        let svg = to_svg(&d);
        let json = extract_json(&svg).unwrap();
        assert!(!json.contains("]]>"));
        assert_eq!(from_json(&json, 0).unwrap().doc.title, d.title);
    }

    #[test]
    fn highlighter_paths_come_first() {
        let svg = to_svg(&sample_doc());
        let hl = svg.find("<g id=\"highlights\">").unwrap();
        let ink = svg.find("<g id=\"ink\">").unwrap();
        assert!(hl < ink);
        assert_eq!(svg[hl..ink].matches("<path ").count(), 1);
    }

    #[test]
    fn empty_document_roundtrips() {
        let d = Document::new(1);
        let back = load(&to_svg(&d), 2).unwrap().doc;
        assert!(back.is_empty());
    }

    #[test]
    fn unknown_fields_are_preserved() {
        let json = r##"{"format":"bedrock-note","version":2,"strokes":[],"layers":[{"name":"a"}]}"##;
        let d = from_json(json, 0).unwrap().doc;
        let out = to_json(&d);
        assert!(out.contains(r##""layers":[{"name":"a"}]"##));
    }

    #[test]
    fn custom_channel_order_and_missing_channels() {
        let json = r##"{"format":"bedrock-note","version":1,"channels":["t","y","x"],
            "strokes":[{"id":"00000000000000aa","brush":{"kind":"pen","color":"#000000ff","size":2},"points":[0,5,1, 4,6,2]}]}"##;
        let d = from_json(json, 0).unwrap().doc;
        let s = &d.strokes()[0];
        assert_eq!(s.points[1].x, 2.0);
        assert_eq!(s.points[1].y, 6.0);
        assert_eq!(s.points[1].t, 4.0);
        assert_eq!(s.points[1].pressure, 0.5);
    }

    #[test]
    fn rejects_files_that_are_not_notes() {
        assert_eq!(load("<svg></svg>", 0).unwrap_err(), FormatError::NotABedrockNote);
        assert_eq!(load(r##"{"format":"other"}"##, 0).unwrap_err(), FormatError::NotABedrockNote);
        assert!(matches!(load("{nope", 0), Err(FormatError::Json(_))));
        assert!(load_bytes(&[0xff, 0xfe, 0x00], 0).is_err());
    }

    #[test]
    fn damaged_strokes_are_skipped_not_fatal() {
        let json = r##"{"format":"bedrock-note","version":1,"strokes":[
            {"id":"1","brush":{"kind":"pen","color":"#000","size":2},"points":[1,2,0.5,1.5,0,0, 9]},
            {"id":"1","brush":{"kind":"pen","color":"#000","size":2},"points":[3,4,0.5,1.5,0,0]},
            {"id":"2","brush":{"kind":"laser","color":"#000","size":2},"points":[]},
            {"id":"3","brush":{"kind":"pen","color":"#000","size":-1},"points":[5,6,0.5,1.5,0,0]}
        ]}"##;
        let l = load(json, 0).unwrap();
        assert_eq!(l.doc.len(), 3, "the unknown brush stroke is skipped, the others kept");
        assert_eq!(l.doc.strokes()[0].points.len(), 1, "incomplete trailing sample dropped");
        assert_ne!(l.doc.strokes()[0].id, l.doc.strokes()[1].id, "duplicate id replaced");
        assert!(l.doc.strokes()[2].brush.size > 0.0);
        assert_eq!(l.warnings.len(), 4, "{:?}", l.warnings);
    }

    #[test]
    fn newer_version_loads_with_warning() {
        let l = load(r##"{"format":"bedrock-note","version":99,"strokes":[]}"##, 0).unwrap();
        assert_eq!(l.warnings.len(), 1);
    }

    #[test]
    fn bedrock_container_roundtrip() {
        let d = sample_doc();
        let bytes = to_bedrock(&d);
        let (files, problems) = crate::zip::read(&bytes).unwrap();
        assert!(problems.is_empty());
        let names: Vec<_> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec![NOTE_JSON, POINTS_BIN, RECOGNIZED_JSON, LINKS_MD, PREVIEW_SVG, README_TXT]);
        let note = String::from_utf8(files[0].1.clone()).unwrap();
        assert!(!note.contains("\"recognition\""), "recognition lives in its own file");
        let preview = String::from_utf8(files[4].1.clone()).unwrap();
        assert!(!preview.contains("<metadata"));
        assert_eq!(preview.matches("<path ").count(), d.len());
        let l = load_bytes(&bytes, 3).unwrap();
        assert!(l.warnings.is_empty(), "{:?}", l.warnings);
        assert_same(&d, &l.doc);
    }

    fn entry(bytes: &[u8], name: &str) -> Option<Vec<u8>> {
        crate::zip::read(bytes).unwrap().0.into_iter().find(|(n, _)| n == name).map(|(_, d)| d)
    }

    #[test]
    fn samples_are_kept_in_points_bin_and_come_back_bit_for_bit() {
        let d = sample_doc();
        let bytes = to_bedrock(&d);
        let note: Value = serde_json::from_slice(&entry(&bytes, NOTE_JSON).unwrap()).unwrap();
        assert_eq!(note["version"], CONTAINER_VERSION);
        assert_eq!(note["pointsFile"], POINTS_BIN);
        assert!(note["strokes"].as_array().unwrap().iter().all(|s| s.get("points").is_none()));
        assert!(entry(&bytes, POINTS_BIN).is_some());
        let l = load_bytes(&bytes, 3).unwrap();
        assert!(l.warnings.is_empty(), "{:?}", l.warnings);
        // Exactly the JSON the note would write with every sample inline.
        assert_eq!(to_json(&l.doc), to_json(&d));
        // And the plain exports still hold every sample as JSON, version 1.
        let plain: Value = serde_json::from_str(&to_json(&l.doc)).unwrap();
        assert_eq!(plain["version"], FORMAT_VERSION);
        assert!(plain.get("pointsFile").is_none());
        assert!(plain["strokes"].as_array().unwrap().iter().all(|s| s["points"].is_array()));
    }

    #[test]
    fn a_stroke_points_bin_cannot_hold_exactly_stays_in_note_json() {
        let mut d = sample_doc();
        let far = Stroke::new(
            d.next_id(),
            Brush::default(),
            1.0,
            InputDevice::Pen,
            vec![InputPoint::new(1e14, 2.0, 0.5).at(0.0), InputPoint::new(1e14 + 1.0, 3.0, 0.5).at(4.0)],
        );
        let mut strokes = d.strokes().to_vec();
        strokes.insert(1, far);
        d.set_strokes(strokes);
        let bytes = to_bedrock(&d);
        let note: Value = serde_json::from_slice(&entry(&bytes, NOTE_JSON).unwrap()).unwrap();
        let with_points: Vec<bool> =
            note["strokes"].as_array().unwrap().iter().map(|s| s.get("points").is_some()).collect();
        assert_eq!(with_points.iter().filter(|p| **p).count(), 1, "only the far stroke: {with_points:?}");
        assert!(with_points[1]);
        let l = load_bytes(&bytes, 3).unwrap();
        assert!(l.warnings.is_empty(), "{:?}", l.warnings);
        assert_eq!(to_json(&l.doc), to_json(&d));
    }

    #[test]
    fn a_damaged_points_bin_is_reported_and_never_panics() {
        let d = sample_doc();
        let (note, points) = note_json_for_container(&d);
        let mut points = points.unwrap();
        points.truncate(points.len() - 3);
        let bytes = crate::zip::write(&[(NOTE_JSON, note.as_bytes()), (POINTS_BIN, &points)]);
        let l = load_bytes(&bytes, 0).unwrap();
        assert!(l.warnings.iter().any(|w| w.contains("points.bin is damaged")), "{:?}", l.warnings);
        let missing = crate::zip::write(&[(NOTE_JSON, note.as_bytes())]);
        let l = load_bytes(&missing, 0).unwrap();
        assert!(l.warnings.iter().any(|w| w.contains("points.bin is missing")), "{:?}", l.warnings);
    }

    #[test]
    fn a_note_for_sharing_holds_the_same_entries_and_is_smaller() {
        let mut d = sample_doc();
        let many: Vec<Stroke> = (0..60)
            .map(|i| {
                let pts = (0..80)
                    .map(|k| {
                        InputPoint::new(i as f64 * 7.0 + (k as f64 * 0.3).sin() * 20.0, k as f64 * 1.7, 0.5)
                            .at(k as f64 * 4.2)
                    })
                    .collect();
                Stroke::new(d.next_id(), Brush::default(), i as f64 * 1000.0, InputDevice::Pen, pts)
            })
            .collect();
        d.set_strokes(many);
        let fast = to_bedrock(&d);
        let small = to_bedrock_for_sharing(&d);
        assert!(small.len() < fast.len(), "{} < {}", small.len(), fast.len());
        assert_eq!(crate::zip::read(&small).unwrap(), crate::zip::read(&fast).unwrap());
    }

    #[test]
    fn the_preview_draws_outlines_to_a_tenth_of_a_unit() {
        let d = sample_doc();
        let preview = String::from_utf8(entry(&to_bedrock(&d), PREVIEW_SVG).unwrap()).unwrap();
        let d_attrs: String = preview.split(" d=\"").skip(1).map(|p| p.split('"').next().unwrap()).collect();
        assert!(!d_attrs.is_empty());
        assert!(
            d_attrs
                .split(|c: char| !(c.is_ascii_digit() || c == '.'))
                .all(|n| n.split('.').nth(1).is_none_or(|f| f.len() <= 1)),
            "{d_attrs}"
        );
        assert!(to_svg(&d).contains('.'), "the full SVG export keeps finer outlines");
    }

    #[test]
    fn damaged_recognition_never_loses_ink() {
        let d = sample_doc();
        let (note, points) = note_json_for_container(&d);
        let points = points.expect("the sample has ink");
        let bytes =
            crate::zip::write(&[(NOTE_JSON, note.as_bytes()), (POINTS_BIN, &points), (RECOGNIZED_JSON, b"{garbage")]);
        let l = load_bytes(&bytes, 0).unwrap();
        assert_eq!(l.doc.len(), d.len());
        assert!(l.doc.recognition.is_empty());
        assert_eq!(l.warnings.len(), 1);
    }

    #[test]
    fn svg_and_json_files_load_through_load_bytes() {
        let d = sample_doc();
        assert_eq!(load_bytes(to_svg(&d).as_bytes(), 0).unwrap().doc.len(), d.len());
        assert_eq!(load_bytes(to_json(&d).as_bytes(), 0).unwrap().doc.len(), d.len());
    }

    /// Fuzz-style robustness: flipping, cutting or adding bytes anywhere in
    /// a saved note must never panic; it either loads (maybe with warnings)
    /// or returns an error. `proptest` picks the damage, several changes at
    /// a time, and shrinks a failure to the smallest damage that causes it.
    #[test]
    fn corrupted_files_never_panic() {
        use proptest::prelude::*;
        use proptest::test_runner::{Config, TestRunner};
        let d = sample_doc();
        let inputs = [to_bedrock(&d), to_svg(&d).into_bytes(), to_json(&d).into_bytes()];
        // (which change, where as a share of the file, the byte to use)
        let damage = prop::collection::vec((0..3u8, 0.0f64..1.0, any::<u8>()), 1..4);
        let mut runner = TestRunner::new(Config { cases: 400, failure_persistence: None, ..Config::default() });
        runner
            .run(&(0..inputs.len(), damage), |(which, damage)| {
                let mut b = inputs[which].clone();
                for (kind, at, byte) in damage {
                    if b.is_empty() {
                        break;
                    }
                    let i = ((at * b.len() as f64) as usize).min(b.len() - 1);
                    match kind {
                        0 => b[i] ^= byte.max(1),
                        1 => b.truncate(i),
                        _ => b.insert(i, byte),
                    }
                }
                let _ = load_bytes(&b, 0);
                Ok(())
            })
            .unwrap();
    }

    /// Regression: saving a note that was just opened must not change it
    /// (stroke start times drifted by 0.0001 ms between save cycles).
    #[test]
    fn save_load_save_is_stable() {
        let mut d = sample_doc();
        let id = d.next_id();
        d.add_stroke(Stroke::new(
            id,
            Brush::default(),
            1_794_172_851_973.900_1,
            InputDevice::Pen,
            vec![InputPoint::new(1.0, 2.0, 0.5)],
        ));
        let once = to_json(&d);
        let twice = to_json(&from_json(&once, 0).unwrap().doc);
        assert_eq!(once, twice);
    }

    #[test]
    fn word_groups_are_saved_while_their_strokes_exist() {
        let mut d = sample_doc();
        let ids: Vec<_> = d.strokes().iter().map(|s| s.id).collect();
        assert!(ids.len() >= 2);
        d.group(&ids[..2]);
        let back = load_bytes(&to_bedrock(&d), 1).unwrap();
        assert!(back.warnings.is_empty(), "{:?}", back.warnings);
        assert_eq!(back.doc.live_groups(), vec![ids[..2].to_vec()]);
        assert!(!back.doc.extra.contains_key("groups"));
        d.replace(&ids[..1], vec![]);
        assert!(!to_json(&d).contains("\"groups\""), "a group whose strokes are gone is dropped");
    }

    #[test]
    fn number_formatting() {
        assert_eq!(fmt_num(1.0), "1");
        assert_eq!(fmt_num(-0.001), "0");
        assert_eq!(fmt_num(2.345), "2.35");
        assert_eq!(fmt_num(-12.5), "-12.5");
    }

    #[test]
    fn positions_survive_saving_at_full_zoom_precision() {
        use crate::camera::{MAX_ZOOM, WORLD_LIMIT};
        let mut doc = Document::new(5);
        let id = doc.next_id();
        let pts: Vec<InputPoint> = (0..20)
            .map(|i| {
                InputPoint::new(WORLD_LIMIT - 1.0 - i as f64 * 0.0137, -WORLD_LIMIT + 3.0 + i as f64 * 0.0291, 0.5)
            })
            .collect();
        doc.add_stroke(Stroke::new(id, Brush::default(), 0.0, InputDevice::Pen, pts.clone()));
        let back = load_bytes(&to_bedrock(&doc), 1).unwrap().doc;
        for (a, b) in pts.iter().zip(&back.strokes()[0].points) {
            let screen_px = a.pos().distance(b.pos()) * MAX_ZOOM;
            assert!(screen_px < 0.02, "a point moved {screen_px} px at full zoom");
        }
    }

    #[test]
    fn pictures_round_trip_in_a_bedrock_file_as_plain_image_files() {
        let mut d = sample_doc();
        let png = vec![0x89, b'P', b'N', b'G', 1, 2, 3, 4];
        let r = crate::geom::Rect::new(crate::geom::Vec2::new(10.0, 20.0), crate::geom::Vec2::new(110.0, 70.0));
        let id = d.add_image("images/abc.png", Some(png.clone()), r);
        // A file no picture uses any more is not saved.
        d.assets.insert("images/old.png".into(), vec![9]);
        let bytes = to_bedrock(&d);
        let (files, _) = crate::zip::read(&bytes).unwrap();
        assert!(files.iter().any(|(n, b)| n == "images/abc.png" && *b == png), "stored as is");
        assert!(!files.iter().any(|(n, _)| n == "images/old.png"));
        let back = load_bytes(&bytes, 1).unwrap();
        assert!(back.warnings.is_empty(), "{:?}", back.warnings);
        let img = back.doc.image(id).unwrap();
        assert_eq!((img.file.as_str(), img.x, img.y, img.w, img.h), ("images/abc.png", 10.0, 20.0, 100.0, 50.0));
        assert_eq!(back.doc.assets.get("images/abc.png"), Some(&png));
        // The SVG export embeds it; the preview refers to the file.
        assert!(to_svg(&d).contains("href=\"data:image/png;base64,iVBORwECAwQ=\""));
        assert!(to_preview_svg(&d).contains("href=\"images/abc.png\""));
    }

    #[test]
    fn an_svg_export_gives_its_pictures_back_when_opened() {
        let mut d = sample_doc();
        let png = vec![0x89, b'P', b'N', b'G', 1, 2, 3, 4, 5];
        let jpg = vec![0xff, 0xd8, 0xff, 7];
        let r = crate::geom::Rect::new(crate::geom::Vec2::new(10.0, 20.0), crate::geom::Vec2::new(110.0, 70.0));
        let a = d.add_image("images/abc.png", Some(png.clone()), r);
        let b = d.add_image("images/def.jpg", Some(jpg.clone()), r);
        let back = load(&to_svg(&d), 1).unwrap();
        assert!(back.warnings.is_empty(), "{:?}", back.warnings);
        assert_eq!(back.doc.assets.get("images/abc.png"), Some(&png), "the picture embedded in the SVG");
        assert_eq!(back.doc.assets.get("images/def.jpg"), Some(&jpg));
        assert_eq!(back.doc.image(a).unwrap().file, "images/abc.png");
        assert_eq!(back.doc.image(b).unwrap().file, "images/def.jpg");
        // Saving it as a .bedrock file keeps the picture files.
        let (files, _) = crate::zip::read(&to_bedrock(&back.doc)).unwrap();
        assert!(files.iter().any(|(n, f)| n == "images/abc.png" && *f == png));
        // A damaged embedded picture is left out, with a warning, and the note still opens.
        let broken = to_svg(&d).replace("base64,iVBORwECAwQF", "base64,!!!");
        let l = load(&broken, 1).unwrap();
        assert!(!l.doc.assets.contains_key("images/abc.png"));
        assert_eq!(l.doc.assets.get("images/def.jpg"), Some(&jpg));
        assert!(l.warnings.iter().any(|w| w.contains("images/abc.png")), "{:?}", l.warnings);
    }

    #[test]
    fn an_svg_resaved_by_another_tool_still_opens() {
        // Drawing programs that re-save an SVG keep its content but not its
        // spelling: quotes, attribute order, line breaks, CDATA written out
        // as escaped text, and `xlink:href` for pictures.
        let mut d = sample_doc();
        d.title = "Notes <draft> & \"ideas\"".into();
        let png = vec![0x89, b'P', b'N', b'G', 1, 2, 3, 4, 5];
        let r = crate::geom::Rect::new(crate::geom::Vec2::new(10.0, 20.0), crate::geom::Vec2::new(110.0, 70.0));
        let id = d.add_image("images/abc.png", Some(png.clone()), r);
        let svg = to_svg(&d);
        let json = extract_json(&svg).unwrap().to_string();
        let resaved = svg
            .replace(
                "<svg xmlns=\"http://www.w3.org/2000/svg\"",
                "<svg xmlns:xlink=\"http://www.w3.org/1999/xlink\" xmlns=\"http://www.w3.org/2000/svg\"",
            )
            .replace(
                &format!("{METADATA_OPEN}<![CDATA[{json}]]></metadata>"),
                &format!("<metadata\n     id='bedrock-note'>{}</metadata>", xml_escape(&json)),
            )
            .replace(&format!("<image id=\"i{id}\""), &format!("<image\n  data-x=\"1\" id='i{id}'"))
            .replace(" href=\"data:", " xlink:href=\"data:");
        assert_ne!(resaved, svg);
        let back = load(&resaved, 1).unwrap();
        assert!(back.warnings.is_empty(), "{:?}", back.warnings);
        assert_eq!(back.doc.title, d.title);
        assert_eq!(back.doc.strokes().len(), d.strokes().len());
        assert_eq!(back.doc.assets.get("images/abc.png"), Some(&png), "the picture embedded in the SVG");
        // A file cut short still gives its note, which comes first.
        let cut = &svg[..svg.find("<g id=\"ink\">").unwrap()];
        assert_eq!(load(cut, 1).unwrap().doc.strokes().len(), d.strokes().len());
    }

    #[test]
    fn a_missing_picture_file_is_reported_and_the_note_still_opens() {
        let mut d = sample_doc();
        let r = crate::geom::Rect::new(crate::geom::Vec2::ZERO, crate::geom::Vec2::new(10.0, 10.0));
        d.add_image("images/x.png", None, r);
        let back = load_bytes(&to_bedrock(&d), 1).unwrap();
        assert_eq!(back.doc.images().len(), 1);
        assert!(back.warnings.iter().any(|w| w.contains("images/x.png")), "{:?}", back.warnings);
    }

    #[test]
    fn text_boxes_round_trip_and_export_as_svg_text() {
        let mut d = sample_doc();
        let r = crate::geom::Rect::new(crate::geom::Vec2::new(0.0, 0.0), crate::geom::Vec2::new(200.0, 52.0));
        let id = d.add_text("Hello <you>\nsecond line", r);
        let json: Value = serde_json::from_str(&to_json(&d)).unwrap();
        assert_eq!(json["texts"][0]["text"], "Hello <you>\nsecond line");
        assert!(json.get("images").is_none(), "text boxes are not pictures");
        let back = load_bytes(&to_bedrock(&d), 1).unwrap();
        assert!(back.warnings.is_empty(), "{:?}", back.warnings);
        assert_eq!(back.doc.image(id).unwrap().text.as_deref(), Some("Hello <you>\nsecond line"));
        let svg = to_svg(&d);
        assert!(svg.contains("font-size=\"20\"") && svg.contains(">Hello &lt;you&gt;</tspan>"), "{svg}");
    }
}
