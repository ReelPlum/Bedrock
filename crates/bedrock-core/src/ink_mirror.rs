//! A note's handwriting as a note mirror holds it (the `note-mirrors` spec):
//! every stroke's id, start time and raw samples, exactly as the note file
//! saves them, and nothing else. No title, typed text, pictures, brush or
//! colour. Highlighter strokes are left out: they mark writing rather than
//! being writing, and without its brush a mirror could not tell them apart.

use serde_json::{json, Value};

use crate::brush::BrushKind;
use crate::document::Document;
use crate::format;

/// `{"channels": [...], "strokes": [{"id", "start", "points"}]}`, strokes
/// in drawing order. Values are those `note.json` saves, so a mirror holds
/// the note exactly as a file of it would.
pub fn ink_json(doc: &Document) -> String {
    let saved: Value = serde_json::from_str(&format::to_json(doc)).expect("the note format is JSON");
    let keep: Vec<bool> = doc.strokes().iter().map(|s| s.brush.kind != BrushKind::Highlighter).collect();
    let strokes: Vec<Value> = saved["strokes"]
        .as_array()
        .into_iter()
        .flatten()
        .zip(keep)
        .filter(|(_, keep)| *keep)
        .map(|(s, _)| json!({ "id": s["id"], "start": s["start"], "points": s["points"] }))
        .collect();
    json!({ "channels": saved["channels"], "strokes": strokes }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::Brush;
    use crate::input::InputPoint;
    use crate::stroke::{InputDevice, Stroke, StrokeId};

    fn stroke(id: u64, kind: BrushKind) -> Stroke {
        let mut brush = Brush::default();
        brush.kind = kind;
        let p = |x: f64, t: f64| InputPoint::new(x, 5.0, 0.5).at(t);
        Stroke::new(StrokeId(id), brush, 1_800_000_000_000.0, InputDevice::Pen, vec![p(1.0, 0.0), p(2.0, 8.0)])
    }

    #[test]
    fn the_mirror_holds_ink_only() {
        let mut d = Document::new(0);
        d.title = "Diary".into();
        d.set_strokes(vec![stroke(1, BrushKind::Pen), stroke(2, BrushKind::Highlighter), stroke(3, BrushKind::Pencil)]);
        let ink: Value = serde_json::from_str(&ink_json(&d)).unwrap();
        let ids: Vec<&str> = ink["strokes"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
        assert_eq!(ids, [StrokeId(1).to_string(), StrokeId(3).to_string()]);
        assert_eq!(ink["strokes"][0].as_object().unwrap().len(), 3, "id, start and points only");
        assert_eq!(ink["strokes"][0]["start"], 1_800_000_000_000.0);
        assert!(!ink.to_string().contains("Diary") && !ink.to_string().contains("brush"));
    }
}
