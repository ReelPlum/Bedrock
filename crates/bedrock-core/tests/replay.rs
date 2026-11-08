//! Stroke replay: feeds a pen trace through the engine exactly as the web
//! app does, and checks what comes out. Add real recorded traces to
//! `tests/fixtures/` to lock in behaviour (and to reproduce bugs).

use bedrock_core::engine::{Engine, PointerKind, ScreenSample};
use bedrock_core::format;
use bedrock_core::tessellate;
use serde_json::Value;

fn replay(path: &str) -> (Engine, usize) {
    let text = std::fs::read_to_string(path).expect("fixture");
    let v: Value = serde_json::from_str(&text).unwrap();
    let mut e = Engine::new(42);
    e.resize(1024.0, 768.0);
    let mut pen_samples = 0;
    for ev in v["events"].as_array().unwrap() {
        let kind = match ev["kind"].as_str().unwrap() {
            "pen" => PointerKind::Pen,
            "touch" => PointerKind::Touch,
            "eraser" => PointerKind::PenEraser,
            _ => PointerKind::Mouse,
        };
        let f = |k: &str| ev[k].as_f64().unwrap();
        let s = ScreenSample {
            x: f("x"),
            y: f("y"),
            pressure: f("pressure") as f32,
            altitude: f("altitude") as f32,
            azimuth: f("azimuth") as f32,
            time: f("time"),
        };
        let id = ev["id"].as_i64().unwrap() as i32;
        if kind == PointerKind::Pen {
            pen_samples += 1;
        }
        match ev["type"].as_str().unwrap() {
            "down" => e.pointer_down(id, kind, s),
            "move" => {
                e.pointer_move(id, kind, s);
                // The live layer re-tessellates on every sample, as on screen.
                if let Some(m) = e.live_mesh() {
                    assert!(m.indices.iter().all(|&i| (i as usize) < m.vertices.len()));
                }
            }
            "up" => e.pointer_up(id, kind, Some(s)),
            other => panic!("unknown event {other}"),
        }
    }
    (e, pen_samples)
}

#[test]
fn handwriting_trace_replays_faithfully() {
    let (e, pen_samples) = replay(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/pencil-handwriting.json"));
    let doc = &e.doc;
    assert_eq!(doc.len(), 4, "two words, an i-dot and an underline; the palm drew nothing");
    assert_eq!(e.camera.offset.x, 0.0, "the palm did not pan the canvas");

    // Every pen sample is kept (none lost or merged), except sub-pixel jitter.
    let stored: usize = doc.strokes().iter().map(|s| s.points.len()).sum();
    assert!(stored as f64 >= pen_samples as f64 * 0.97, "stored {stored} of {pen_samples} samples");

    for s in doc.strokes() {
        // Time is monotonic within a stroke and strokes are in writing order.
        assert!(s.points.windows(2).all(|w| w[1].t >= w[0].t));
        assert!(s.points.iter().all(|p| p.altitude < 1.0), "tilt is recorded");
        let m = tessellate::mesh(s);
        assert!(m.triangle_count() > 0);
    }
    assert!(doc.strokes().windows(2).all(|w| w[1].start_time > w[0].start_time));

    // The note survives a save/load cycle unchanged.
    let back = format::load_bytes(&format::to_bedrock(doc), 1).unwrap();
    assert!(back.warnings.is_empty());
    assert_eq!(format::to_json(&back.doc), format::to_json(doc));
}
