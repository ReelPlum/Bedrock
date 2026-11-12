//! Lasso selection: which strokes a loop drawn around them takes in.
//!
//! A stroke is taken when most of it lies inside the loop, so a loop that
//! clips the edge of a neighbouring word doesn't grab it, and one drawn a
//! little tight around a word still gets all of its letters.

use crate::document::Document;
use crate::geom::{Rect, Vec2};
use crate::stroke::StrokeId;

/// Share of a stroke's samples that must lie inside the loop.
pub const INSIDE_SHARE: f64 = 0.6;

/// Even-odd point in polygon test (the loop is closed implicitly).
pub fn inside(poly: &[Vec2], p: Vec2) -> bool {
    let mut odd = false;
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            odd = !odd;
        }
        j = i;
    }
    odd
}

/// The strokes inside the loop `poly` (world coordinates), in stacking order.
pub fn strokes_in_lasso(doc: &Document, poly: &[Vec2]) -> Vec<StrokeId> {
    if poly.len() < 3 {
        return Vec::new();
    }
    let hull = poly.iter().fold(Rect::EMPTY, |mut r, p| {
        r.include(*p);
        r
    });
    let mut ids: Vec<StrokeId> = doc
        .strokes()
        .iter()
        .filter(|s| !s.points.is_empty() && s.bounds().intersects(&hull))
        .filter(|s| {
            let n = s.points.iter().filter(|p| inside(poly, p.pos())).count();
            n as f64 >= s.points.len() as f64 * INSIDE_SHARE
        })
        .map(|s| s.id)
        .collect();
    // Pictures: the same share of a 5×5 grid over them.
    for img in doc.images() {
        let r = img.rect();
        if !r.intersects(&hull) {
            continue;
        }
        let n = (0..25)
            .filter(|k| {
                let (u, v) = ((k % 5) as f64 / 4.0, (k / 5) as f64 / 4.0);
                inside(poly, Vec2::new(r.min.x + u * r.width(), r.min.y + v * r.height()))
            })
            .count();
        if n as f64 >= 25.0 * INSIDE_SHARE {
            ids.push(img.id);
        }
    }
    ids
}

/// Ink bounds (without the brush radius) of some strokes, and of pictures.
pub fn bounds(doc: &Document, ids: &[StrokeId]) -> Rect {
    let ink = doc.strokes().iter().filter(|s| ids.contains(&s.id)).fold(Rect::EMPTY, |mut r, s| {
        for p in &s.points {
            r.include(p.pos());
        }
        r
    });
    doc.images().iter().filter(|i| ids.contains(&i.id)).fold(ink, |r, i| r.union(&i.rect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::Brush;
    use crate::input::InputPoint;
    use crate::stroke::{InputDevice, Stroke};

    fn line(doc: &mut Document, from: (f64, f64), to: (f64, f64)) -> StrokeId {
        let id = doc.next_id();
        let pts = (0..=10)
            .map(|k| {
                let f = k as f64 / 10.0;
                InputPoint::new(from.0 + (to.0 - from.0) * f, from.1 + (to.1 - from.1) * f, 0.5)
            })
            .collect();
        doc.add_stroke(Stroke::new(id, Brush::default(), 0.0, InputDevice::Pen, pts));
        id
    }

    fn square(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<Vec2> {
        vec![Vec2::new(x0, y0), Vec2::new(x1, y0), Vec2::new(x1, y1), Vec2::new(x0, y1)]
    }

    #[test]
    fn point_in_polygon() {
        let sq = square(0.0, 0.0, 10.0, 10.0);
        assert!(inside(&sq, Vec2::new(5.0, 5.0)));
        assert!(!inside(&sq, Vec2::new(15.0, 5.0)));
        // A concave "C": the notch is outside.
        let c = vec![
            Vec2::new(0.0, 0.0),
            Vec2::new(10.0, 0.0),
            Vec2::new(10.0, 3.0),
            Vec2::new(3.0, 3.0),
            Vec2::new(3.0, 7.0),
            Vec2::new(10.0, 7.0),
            Vec2::new(10.0, 10.0),
            Vec2::new(0.0, 10.0),
        ];
        assert!(!inside(&c, Vec2::new(7.0, 5.0)));
        assert!(inside(&c, Vec2::new(1.0, 5.0)));
    }

    #[test]
    fn takes_strokes_mostly_inside() {
        let mut d = Document::new(1);
        let a = line(&mut d, (10.0, 10.0), (40.0, 10.0));
        let edge = line(&mut d, (45.0, 20.0), (100.0, 20.0)); // only its start is inside
        let _out = line(&mut d, (200.0, 10.0), (240.0, 10.0));
        let b = line(&mut d, (10.0, 30.0), (52.0, 30.0)); // pokes out a little
        let got = strokes_in_lasso(&d, &square(0.0, 0.0, 50.0, 40.0));
        assert_eq!(got, vec![a, b]);
        assert!(!got.contains(&edge));
    }

    #[test]
    fn a_line_is_not_a_loop() {
        let mut d = Document::new(1);
        line(&mut d, (10.0, 10.0), (40.0, 10.0));
        assert!(strokes_in_lasso(&d, &[Vec2::new(0.0, 0.0), Vec2::new(50.0, 50.0)]).is_empty());
    }
}
