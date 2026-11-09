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
use crate::stroke::{InputDevice, Stroke, StrokeId};
use crate::tessellate;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::f32::consts::FRAC_PI_2;
use std::fmt;

pub const FORMAT_NAME: &str = "bedrock-note";
pub const FORMAT_VERSION: u32 = 1;
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
    /// Flat list, `channels.len()` numbers per sample.
    points: Vec<f64>,
}

/// Positions are stored to 1/1000 of a world unit: at the deepest zoom
/// (1600%) that is under 0.02 screen pixels, so saving never moves ink.
/// (It was 1/100, which was 0.64 px at the old 6400% limit.)
pub const POSITION_DECIMALS: i32 = 3;

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
                    round(p.x, POSITION_DECIMALS),
                    round(p.y, POSITION_DECIMALS),
                    round(p.pressure as f64, 3),
                    round(p.altitude as f64, 3),
                    round(p.azimuth as f64, 3),
                    round(p.t, 1),
                ]);
            }
            serde_json::to_value(StrokeJson {
                id: s.id,
                brush: s.brush,
                device: s.device,
                start: round(s.start_time, 1),
                derived_from: s.derived_from.clone(),
                points,
            })
            .expect("stroke serialises")
        })
        .collect();
    root.insert("strokes".into(), strokes.into());
    if recognition {
        root.insert("recognition".into(), serde_json::to_value(&doc.recognition).expect("recognition serialises"));
    }
    for (k, v) in &doc.extra {
        root.entry(k.clone()).or_insert_with(|| v.clone());
    }
    serde_json::to_string(&Value::Object(root)).expect("json")
}

const KNOWN_KEYS: [&str; 11] = [
    "format",
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
    let obj = root.as_object().ok_or(FormatError::NotABedrockNote)?;
    if obj.get("format").and_then(Value::as_str) != Some(FORMAT_NAME) {
        return Err(FormatError::NotABedrockNote);
    }
    let mut warnings = Vec::new();
    let mut doc = Document::new(seed);
    if let Some(v) = obj.get("version").and_then(Value::as_u64) {
        if v > FORMAT_VERSION as u64 {
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
    let r = round(v, 2);
    let s = format!("{r:.2}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" {
        "0".into()
    } else {
        s.to_string()
    }
}

fn path_data(points: &[crate::geom::Vec2]) -> String {
    let mut d = String::with_capacity(points.len() * 14);
    for (i, p) in points.iter().enumerate() {
        d.push_str(if i == 0 { "M" } else { "L" });
        d.push_str(&fmt_num(p.x));
        d.push(' ');
        d.push_str(&fmt_num(p.y));
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
            let d: String = tessellate::outlines_for(s, &samples).iter().map(|o| path_data(o)).collect();
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

/// Extract the JSON payload from a Bedrock SVG.
pub fn extract_json(svg: &str) -> Option<&str> {
    let start = svg.find(METADATA_OPEN)? + METADATA_OPEN.len();
    let rest = svg[start..].trim_start();
    let rest = rest.strip_prefix("<![CDATA[")?;
    let end = rest.find("]]>")?;
    Some(&rest[..end])
}

/// Load either a Bedrock SVG or bare note JSON.
pub fn load(text: &str, seed: u64) -> Result<Loaded, FormatError> {
    let t = text.trim_start_matches('\u{feff}').trim_start();
    if t.starts_with('{') {
        from_json(t, seed)
    } else {
        from_json(extract_json(t).ok_or(FormatError::NotABedrockNote)?, seed)
    }
}

// ----- .bedrock container ---------------------------------------------------

pub const NOTE_JSON: &str = "note.json";
pub const RECOGNIZED_JSON: &str = "recognized.json";
pub const PREVIEW_SVG: &str = "preview.svg";
pub const README_TXT: &str = "README.txt";

const README: &str = "This is a Bedrock note: an ordinary ZIP archive.\n\n\
preview.svg      the note as a picture; opens in any web browser\n\
note.json        every pen stroke with its raw samples (x, y, pressure, tilt, time)\n\
recognized.json  text recognised from the handwriting, linked to stroke ids\n\n\
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

/// Note JSON without the recognition block (which goes to `recognized.json`).
fn note_json_for_container(doc: &Document) -> String {
    json_with(doc, false)
}

/// SVG preview without the embedded data (the container already has it).
pub fn to_preview_svg(doc: &Document) -> String {
    svg_with(doc, false)
}

/// Write a `.bedrock` file (ZIP: note.json, recognized.json, preview.svg, README.txt).
pub fn to_bedrock(doc: &Document) -> Vec<u8> {
    let note = note_json_for_container(doc);
    let rec = recognition_json(doc);
    let preview = to_preview_svg(doc);
    crate::zip::write(&[
        (NOTE_JSON, note.as_bytes()),
        (RECOGNIZED_JSON, rec.as_bytes()),
        (PREVIEW_SVG, preview.as_bytes()),
        (README_TXT, README.as_bytes()),
    ])
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
        Some(d) => from_json(&String::from_utf8_lossy(d), seed)?,
        None => {
            // note.json is damaged: fall back to the data embedded in an SVG, if any.
            let svg = find(PREVIEW_SVG).map(|d| String::from_utf8_lossy(d).into_owned());
            match svg.as_deref().and_then(extract_json) {
                Some(j) => from_json(j, seed)?,
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
        assert_eq!(from_json(json, 0).unwrap().doc.title, d.title);
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
        assert_eq!(names, vec![NOTE_JSON, RECOGNIZED_JSON, PREVIEW_SVG, README_TXT]);
        let note = String::from_utf8(files[0].1.clone()).unwrap();
        assert!(!note.contains("\"recognition\""), "recognition lives in its own file");
        let preview = String::from_utf8(files[2].1.clone()).unwrap();
        assert!(!preview.contains("<metadata"));
        assert_eq!(preview.matches("<path ").count(), d.len());
        let l = load_bytes(&bytes, 3).unwrap();
        assert!(l.warnings.is_empty(), "{:?}", l.warnings);
        assert_same(&d, &l.doc);
    }

    #[test]
    fn damaged_recognition_never_loses_ink() {
        let d = sample_doc();
        let note = note_json_for_container(&d);
        let bytes = crate::zip::write(&[(NOTE_JSON, note.as_bytes()), (RECOGNIZED_JSON, b"{garbage")]);
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

    /// Fuzz-style robustness: flipping or truncating bytes anywhere in a
    /// saved note must never panic; it either loads (maybe with warnings) or
    /// returns an error.
    #[test]
    fn corrupted_files_never_panic() {
        let d = sample_doc();
        let inputs = [to_bedrock(&d), to_svg(&d).into_bytes(), to_json(&d).into_bytes()];
        let mut state = 0x1234_5678u64;
        let mut rnd = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for original in &inputs {
            for _ in 0..300 {
                let mut b = original.clone();
                match rnd() % 3 {
                    0 => {
                        let i = (rnd() as usize) % b.len();
                        b[i] ^= (rnd() % 255 + 1) as u8;
                    }
                    1 => b.truncate((rnd() as usize) % b.len()),
                    _ => {
                        let i = (rnd() as usize) % b.len();
                        b.insert(i, rnd() as u8);
                    }
                }
                let _ = load_bytes(&b, 0);
            }
        }
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
}
