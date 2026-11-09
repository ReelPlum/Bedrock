//! Scribble to erase: scribbling back and forth over ink erases it.
//!
//! A finished stroke counts as a scribble when it goes back and forth many
//! times along one direction (each pass covering most of its width) and is
//! far longer than the area it covers. Handwriting rarely does both: a
//! cursive "mmm" goes up and down often but moves steadily right, so its
//! passes are short compared with its width. On top of that, only ink that
//! lies mostly inside the scribble is erased, and a scribble over nothing is
//! kept as ink (it is shading, or a drawing).

use crate::document::Document;
use crate::eraser;
use crate::geom::{Rect, Vec2};
use crate::stroke::{Stroke, StrokeId};

/// Back-and-forth turns needed along one direction.
pub const MIN_TURNS: usize = 5;
/// A pass must cover this share of the scribble's extent in that direction.
pub const PASS_SHARE: f64 = 0.5;
/// Path length over the size of the area covered (width + height).
pub const MIN_DENSITY: f64 = 3.5;
/// Share of a stroke's samples that must lie under the scribble.
pub const COVERED_SHARE: f64 = 0.6;

/// Most a scribble may turn in one direction overall (radians): a zigzag's
/// turns cancel out, a loop drawn round and round adds up 2π per lap.
pub const MAX_NET_TURNING: f64 = std::f64::consts::TAU * 1.5;

/// Sum of signed turning angles along the path.
fn net_turning(points: &[Vec2]) -> f64 {
    let mut total = 0.0;
    let mut prev: Option<Vec2> = None;
    for w in points.windows(2) {
        let d = w[1] - w[0];
        if d.length() < 1e-9 {
            continue;
        }
        if let Some(p) = prev {
            let a = (p.x * d.y - p.y * d.x).atan2(p.x * d.x + p.y * d.y);
            // Turning straight back has no side: count it as neither.
            if a.abs() < std::f64::consts::PI * 0.9 {
                total += a;
            }
        }
        prev = Some(d);
    }
    total
}

/// Turns along an axis (`along` picks the coordinate) with hysteresis: a
/// turn counts once the pen has come back by `min_pass`.
fn turns(points: &[Vec2], along: impl Fn(Vec2) -> f64, min_pass: f64) -> usize {
    if points.len() < 3 || min_pass <= 0.0 {
        return 0;
    }
    let mut n = 0;
    let mut dir = 0.0f64; // +1 / -1 once moving
    let mut extreme = along(points[0]);
    for p in &points[1..] {
        let v = along(*p);
        if dir == 0.0 {
            if (v - extreme).abs() >= min_pass {
                dir = (v - extreme).signum();
                extreme = v;
            }
        } else if (v - extreme) * dir > 0.0 {
            extreme = v;
        } else if (extreme - v) * dir >= min_pass {
            n += 1;
            dir = -dir;
            extreme = v;
        }
    }
    n
}

fn ink_rect(points: &[Vec2]) -> Rect {
    points.iter().fold(Rect::EMPTY, |mut r, p| {
        r.include(*p);
        r
    })
}

/// Does this stroke look like a scribble?
pub fn is_scribble(stroke: &Stroke) -> bool {
    let pts: Vec<Vec2> = stroke.points.iter().map(|p| p.pos()).collect();
    if pts.len() < 8 {
        return false;
    }
    let r = ink_rect(&pts);
    let size = r.width() + r.height();
    if size <= 0.0 {
        return false;
    }
    let length: f64 = pts.windows(2).map(|w| w[0].distance(w[1])).sum();
    if length < size * MIN_DENSITY {
        return false;
    }
    // Going round and round (circling something for emphasis) also turns
    // back and forth along each axis, but always turns the same way.
    if net_turning(&pts).abs() > MAX_NET_TURNING {
        return false;
    }
    let tx = turns(&pts, |p| p.x, r.width() * PASS_SHARE);
    let ty = turns(&pts, |p| p.y, r.height() * PASS_SHARE);
    tx.max(ty) >= MIN_TURNS
}

/// The strokes a scribble erases: touched by it and mostly under it.
pub fn targets(doc: &Document, scribble: &Stroke) -> Vec<StrokeId> {
    let pts: Vec<Vec2> = scribble.points.iter().map(|p| p.pos()).collect();
    let radius = (scribble.brush.size as f64 * 0.5).max(1.0);
    let area = ink_rect(&pts).inflate(radius * 2.0);
    let mut hit: Vec<StrokeId> = Vec::new();
    for w in pts.windows(2) {
        for id in eraser::strokes_hit(doc.strokes(), w[0], w[1], radius) {
            if !hit.contains(&id) {
                hit.push(id);
            }
        }
    }
    doc.strokes()
        .iter()
        .filter(|s| hit.contains(&s.id) && s.id != scribble.id)
        .filter(|s| {
            let n = s.points.iter().filter(|p| area.contains(p.pos())).count();
            n as f64 >= s.points.len() as f64 * COVERED_SHARE
        })
        .map(|s| s.id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::Brush;
    use crate::input::InputPoint;
    use crate::stroke::InputDevice;

    fn stroke(doc: &mut Document, pts: &[(f64, f64)]) -> Stroke {
        let id = doc.next_id();
        Stroke::new(
            id,
            Brush::default(),
            0.0,
            InputDevice::Pen,
            pts.iter().map(|p| InputPoint::new(p.0, p.1, 0.5)).collect(),
        )
    }

    /// Back and forth over [x0, x1], drifting down from y0 to y1.
    fn zigzag(x0: f64, x1: f64, y0: f64, y1: f64, passes: usize) -> Vec<(f64, f64)> {
        let mut v = Vec::new();
        for i in 0..=passes {
            let y = y0 + (y1 - y0) * i as f64 / passes as f64;
            let x = if i % 2 == 0 { x0 } else { x1 };
            v.push((x, y));
            // Samples along the pass, as a real pen gives.
            if i < passes {
                let nx = if i % 2 == 0 { x1 } else { x0 };
                let ny = y0 + (y1 - y0) * (i + 1) as f64 / passes as f64;
                for k in 1..6 {
                    let f = k as f64 / 6.0;
                    v.push((x + (nx - x) * f, y + (ny - y) * f));
                }
            }
        }
        v
    }

    /// Cursive "m"s: up and down humps moving steadily right.
    fn cursive_ms(x0: f64, y: f64, humps: usize) -> Vec<(f64, f64)> {
        let mut v = Vec::new();
        for i in 0..humps * 8 {
            let t = i as f64 / 8.0;
            v.push((x0 + t * 10.0, y - (t * std::f64::consts::PI).sin().abs() * 20.0));
        }
        v
    }

    #[test]
    fn scribbles_are_recognised_and_writing_is_not() {
        let mut d = Document::new(1);
        assert!(is_scribble(&stroke(&mut d, &zigzag(0.0, 60.0, 0.0, 20.0, 8))));
        assert!(is_scribble(&stroke(&mut d, &zigzag(0.0, 60.0, 0.0, 6.0, 6))), "a flat one");
        // Up and down (vertical scribble).
        let vertical: Vec<_> = zigzag(0.0, 60.0, 0.0, 20.0, 8).into_iter().map(|(x, y)| (y, x)).collect();
        assert!(is_scribble(&stroke(&mut d, &vertical)));
        assert!(!is_scribble(&stroke(&mut d, &zigzag(0.0, 60.0, 0.0, 20.0, 3))), "too few passes");
        // Straight back and forth on one line (turns of exactly half a lap).
        assert!(is_scribble(&stroke(&mut d, &zigzag(0.0, 60.0, 10.0, 10.0, 8))));
        assert!(!is_scribble(&stroke(&mut d, &cursive_ms(0.0, 100.0, 8))), "cursive mmmm");
        let line: Vec<_> = (0..20).map(|i| (i as f64 * 5.0, 0.0)).collect();
        assert!(!is_scribble(&stroke(&mut d, &line)));
        // A loop drawn round and round (e.g. circling something).
        let circle: Vec<_> = (0..120)
            .map(|i| {
                let a = i as f64 / 20.0 * std::f64::consts::TAU;
                (50.0 + 40.0 * a.cos(), 50.0 + 40.0 * a.sin())
            })
            .collect();
        assert!(!is_scribble(&stroke(&mut d, &circle)), "circling is not scribbling");
    }

    #[test]
    fn erases_only_ink_mostly_under_the_scribble() {
        let mut d = Document::new(1);
        let word = stroke(&mut d, &[(10.0, 10.0), (20.0, 15.0), (30.0, 10.0), (40.0, 15.0)]);
        let long = stroke(&mut d, &[(30.0, 12.0), (200.0, 12.0), (400.0, 12.0)]); // passes through
        let away = stroke(&mut d, &[(300.0, 300.0), (310.0, 300.0)]);
        let (w, l, a) = (word.id, long.id, away.id);
        for s in [word, long, away] {
            d.add_stroke(s);
        }
        let s = stroke(&mut d, &zigzag(5.0, 45.0, 5.0, 20.0, 8));
        assert_eq!(targets(&d, &s), vec![w]);
        assert!(!targets(&d, &s).contains(&l) && !targets(&d, &s).contains(&a));
    }
}
