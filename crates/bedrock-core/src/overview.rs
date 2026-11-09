//! The minimap: a small overview of the whole note with the camera on it.
//!
//! * [`region`] is the area the minimap shows: the drawing, widened just
//!   enough to keep the camera's view in sight.
//! * [`polylines`] is a coarse copy of every stroke (centre lines only,
//!   simplified to the minimap's resolution) for drawing it cheaply.

use crate::brush::BrushKind;
use crate::document::Document;
use crate::geom::{Rect, Vec2};

/// The area the minimap shows: the drawing's bounding box, widened only as
/// far as needed to keep the camera's view in sight, plus a small margin.
/// Zooming out or scrolling away widens it; coming back shrinks it to the
/// drawing again.
pub fn region(ink: &Rect, view: &Rect) -> Rect {
    let need = if ink.is_empty() { *view } else { ink.union(view) };
    need.inflate(need.width().max(need.height()) * 0.06)
}

/// Every stroke as a simplified centre line, packed for JavaScript:
/// `[n, rgba, width, x0, y0, x1, y1, ...]` per stroke, where `n` is the point
/// count, `rgba` the colour as a `u32` and `width` the brush size. f64, so
/// positions far out on the page keep their precision. Points
/// closer than `tolerance` (world units) to the last kept one are skipped.
/// Highlighters come first so ink is drawn over them.
pub fn polylines(doc: &Document, tolerance: f64) -> Vec<f64> {
    let tol = tolerance.max(0.0);
    let mut out = Vec::new();
    for highlights in [true, false] {
        for s in doc.strokes() {
            if (s.brush.kind == BrushKind::Highlighter) != highlights || s.points.is_empty() {
                continue;
            }
            let head = out.len();
            out.extend_from_slice(&[0.0, 0.0, 0.0]);
            let c = s.brush.color;
            let a = if highlights { (c.a as f32 * 0.35) as u32 } else { c.a as u32 };
            let rgba = (c.r as u32) << 24 | (c.g as u32) << 16 | (c.b as u32) << 8 | a;
            let mut last: Option<Vec2> = None;
            let mut n = 0usize;
            let end = s.points.len() - 1;
            for (i, p) in s.points.iter().enumerate() {
                let q = p.pos();
                if i == end || last.is_none_or(|l| l.distance(q) >= tol) {
                    out.push(q.x);
                    out.push(q.y);
                    last = Some(q);
                    n += 1;
                }
            }
            out[head] = n as f64;
            out[head + 1] = rgba as f64;
            out[head + 2] = s.brush.max_width() as f64;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::Brush;
    use crate::color::Rgba;
    use crate::input::InputPoint;
    use crate::stroke::{InputDevice, Stroke};

    fn r(x0: f64, y0: f64, x1: f64, y1: f64) -> Rect {
        Rect::new(Vec2::new(x0, y0), Vec2::new(x1, y1))
    }

    #[test]
    fn region_follows_ink_and_view_and_shrinks_back() {
        let ink = r(0.0, 0.0, 100.0, 100.0);
        let home = region(&ink, &r(0.0, 0.0, 50.0, 50.0));
        assert!(home.contains(Vec2::new(0.0, 0.0)) && home.contains(Vec2::new(100.0, 100.0)));
        assert!(home.width() < 120.0, "hugs the drawing: {home:?}");
        // The camera leaves: the area widens to keep it in sight.
        let away = region(&ink, &r(500.0, 0.0, 600.0, 50.0));
        assert!(away.contains(Vec2::new(600.0, 50.0)) && away.contains(Vec2::new(0.0, 0.0)));
        // Coming back shrinks it to the drawing again.
        assert_eq!(region(&ink, &r(0.0, 0.0, 50.0, 50.0)), home);
        // Zoomed out with the drawing in view: the view decides.
        let out = region(&ink, &r(-1000.0, -1000.0, 1000.0, 1000.0));
        assert!(out.contains(Vec2::new(-1000.0, -1000.0)));
        // An empty note shows just the view.
        assert!(region(&Rect::EMPTY, &r(0.0, 0.0, 50.0, 50.0)).width() < 60.0);
    }

    #[test]
    fn polylines_are_simplified_and_keep_ends() {
        let mut doc = Document::new(1);
        let pts = (0..101).map(|i| InputPoint::new(i as f64 * 0.5, 0.0, 0.5)).collect();
        let id = doc.next_id();
        doc.add_stroke(Stroke::new(
            id,
            Brush::new(BrushKind::Pen, Rgba::rgb(255, 0, 0), 3.0),
            0.0,
            InputDevice::Pen,
            pts,
        ));
        let p = polylines(&doc, 5.0);
        let n = p[0] as usize;
        assert_eq!(p.len(), 3 + 2 * n);
        assert!((10..=12).contains(&n), "{n} points");
        assert_eq!(p[1] as u32, 0xff00_00ff);
        assert_eq!((p[3], p[4]), (0.0, 0.0));
        assert_eq!((p[p.len() - 2], p[p.len() - 1]), (50.0, 0.0));
    }
}
