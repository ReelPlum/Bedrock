//! Every note Bedrock writes must match the published schema
//! (`docs/note.schema.json`), and so must every note an earlier Bedrock
//! wrote. The schema is the promise to other tools; these tests keep the
//! writer and the promise from drifting apart.
//!
//! The checking is done by the `jsonschema` crate (test-only), and the
//! made-up notes come from `proptest`, which also shrinks a failing note to
//! the smallest one that still fails.

use bedrock_core::brush::{Brush, BrushKind, LineStyle};
use bedrock_core::color::Rgba;
use bedrock_core::document::{Document, RecognizedText};
use bedrock_core::format;
use bedrock_core::geom::{Rect, Vec2};
use bedrock_core::input::InputPoint;
use bedrock_core::stroke::{InputDevice, Stroke};
use proptest::prelude::*;
use serde_json::Value;
use std::path::Path;

fn validator() -> jsonschema::Validator {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/note.schema.json");
    let schema: Value = serde_json::from_slice(&std::fs::read(path).expect("docs/note.schema.json")).expect("json");
    jsonschema::validator_for(&schema).expect("docs/note.schema.json is a valid JSON Schema")
}

/// Panics with every way `json` breaks the schema.
fn assert_matches_schema(v: &jsonschema::Validator, json: &str, what: &str) {
    let value: Value = serde_json::from_str(json).unwrap_or_else(|e| panic!("{what}: not JSON: {e}"));
    let errors: Vec<String> = v.iter_errors(&value).map(|e| format!("{} at {}", e, e.instance_path())).collect();
    assert!(errors.is_empty(), "{what} does not match docs/note.schema.json:\n{}", errors.join("\n"));
}

/// A note with one of everything the format can hold.
fn full_note() -> Document {
    let mut d = Document::new(7);
    d.title = "Everything <&> \"quoted\"".into();
    d.created = 1_731_000_000_000.0;
    d.modified = 1_731_000_100_000.0;
    d.paper = "grid".into();
    for (i, kind) in BrushKind::ALL.into_iter().enumerate() {
        let id = d.next_id();
        let points = (0..6)
            .map(|k| InputPoint::new(i as f64 * 30.0 + k as f64, k as f64, 0.5).with_tilt(0.9, 1.2).at(k as f64 * 4.0))
            .collect();
        let style = [LineStyle::Solid, LineStyle::Dashed, LineStyle::Dotted][i % 3];
        let brush = Brush::new(kind, Rgba::rgb(10, 20, 200), 3.0).with_style(style).with_stabilizer(0.5);
        let device = if i == 3 { InputDevice::Touch } else { InputDevice::Pen };
        d.add_stroke(Stroke::new(id, brush, 1_731_000_000_500.0 + i as f64, device, points));
    }
    let ids: Vec<_> = d.strokes().iter().map(|s| s.id).collect();
    d.recognition.push(RecognizedText {
        id: "r1".into(),
        text: "hello".into(),
        strokes: ids[..2].to_vec(),
        alternatives: vec!["hallo".into()],
        confidence: Some(0.9),
        language: Some("en".into()),
        engine: Some("test/1".into()),
    });
    d.group(&ids[..2]);
    d.set_link(&ids[..2], "https://example.com", "url");
    d.set_kind(&ids[2..3], "math");
    let rect = Rect::new(Vec2::new(0.0, 50.0), Vec2::new(40.0, 80.0));
    d.add_image("images/0123456789abcdef0123456789abcdef.png", Some(vec![1, 2, 3]), rect);
    d.add_text("typed\ntext", rect);
    d
}

#[test]
fn a_note_with_everything_matches_the_schema() {
    let v = validator();
    let d = full_note();
    assert_matches_schema(&v, &format::to_json(&d), "note JSON");
    // The JSON embedded in an SVG export, and note.json inside a .bedrock.
    let svg = format::to_svg(&d);
    assert_matches_schema(&v, &format::extract_json(&svg).expect("embedded JSON"), "JSON inside the SVG");
    let (files, _) = bedrock_core::zip::read(&format::to_bedrock(&d)).expect("zip");
    let note = &files.iter().find(|(n, _)| n == format::NOTE_JSON).expect("note.json").1;
    assert_matches_schema(&v, std::str::from_utf8(note).unwrap(), "note.json in the .bedrock");
}

#[test]
fn notes_written_by_earlier_versions_match_the_schema() {
    let v = validator();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/old-formats");
    let mut checked = 0;
    for entry in std::fs::read_dir(&dir).expect("old-formats").flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let bytes = std::fs::read(&path).unwrap();
        let json = match path.extension().and_then(|e| e.to_str()) {
            Some("json") => String::from_utf8(bytes).unwrap(),
            Some("svg") => {
                format::extract_json(std::str::from_utf8(&bytes).unwrap()).expect("embedded JSON").into_owned()
            }
            Some("bedrock") => {
                let (files, _) = bedrock_core::zip::read(&bytes).expect("zip");
                String::from_utf8(files.into_iter().find(|(n, _)| n == format::NOTE_JSON).expect("note.json").1)
                    .unwrap()
            }
            _ => continue,
        };
        // The folder also keeps other formats (shared words, for example).
        let format =
            serde_json::from_str::<serde_json::Value>(&json).ok().and_then(|j| j["format"].as_str().map(String::from));
        if format.as_deref() != Some(format::FORMAT_NAME) {
            continue;
        }
        assert_matches_schema(&v, &json, &name);
        checked += 1;
    }
    assert!(checked >= 9, "only {checked} fixtures were checked");
}

fn brush() -> impl Strategy<Value = Brush> {
    (0..BrushKind::ALL.len(), any::<[u8; 4]>(), 0.5f32..80.0, 0..3usize, 0.0f32..=1.0).prop_map(
        |(k, c, size, style, stab)| {
            Brush::new(BrushKind::ALL[k], Rgba { r: c[0], g: c[1], b: c[2], a: c[3] }, size)
                .with_style([LineStyle::Solid, LineStyle::Dashed, LineStyle::Dotted][style])
                .with_stabilizer(stab)
        },
    )
}

/// A stroke's samples: it starts anywhere on the canvas and stays within a
/// hand's reach of where it started, as a real stroke does.
fn points() -> impl Strategy<Value = Vec<InputPoint>> {
    let sample = (
        -150.0f64..150.0,
        -150.0f64..150.0,
        0.0f32..=1.0,
        0.0f32..std::f32::consts::FRAC_PI_2,
        -std::f32::consts::PI..std::f32::consts::PI,
        0.0f64..60_000.0,
    );
    (-1.0e6f64..1.0e6, -1.0e6f64..1.0e6, prop::collection::vec(sample, 1..12)).prop_map(|(x0, y0, samples)| {
        samples
            .into_iter()
            .map(|(x, y, p, alt, az, t)| InputPoint::new(x0 + x, y0 + y, p).with_tilt(alt, az).at(t))
            .collect()
    })
}

fn note() -> impl Strategy<Value = Document> {
    let stroke = (brush(), points(), 0.0f64..2.0e12, any::<bool>());
    (".{0,40}", prop::collection::vec(stroke, 0..8), any::<u64>()).prop_map(|(title, strokes, seed)| {
        let mut d = Document::new(seed);
        d.title = title;
        for (brush, points, start, pen) in strokes {
            let id = d.next_id();
            let device = if pen { InputDevice::Pen } else { InputDevice::Touch };
            d.add_stroke(Stroke::new(id, brush, start, device, points));
        }
        d
    })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, failure_persistence: None, ..ProptestConfig::default() })]

    /// Whatever is drawn, the saved note matches the schema and opens again
    /// with the same strokes, in every file kind.
    #[test]
    fn any_note_matches_the_schema_and_opens_again(d in note()) {
        let v = validator();
        let json = format::to_json(&d);
        let value: Value = serde_json::from_str(&json).unwrap();
        let errors: Vec<String> = v.iter_errors(&value).map(|e| format!("{} at {}", e, e.instance_path())).collect();
        prop_assert!(errors.is_empty(), "{}", errors.join("\n"));
        for bytes in [json.into_bytes(), format::to_svg(&d).into_bytes(), format::to_bedrock(&d)] {
            let l = format::load_bytes(&bytes, 1).unwrap();
            prop_assert!(l.warnings.is_empty(), "{:?}", l.warnings);
            prop_assert_eq!(l.doc.len(), d.len());
            for (a, b) in d.strokes().iter().zip(l.doc.strokes()) {
                prop_assert_eq!(a.id, b.id);
                prop_assert_eq!(a.points.len(), b.points.len());
                prop_assert_eq!(a.brush.kind, b.brush.kind);
            }
            prop_assert_eq!(&l.doc.title, &d.title);
        }
    }
}
