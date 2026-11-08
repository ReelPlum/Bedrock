//! The minimap: a small overview of the whole note with the camera on it.
//!
//! * [`Region`] is the area the minimap shows. It always holds all the ink
//!   and the camera's view, and only ever grows while a note is open, so the
//!   map stays still while you write and zooms out when the drawing gets
//!   bigger or you scroll away from it.
//! * [`polylines`] is a coarse copy of every stroke (centre lines only,
//!   simplified to the minimap's resolution) for drawing it cheaply.

use crate::brush::BrushKind;
use crate::document::Document;
use crate::geom::{Rect, Vec2};

/// The area shown on the minimap, in world units.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Region {
    rect: Option<Rect>,
}

impl Region {
    pub fn new() -> Self {
        Self::default()
    }

    /// Forget the area (a different note was opened).
    pub fn reset(&mut self) {
        self.rect = None;
    }

    /// Grow to hold `ink` (may be empty) and `view`, with a margin of 8% so
    /// nothing touches the minimap's edge. Returns the area to show.
    pub fn update(&mut self, ink: &Rect, view: &Rect) -> Rect {
        let mut need = if ink.is_empty() { *view } else { ink.union(view) };
        let pad = need.width().max(need.height()) * 0.08;
        need = need.inflate(pad);
        let r = match self.rect {
            // Only grow when something is actually outside: re-padding on
            // every frame would creep outwards.
            Some(r) if contains_rect(&r, ink) && contains_rect(&r, view) => r,
            Some(r) => r.union(&need),
            None => need,
        };
        self.rect = Some(r);
        r
    }

    pub fn rect(&self) -> Option<Rect> {
        self.rect
    }
}

fn contains_rect(outer: &Rect, inner: &Rect) -> bool {
    inner.is_empty() || (outer.contains(inner.min) && outer.contains(inner.max))
}

/// Every stroke as a simplified centre line, packed for JavaScript:
/// `[n, rgba, width, x0, y0, x1, y1, ...]` per stroke, where `n` is the point
/// count, `rgba` the colour as a `u32` and `width` the brush size. Points
/// closer than `tolerance` (world units) to the last kept one are skipped.
/// Highlighters come first so ink is drawn over them.
pub fn polylines(doc: &Document, tolerance: f64) -> Vec<f32> {
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
                    out.push(q.x as f32);
                    out.push(q.y as f32);
                    last = Some(q);
                    n += 1;
                }
            }
            out[head] = n as f32;
            out[head + 1] = f32::from_bits(rgba);
            out[head + 2] = s.brush.max_width();
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
    fn region_holds_ink_and_view_and_only_grows() {
        let mut g = Region::new();
        let a = g.update(&r(0.0, 0.0, 100.0, 100.0), &r(0.0, 0.0, 50.0, 50.0));
        assert!(a.contains(Vec2::new(0.0, 0.0)) && a.contains(Vec2::new(100.0, 100.0)));
        // Same input: stays exactly put (no creeping).
        assert_eq!(g.update(&r(0.0, 0.0, 100.0, 100.0), &r(10.0, 10.0, 60.0, 60.0)), a);
        // The camera leaves the area: it grows to include the view.
        let b = g.update(&r(0.0, 0.0, 100.0, 100.0), &r(500.0, 0.0, 600.0, 50.0));
        assert!(b.contains(Vec2::new(600.0, 50.0)) && b.contains(Vec2::new(0.0, 0.0)));
        // Coming back doesn't shrink it.
        assert_eq!(g.update(&r(0.0, 0.0, 100.0, 100.0), &r(0.0, 0.0, 50.0, 50.0)), b);
        // More ink further out grows it again.
        let c = g.update(&r(0.0, -400.0, 100.0, 100.0), &r(0.0, 0.0, 50.0, 50.0));
        assert!(c.contains(Vec2::new(0.0, -400.0)) && c.contains(Vec2::new(600.0, 50.0)));
        g.reset();
        assert_eq!(g.rect(), None);
        // An empty note shows just the view.
        let d = g.update(&Rect::EMPTY, &r(0.0, 0.0, 50.0, 50.0));
        assert!(d.width() < 60.0);
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
        assert_eq!(p[1].to_bits(), 0xff00_00ff);
        assert_eq!((p[3], p[4]), (0.0, 0.0));
        assert_eq!((p[p.len() - 2], p[p.len() - 1]), (50.0, 0.0));
    }
}
