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

/// The frame the 16-bit minimap coordinates are measured in: the drawing's
/// top-left corner and the longer side of its bounding box.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub origin: Vec2,
    pub span: f64,
}

impl Frame {
    pub fn of(doc: &Document) -> Option<Frame> {
        let b = doc.bounds();
        if b.is_empty() {
            return None;
        }
        Some(Frame { origin: b.min, span: b.width().max(b.height()).max(1e-6) })
    }

    pub fn quantize(&self, p: Vec2) -> [u16; 2] {
        let q = |v: f64| ((v / self.span) * 65535.0).round().clamp(0.0, 65535.0) as u16;
        [q(p.x - self.origin.x), q(p.y - self.origin.y)]
    }

    pub fn world(&self, q: [u16; 2]) -> Vec2 {
        self.origin + Vec2::new(q[0] as f64, q[1] as f64) * (self.span / 65535.0)
    }
}

/// Every stroke as a simplified centre line in 16-bit integers, for the
/// minimap: compact (4 bytes a point) and still 65536 steps across the
/// drawing, far finer than the minimap can show. Per stroke:
/// `[n_lo, n_hi, r<<8|g, b<<8|a, x0, y0, x1, y1, ...]`, coordinates in
/// [`Frame::of`]`(doc)`. Points closer than `tolerance` (world units) to the
/// last kept one are skipped. Highlighters come first so ink is drawn over
/// them, at 35% of their alpha as on the canvas.
pub fn polylines(doc: &Document, tolerance: f64) -> Vec<u16> {
    let Some(frame) = Frame::of(doc) else { return Vec::new() };
    let tol = tolerance.max(0.0);
    let mut out = Vec::new();
    for highlights in [true, false] {
        for s in doc.strokes() {
            if (s.brush.kind == BrushKind::Highlighter) != highlights || s.points.is_empty() {
                continue;
            }
            let head = out.len();
            let c = s.brush.color;
            let a = if highlights { (c.a as f32 * 0.35) as u16 } else { c.a as u16 };
            out.extend_from_slice(&[0, 0, (c.r as u16) << 8 | c.g as u16, (c.b as u16) << 8 | a]);
            let mut last: Option<(Vec2, [u16; 2])> = None;
            let mut n = 0u32;
            let end = s.points.len() - 1;
            for (i, p) in s.points.iter().enumerate() {
                let w = p.pos();
                let q = frame.quantize(w);
                let keep = match last {
                    None => true,
                    Some((lw, lq)) => i == end && lq != q || (lq != q && lw.distance(w) >= tol),
                };
                if keep {
                    out.extend_from_slice(&q);
                    last = Some((w, q));
                    n += 1;
                }
            }
            out[head] = (n & 0xffff) as u16;
            out[head + 1] = (n >> 16) as u16;
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
    fn polylines_are_16_bit_simplified_and_keep_ends() {
        let mut doc = Document::new(1);
        let pts = (0..101).map(|i| InputPoint::new(1000.0 + i as f64 * 0.5, 20.0, 0.5)).collect();
        let id = doc.next_id();
        doc.add_stroke(Stroke::new(
            id,
            Brush::new(BrushKind::Pen, Rgba::rgb(255, 0, 0), 3.0),
            0.0,
            InputDevice::Pen,
            pts,
        ));
        let frame = Frame::of(&doc).unwrap();
        let p = polylines(&doc, 5.0);
        let n = (p[0] as u32 | (p[1] as u32) << 16) as usize;
        assert_eq!(p.len(), 4 + 2 * n);
        assert!((10..=12).contains(&n), "{n} points");
        assert_eq!((p[2], p[3]), (0xff00, 0x00ff), "red, opaque");
        let first = frame.world([p[4], p[5]]);
        let last = frame.world([p[p.len() - 2], p[p.len() - 1]]);
        let step = frame.span / 65535.0;
        assert!(first.distance(Vec2::new(1000.0, 20.0)) <= step, "{first:?}");
        assert!(last.distance(Vec2::new(1050.0, 20.0)) <= step, "{last:?}");
        assert!(polylines(&Document::new(2), 1.0).is_empty());
    }
}
