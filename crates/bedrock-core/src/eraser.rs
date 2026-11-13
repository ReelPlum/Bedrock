//! Eraser hit testing. Two modes:
//! * whole-stroke: anything the eraser touches disappears,
//! * partial: only the touched part is cut away and the rest is kept as new
//!   strokes (remembering which stroke they came from).

use crate::geom::{point_segment_distance, segment_segment_distance, Rect, Vec2};
use crate::input::InputPoint;
use crate::stroke::{Stroke, StrokeId};
use rstar::primitives::{GeomWithData, Rectangle};
use rstar::{RTree, AABB};

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

/// One segment of a [`PathIndex`]: its box, and its two ends.
type PathSegment = GeomWithData<Rectangle<[f64; 2]>, (Vec2, Vec2)>;

/// The segments of a long path (a scribble) in an R-tree, so "does this
/// stroke touch the path?" looks only at the path's segments near each of
/// the stroke's own, instead of at every segment of the path: a scribble
/// has hundreds of segments and goes over the same ink again and again.
pub struct PathIndex {
    tree: RTree<PathSegment>,
}

impl PathIndex {
    pub fn new(points: &[Vec2]) -> Self {
        let segs = points
            .windows(2)
            .map(|w| {
                let r = segment_rect(w[0], w[1], 0.0);
                GeomWithData::new(Rectangle::from_corners([r.min.x, r.min.y], [r.max.x, r.max.y]), (w[0], w[1]))
            })
            .collect();
        PathIndex { tree: RTree::bulk_load(segs) }
    }

    /// Exactly [`touches`] for some segment of the path: some segment of
    /// the path `radius` wide comes within the stroke's ink.
    pub fn touches(&self, stroke: &Stroke, radius: f64) -> bool {
        let pts = &stroke.points;
        // Every pair within reach has overlapping boxes once the stroke's
        // segment box is grown by the reach, so the query misses nothing.
        let near = |a: Vec2, b: Vec2, reach: f64| {
            let r = segment_rect(a, b, reach);
            let env = AABB::from_corners([r.min.x, r.min.y], [r.max.x, r.max.y]);
            self.tree.locate_in_envelope_intersecting(env).any(|g| {
                let (c, d) = g.data;
                segment_segment_distance(a, b, c, d) <= reach
            })
        };
        match pts.len() {
            0 => false,
            1 => {
                let p = pts[0].pos();
                near(p, p, radius + half_width(stroke, &pts[0]))
            }
            _ => pts.windows(2).any(|w| {
                let reach = radius + half_width(stroke, &w[0]).max(half_width(stroke, &w[1]));
                near(w[0].pos(), w[1].pos(), reach)
            }),
        }
    }
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
            s.input_scale = stroke.input_scale;
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

/// Where segments `p0 p1` and `q0 q1` cross: the parameter along `p0 p1`
/// (0..=1), or None if they don't.
fn crossing(p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2) -> Option<f64> {
    let r = p1 - p0;
    let s = q1 - q0;
    let den = r.x * s.y - r.y * s.x;
    if den.abs() < 1e-12 {
        return None;
    }
    let d = q0 - p0;
    let t = (d.x * s.y - d.y * s.x) / den;
    let u = (d.x * r.y - d.y * r.x) / den;
    ((0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u)).then_some(t)
}

fn lerp_point(a: &InputPoint, b: &InputPoint, t: f64) -> InputPoint {
    let pos = a.pos().lerp(b.pos(), t);
    InputPoint {
        x: pos.x,
        y: pos.y,
        pressure: a.pressure + (b.pressure - a.pressure) * t as f32,
        altitude: a.altitude + (b.altitude - a.altitude) * t as f32,
        azimuth: a.azimuth,
        t: a.t + (b.t - a.t) * t,
    }
}

/// Trimmer eraser (as Fresco's): cut out the part of `stroke` under the
/// eraser segment `a b`, from the nearest place before it where the stroke
/// crosses another stroke (or itself) to the nearest one after it. With no
/// crossings on a side, the cut runs to that end; with none at all, the
/// whole stroke goes. Returns the pieces that remain (possibly none), or
/// None if the eraser doesn't touch the stroke.
pub fn trim(
    stroke: &Stroke,
    others: &[&Stroke],
    a: Vec2,
    b: Vec2,
    radius: f64,
    mut new_id: impl FnMut() -> StrokeId,
) -> Option<Vec<Stroke>> {
    if !touches(stroke, a, b, radius) {
        return None;
    }
    let pts = &stroke.points;
    if pts.len() < 2 {
        return Some(Vec::new());
    }
    // Position along the stroke as (segment index, t within it), compared
    // as a single number i + t.
    let hit = pts
        .windows(2)
        .enumerate()
        .map(|(i, w)| {
            let d = segment_segment_distance(w[0].pos(), w[1].pos(), a, b);
            // Where along this segment the eraser is closest.
            let mid = a.lerp(b, 0.5);
            let seg = w[1].pos() - w[0].pos();
            let len2 = seg.dot(seg);
            let t = if len2 > 0.0 { ((mid - w[0].pos()).dot(seg) / len2).clamp(0.0, 1.0) } else { 0.0 };
            (d, i as f64 + t)
        })
        .min_by(|x, y| x.0.total_cmp(&y.0))
        .map(|x| x.1)
        .unwrap_or(0.0);
    let mut cuts: Vec<f64> = Vec::new();
    for (i, w) in pts.windows(2).enumerate() {
        let (p0, p1) = (w[0].pos(), w[1].pos());
        let seg_rect = segment_rect(p0, p1, 0.0);
        for o in others {
            if !o.bounds().intersects(&seg_rect) {
                continue;
            }
            for v in o.points.windows(2) {
                if let Some(t) = crossing(p0, p1, v[0].pos(), v[1].pos()) {
                    cuts.push(i as f64 + t);
                }
            }
        }
        // Crossing itself (a loop), skipping neighbouring segments.
        for (j, v) in pts.windows(2).enumerate() {
            if j + 1 < i || j > i + 1 {
                if let Some(t) = crossing(p0, p1, v[0].pos(), v[1].pos()) {
                    cuts.push(i as f64 + t);
                }
            }
        }
    }
    let lo = cuts.iter().copied().filter(|c| *c < hit).fold(None, |m: Option<f64>, c| Some(m.map_or(c, |m| m.max(c))));
    let hi = cuts.iter().copied().filter(|c| *c > hit).fold(None, |m: Option<f64>, c| Some(m.map_or(c, |m| m.min(c))));
    let at = |pos: f64| {
        let i = (pos.floor() as usize).min(pts.len() - 2);
        lerp_point(&pts[i], &pts[i + 1], pos - i as f64)
    };
    let mut pieces = Vec::new();
    let mut make = |run: Vec<InputPoint>| {
        let len: f64 = run.windows(2).map(|w| w[0].pos().distance(w[1].pos())).sum();
        if run.len() >= 2 && len > 1e-6 {
            let mut s = Stroke::new(new_id(), stroke.brush, stroke.start_time, stroke.device, run);
            s.input_scale = stroke.input_scale;
            s.derived_from = if stroke.derived_from.is_empty() { vec![stroke.id] } else { stroke.derived_from.clone() };
            pieces.push(s);
        }
    };
    if let Some(lo) = lo {
        let mut run: Vec<InputPoint> = pts.iter().take(lo.floor() as usize + 1).copied().collect();
        run.push(at(lo));
        make(run);
    }
    if let Some(hi) = hi {
        let mut run = vec![at(hi)];
        run.extend(pts.iter().skip(hi.floor() as usize + 1).copied());
        make(run);
    }
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

    fn vline(id: u64, x: f64) -> Stroke {
        let pts = (0..=10).map(|i| InputPoint::new(x, -50.0 + i as f64 * 10.0, 0.5).at(i as f64)).collect();
        Stroke::new(StrokeId(id), Brush::default(), 1000.0, InputDevice::Pen, pts)
    }

    #[test]
    fn trimmer_cuts_between_crossings() {
        // A horizontal line crossed by vertical lines at x = 20 and x = 70.
        let h = hline(1, 0.0);
        let (v1, v2) = (vline(2, 20.0), vline(3, 70.0));
        let mut next = 100;
        let mut id = || {
            next += 1;
            StrokeId(next)
        };
        // Erase in the middle: the part between 20 and 70 goes.
        let pieces = trim(&h, &[&v1, &v2], Vec2::new(45.0, -5.0), Vec2::new(45.0, 5.0), 2.0, &mut id).unwrap();
        assert_eq!(pieces.len(), 2);
        assert!((pieces[0].points.last().unwrap().x - 20.0).abs() < 1e-9);
        assert!((pieces[1].points[0].x - 70.0).abs() < 1e-9);
        assert_eq!(pieces[0].points[0].x, 0.0);
        assert_eq!(pieces[1].points.last().unwrap().x, 100.0);
        assert!(pieces.iter().all(|p| p.derived_from == vec![StrokeId(1)]));
        // Erase the end: it goes back to the last crossing only.
        let pieces = trim(&h, &[&v1, &v2], Vec2::new(90.0, -5.0), Vec2::new(90.0, 5.0), 2.0, &mut id).unwrap();
        assert_eq!(pieces.len(), 1);
        assert!((pieces[0].points.last().unwrap().x - 70.0).abs() < 1e-9);
        // No crossings: the whole stroke goes.
        assert!(trim(&h, &[], Vec2::new(45.0, -5.0), Vec2::new(45.0, 5.0), 2.0, &mut id).unwrap().is_empty());
        // Missed: nothing happens.
        assert!(trim(&h, &[&v1], Vec2::new(45.0, 30.0), Vec2::new(45.0, 40.0), 2.0, &mut id).is_none());
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
