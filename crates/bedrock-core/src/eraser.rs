//! Eraser hit testing. Two modes:
//! * whole-stroke: anything the eraser touches disappears,
//! * partial: only the touched part is cut away and the rest is kept as new
//!   strokes (remembering which stroke they came from).

use crate::geom::{point_segment_distance, segment_segment_distance, Rect, Vec2};
use crate::input::InputPoint;
use crate::stroke::{Stroke, StrokeId};

fn half_width(s: &Stroke, p: &InputPoint) -> f64 {
    s.brush.footprint(p, 0.0).width as f64 / 2.0
}

fn segment_rect(a: Vec2, b: Vec2, r: f64) -> Rect {
    let mut rect = Rect::EMPTY;
    rect.include(a);
    rect.include(b);
    rect.inflate(r)
}

/// Does the eraser segment `a`..`b` with `radius` touch `stroke`?
pub fn touches(stroke: &Stroke, a: Vec2, b: Vec2, radius: f64) -> bool {
    if !stroke.bounds().intersects(&segment_rect(a, b, radius)) {
        return false;
    }
    let pts = &stroke.points;
    if pts.len() == 1 {
        return point_segment_distance(pts[0].pos(), a, b) <= radius + half_width(stroke, &pts[0]);
    }
    pts.windows(2).any(|w| {
        let reach = radius + half_width(stroke, &w[0]).max(half_width(stroke, &w[1]));
        segment_segment_distance(w[0].pos(), w[1].pos(), a, b) <= reach
    })
}

/// Ids of all strokes touched by the eraser segment.
pub fn strokes_hit(strokes: &[Stroke], a: Vec2, b: Vec2, radius: f64) -> Vec<StrokeId> {
    strokes.iter().filter(|s| touches(s, a, b, radius)).map(|s| s.id).collect()
}

/// Cut the part of `stroke` under the eraser away. Returns `None` if the
/// eraser does not touch it, otherwise the remaining pieces (maybe empty).
pub fn split(
    stroke: &Stroke,
    a: Vec2,
    b: Vec2,
    radius: f64,
    mut new_id: impl FnMut() -> StrokeId,
) -> Option<Vec<Stroke>> {
    if !touches(stroke, a, b, radius) {
        return None;
    }
    // Densify so a fast stroke can't slip between two samples.
    let spacing = (radius / 2.0).max(0.25);
    let mut dense: Vec<InputPoint> = Vec::with_capacity(stroke.points.len());
    for (i, p) in stroke.points.iter().enumerate() {
        if i > 0 {
            let q = stroke.points[i - 1];
            let d = q.pos().distance(p.pos());
            let n = ((d / spacing).ceil() as usize).min(256);
            for k in 1..n {
                let t = k as f64 / n as f64;
                let pos = q.pos().lerp(p.pos(), t);
                dense.push(InputPoint {
                    x: pos.x,
                    y: pos.y,
                    pressure: q.pressure + (p.pressure - q.pressure) * t as f32,
                    altitude: q.altitude + (p.altitude - q.altitude) * t as f32,
                    azimuth: q.azimuth,
                    t: q.t + (p.t - q.t) * t,
                });
            }
        }
        dense.push(*p);
    }
    let mut pieces = Vec::new();
    let mut run: Vec<InputPoint> = Vec::new();
    let mut flush = |run: &mut Vec<InputPoint>, pieces: &mut Vec<Stroke>| {
        if run.len() >= 2 {
            let mut s = Stroke::new(new_id(), stroke.brush, stroke.start_time, stroke.device, std::mem::take(run));
            // Point at the original ink, not short-lived intermediate pieces.
            s.derived_from = if stroke.derived_from.is_empty() { vec![stroke.id] } else { stroke.derived_from.clone() };
            pieces.push(s);
        }
        run.clear();
    };
    for p in dense {
        let erased = point_segment_distance(p.pos(), a, b) <= radius + half_width(stroke, &p) * 0.5;
        if erased {
            flush(&mut run, &mut pieces);
        } else {
            run.push(p);
        }
    }
    flush(&mut run, &mut pieces);
    Some(pieces)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::Brush;
    use crate::stroke::InputDevice;

    fn hline(id: u64, y: f64) -> Stroke {
        let pts = (0..=10).map(|i| InputPoint::new(i as f64 * 10.0, y, 0.5).at(i as f64)).collect();
        Stroke::new(StrokeId(id), Brush::default(), 1000.0, InputDevice::Pen, pts)
    }

    #[test]
    fn whole_stroke_hit_test() {
        let strokes = vec![hline(1, 0.0), hline(2, 50.0)];
        let hit = strokes_hit(&strokes, Vec2::new(50.0, -20.0), Vec2::new(50.0, 20.0), 2.0);
        assert_eq!(hit, vec![StrokeId(1)]);
        let none = strokes_hit(&strokes, Vec2::new(200.0, 0.0), Vec2::new(210.0, 0.0), 2.0);
        assert!(none.is_empty());
    }

    #[test]
    fn eraser_between_samples_still_hits() {
        // Eraser crosses between samples at x=40 and x=50.
        let s = hline(1, 0.0);
        assert!(touches(&s, Vec2::new(45.0, -10.0), Vec2::new(45.0, 10.0), 0.5));
    }

    #[test]
    fn partial_erase_splits_in_two() {
        let s = hline(1, 0.0);
        let mut next = 100;
        let pieces = split(&s, Vec2::new(50.0, -20.0), Vec2::new(50.0, 20.0), 3.0, || {
            next += 1;
            StrokeId(next)
        })
        .expect("touched");
        assert_eq!(pieces.len(), 2);
        assert!(pieces[0].points.last().unwrap().x < 50.0);
        assert!(pieces[1].points[0].x > 50.0);
        for p in &pieces {
            assert_eq!(p.derived_from, vec![StrokeId(1)]);
            assert_eq!(p.start_time, 1000.0);
            assert_eq!(p.brush, s.brush);
        }
        // Timestamps survive so recognisers still see writing order.
        assert!(pieces[1].points[0].t > pieces[0].points.last().unwrap().t);
    }

    #[test]
    fn partial_erase_untouched_is_none() {
        let s = hline(1, 0.0);
        assert!(split(&s, Vec2::new(0.0, 80.0), Vec2::new(10.0, 80.0), 3.0, || StrokeId(9)).is_none());
    }

    #[test]
    fn partial_erase_everything_leaves_nothing() {
        let s = hline(1, 0.0);
        let pieces = split(&s, Vec2::new(-10.0, 0.0), Vec2::new(110.0, 0.0), 5.0, || StrokeId(9)).unwrap();
        assert!(pieces.is_empty());
    }
}
