//! Stroke geometry: smoothing, resampling and conversion to
//! * a triangle [`Mesh`] for the GPU renderer, and
//! * a closed outline polygon for SVG export.
//!
//! Both come from the same samples so screen and file look identical.

use crate::brush::{Footprint, LineStyle};
use crate::geom::{Rect, Vec2};
use crate::input::InputPoint;
use crate::stroke::Stroke;
use std::f64::consts::PI;

/// One resampled point along the stroke centre line.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    pub pos: Vec2,
    pub width: f64,
    pub opacity: f32,
}

/// One piece of a stroke: a tapered capsule, i.e. every point within a
/// linearly varying radius of the segment `a`..`b` (a single round dab when
/// `a == b`). A stroke is drawn as the union of its capsules.
///
/// The GPU computes the exact distance to each capsule per pixel, so ends
/// are perfect circles and edges are smooth and antialiased at any zoom,
/// with no triangles to see and nothing that can fold over on sharp turns.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Segment {
    /// Endpoints relative to the mesh origin.
    pub a: [f32; 2],
    pub b: [f32; 2],
    /// Radius (half width) at `a` and `b`, world units.
    pub ra: f32,
    pub rb: f32,
    /// Opacity at `a` and `b` (0..=1).
    pub alpha_a: f32,
    pub alpha_b: f32,
}

/// A stroke's capsules, in coordinates relative to `origin` (keeps `f32`
/// precise anywhere on the infinite canvas).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mesh {
    pub origin: Vec2,
    pub segments: Vec<Segment>,
}

impl Mesh {
    pub fn segment_count(&self) -> usize {
        self.segments.len()
    }

    pub fn bounds(&self) -> Rect {
        let mut r = Rect::EMPTY;
        for g in &self.segments {
            for (p, rad) in [(g.a, g.ra), (g.b, g.rb)] {
                let c = Vec2::new(p[0] as f64 + self.origin.x, p[1] as f64 + self.origin.y);
                let rad = rad as f64;
                r.include(c - Vec2::new(rad, rad));
                r.include(c + Vec2::new(rad, rad));
            }
        }
        r
    }

    /// Append another mesh (re-based onto this mesh's origin).
    pub fn append(&mut self, other: &Mesh) {
        if self.segments.is_empty() {
            self.origin = other.origin;
        }
        let dx = (other.origin.x - self.origin.x) as f32;
        let dy = (other.origin.y - self.origin.y) as f32;
        self.segments.extend(other.segments.iter().map(|g| Segment {
            a: [g.a[0] + dx, g.a[1] + dy],
            b: [g.b[0] + dx, g.b[1] + dy],
            ..*g
        }));
    }

    fn push(&mut self, a: &Sample, b: &Sample) {
        let rel = |p: Vec2| [(p.x - self.origin.x) as f32, (p.y - self.origin.y) as f32];
        self.segments.push(Segment {
            a: rel(a.pos),
            b: rel(b.pos),
            ra: (a.width / 2.0) as f32,
            rb: (b.width / 2.0) as f32,
            alpha_a: a.opacity.clamp(0.0, 1.0),
            alpha_b: b.opacity.clamp(0.0, 1.0),
        });
    }
}

fn circle_segments(r: f64, sweep: f64) -> usize {
    let full = (r * 4.0).clamp(16.0, 64.0);
    ((full * sweep.abs() / (2.0 * PI)).ceil() as usize).max(2)
}

/// Light smoothing of raw input (a [1, 2, 1] kernel on position and pressure)
/// that removes digitiser jitter without visibly rounding corners.
pub fn smooth(points: &[InputPoint]) -> Vec<InputPoint> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut out = Vec::with_capacity(points.len());
    out.push(points[0]);
    for w in points.windows(3) {
        let (a, b, c) = (w[0], w[1], w[2]);
        let mut p = b;
        p.x = 0.25 * a.x + 0.5 * b.x + 0.25 * c.x;
        p.y = 0.25 * a.y + 0.5 * b.y + 0.25 * c.y;
        p.pressure = 0.25 * a.pressure + 0.5 * b.pressure + 0.25 * c.pressure;
        out.push(p);
    }
    out.push(*points.last().unwrap());
    out
}

fn lerp_angle(a: f32, b: f32, t: f32) -> f32 {
    let mut d = (b - a) % (2.0 * std::f32::consts::PI);
    if d > std::f32::consts::PI {
        d -= 2.0 * std::f32::consts::PI;
    } else if d < -std::f32::consts::PI {
        d += 2.0 * std::f32::consts::PI;
    }
    a + d * t
}

fn catmull_rom(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: f64) -> Vec2 {
    let t2 = t * t;
    let t3 = t2 * t;
    let f = |a: f64, b: f64, c: f64, d: f64| {
        0.5 * ((2.0 * b) + (-a + c) * t + (2.0 * a - 5.0 * b + 4.0 * c - d) * t2 + (-a + 3.0 * b - 3.0 * c + d) * t3)
    };
    Vec2::new(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y))
}

/// Longest stabiliser lag (at strength 1).
pub const MAX_STABILIZER_MS: f64 = 90.0;

/// Stabiliser: the drawn point follows the pen through a time-based
/// exponential filter (rate independent, so 60, 120 and 240 Hz input feel
/// the same). The stroke still ends exactly where the pen lifted.
pub fn stabilize(points: &[InputPoint], amount: f32) -> Vec<InputPoint> {
    let tau = (amount.clamp(0.0, 1.0) as f64).powf(1.5) * MAX_STABILIZER_MS;
    if points.len() < 3 || tau <= 0.0 {
        return points.to_vec();
    }
    let mut out = Vec::with_capacity(points.len() + 1);
    let mut s = points[0];
    out.push(s);
    for w in points.windows(2) {
        let (prev, p) = (w[0], w[1]);
        let dt = (p.t - prev.t).max(1.0);
        let a = 1.0 - (-dt / tau).exp();
        let mut q = p;
        q.x = s.x + (p.x - s.x) * a;
        q.y = s.y + (p.y - s.y) * a;
        s = q;
        out.push(q);
    }
    // Catch up with the pen so the line ends where it was lifted.
    let last = *points.last().unwrap();
    if s.pos().distance(last.pos()) > 1e-6 {
        out.push(last);
    }
    out
}

/// Interpolated input points along a Catmull-Rom spline through `pts`.
fn resample(pts: &[InputPoint], step: f64) -> Vec<InputPoint> {
    if pts.len() < 2 {
        return pts.to_vec();
    }
    let mut out = Vec::with_capacity(pts.len() * 2);
    let n = pts.len();
    for i in 0..n - 1 {
        let p0 = pts[i.saturating_sub(1)].pos();
        let p1 = pts[i].pos();
        let p2 = pts[i + 1].pos();
        let p3 = pts[(i + 2).min(n - 1)].pos();
        let subdivisions = ((p1.distance(p2) / step).ceil() as usize).clamp(1, 64);
        for s in 0..subdivisions {
            let t = s as f64 / subdivisions as f64;
            let pos = catmull_rom(p0, p1, p2, p3, t);
            let a = pts[i];
            let b = pts[i + 1];
            let tf = t as f32;
            out.push(InputPoint {
                x: pos.x,
                y: pos.y,
                pressure: a.pressure + (b.pressure - a.pressure) * tf,
                altitude: a.altitude + (b.altitude - a.altitude) * tf,
                azimuth: lerp_angle(a.azimuth, b.azimuth, tf),
                t: a.t + (b.t - a.t) * t,
            });
        }
    }
    out.push(pts[n - 1]);
    out
}

/// Centre-line samples with brush footprints applied.
pub fn samples(stroke: &Stroke) -> Vec<Sample> {
    samples_for(stroke, &stroke.points)
}

/// Like [`samples`] but for an explicit point list (used for live strokes
/// with predicted points appended).
pub fn samples_for(stroke: &Stroke, points: &[InputPoint]) -> Vec<Sample> {
    samples_with_step(stroke, points, 1.0)
}

/// Coarser samples (`scale` times the normal spacing), e.g. for thumbnails.
pub fn samples_coarse(stroke: &Stroke, scale: f64) -> Vec<Sample> {
    samples_with_step(stroke, &stroke.points, scale)
}

fn samples_with_step(stroke: &Stroke, points: &[InputPoint], scale: f64) -> Vec<Sample> {
    let stabilized;
    let points = if stroke.brush.stabilizer > 0.0 {
        stabilized = stabilize(points, stroke.brush.stabilizer);
        &stabilized[..]
    } else {
        points
    };
    let smoothed = smooth(points);
    // Dense resampling: capsules are cheap on the GPU and long straight runs
    // are merged again afterwards, so curves can be finely sampled.
    let step = (stroke.brush.size as f64 * 0.15).clamp(0.15, 0.75) * scale.max(1.0);
    let pts = resample(&smoothed, step);
    // Drop duplicates so tangents are well defined.
    let mut dedup: Vec<InputPoint> = Vec::with_capacity(pts.len());
    for p in pts {
        if dedup.last().is_none_or(|l| l.pos().distance(p.pos()) > 1e-6) {
            dedup.push(p);
        }
    }
    let alpha = stroke.brush.stroke_alpha();
    let n = dedup.len();
    if n == 0 {
        return Vec::new();
    }
    // Arc length at each point.
    let mut arc = Vec::with_capacity(n);
    let mut acc = 0.0;
    for i in 0..n {
        if i > 0 {
            acc += dedup[i].pos().distance(dedup[i - 1].pos());
        }
        arc.push(acc);
    }
    // Direction of travel, measured over a short stretch of line rather than
    // between neighbouring points: when the pen moves slowly the points are a
    // fraction of a unit apart and their direction is mostly digitiser noise,
    // which made direction-sensitive nibs flicker between thin and fat.
    let size = stroke.brush.size.max(0.1) as f64;
    let reach = (size * 0.75).clamp(1.0, 6.0);
    let (mut lo, mut hi) = (0usize, 0usize);
    let angles: Vec<f32> = (0..n)
        .map(|i| {
            while arc[i] - arc[lo] > reach {
                lo += 1;
            }
            hi = hi.max(i);
            while hi + 1 < n && arc[hi] - arc[i] < reach {
                hi += 1;
            }
            let d = dedup[hi].pos() - dedup[lo].pos();
            if d.length() > 0.0 {
                d.y.atan2(d.x) as f32
            } else {
                0.0
            }
        })
        .collect();
    let mut out: Vec<Sample> = (0..n)
        .map(|i| {
            let Footprint { width, opacity } = stroke.brush.footprint(&dedup[i], angles[i]);
            Sample { pos: dedup[i].pos(), width: width as f64, opacity: opacity * alpha }
        })
        .collect();
    calm_widths(&mut out, &arc, size);
    out
}

/// Keep width and opacity changes gradual along the line.
///
/// Pressure and tilt from a real pen are noisy, and a single spike, or a
/// pause where the pen presses harder, used to show up as a blob. Two
/// passes fix that without dulling deliberate swells and tapers:
/// * a light forward-backward smoothing over about one brush size of line,
/// * a slope limit: the radius may grow at most ~0.35 units per unit of
///   line, so the stroke can't balloon in a short distance.
fn calm_widths(s: &mut [Sample], arc: &[f64], size: f64) {
    let n = s.len();
    if n < 3 {
        return;
    }
    let span = (size * 0.8).clamp(0.6, 8.0);
    for pass in 0..2 {
        let idx: Vec<usize> = if pass == 0 { (0..n).collect() } else { (0..n).rev().collect() };
        let (mut w, mut o) = (s[idx[0]].width, s[idx[0]].opacity as f64);
        for k in 1..n {
            let (i, j) = (idx[k], idx[k - 1]);
            let ds = (arc[i] - arc[j]).abs();
            let a = 1.0 - (-ds / span).exp();
            w += (s[i].width - w) * a;
            o += (s[i].opacity as f64 - o) * a;
            s[i].width = w;
            s[i].opacity = o as f32;
        }
    }
    const MAX_SLOPE: f64 = 0.7; // width per unit of arc length (radius 0.35)
    for i in 1..n {
        let ds = arc[i] - arc[i - 1];
        s[i].width = s[i].width.min(s[i - 1].width + MAX_SLOPE * ds);
    }
    for i in (0..n - 1).rev() {
        let ds = arc[i + 1] - arc[i];
        s[i].width = s[i].width.min(s[i + 1].width + MAX_SLOPE * ds);
    }
}

fn tangents(s: &[Sample]) -> Vec<Vec2> {
    let n = s.len();
    (0..n)
        .map(|i| {
            let din = if i > 0 { (s[i].pos - s[i - 1].pos).normalized() } else { Vec2::ZERO };
            let dout = if i + 1 < n { (s[i + 1].pos - s[i].pos).normalized() } else { Vec2::ZERO };
            let t = (din + dout).normalized();
            if t == Vec2::ZERO {
                if dout != Vec2::ZERO {
                    dout
                } else {
                    din
                }
            } else {
                t
            }
        })
        .collect()
}

/// GPU mesh for a stroke (handles dashed and dotted styles).
pub fn mesh(stroke: &Stroke) -> Mesh {
    mesh_for(stroke, &samples(stroke))
}

/// Mesh for explicit samples of `stroke` (e.g. a live stroke with predictions).
pub fn mesh_for(stroke: &Stroke, s: &[Sample]) -> Mesh {
    let parts = pieces(stroke, s);
    let mut m = Mesh { origin: s.first().map(|s| s.pos).unwrap_or_default(), ..Default::default() };
    for p in &parts {
        m.append(&mesh_from_samples(p));
    }
    m
}

/// Split the centre line into the visible pieces of its line style: one
/// piece for solid, dashes for dashed, single-sample dots for dotted.
pub fn pieces(stroke: &Stroke, s: &[Sample]) -> Vec<Vec<Sample>> {
    let size = stroke.brush.size.max(0.1) as f64;
    let (on, off) = match stroke.brush.style {
        LineStyle::Solid => return vec![s.to_vec()],
        LineStyle::Dashed => (size * 4.0, size * 2.5),
        LineStyle::Dotted => (0.0, size * 2.2),
    };
    if s.len() < 2 {
        return vec![s.to_vec()];
    }
    let period = on + off.max(0.5);
    let mut out: Vec<Vec<Sample>> = Vec::new();
    let mut dist = 0.0f64; // arc length at s[i]
    let lerp = |a: &Sample, b: &Sample, t: f64| Sample {
        pos: a.pos.lerp(b.pos, t),
        width: a.width + (b.width - a.width) * t,
        opacity: a.opacity + (b.opacity - a.opacity) * t as f32,
    };
    if on == 0.0 {
        // Dots: one round dab every `period` along the line, starting at 0.
        out.push(vec![s[0]]);
        let mut next = period;
        for w in s.windows(2) {
            let seg = w[0].pos.distance(w[1].pos);
            while next <= dist + seg && seg > 0.0 {
                out.push(vec![lerp(&w[0], &w[1], (next - dist) / seg)]);
                next += period;
            }
            dist += seg;
        }
        return out;
    }
    // Walk the line once, toggling between dash and gap at each boundary. The
    // state is tracked explicitly so a boundary that lands exactly on a sample
    // can't be counted twice or skipped by float rounding.
    let gap = off.max(0.5);
    let mut drawing = true;
    let mut next = on;
    let mut current: Vec<Sample> = vec![s[0]];
    for w in s.windows(2) {
        let seg = w[0].pos.distance(w[1].pos);
        if seg <= 0.0 {
            continue;
        }
        while next <= dist + seg {
            let b = lerp(&w[0], &w[1], (next - dist) / seg);
            if drawing {
                current.push(b);
                out.push(std::mem::take(&mut current));
                next += gap;
            } else {
                current = vec![b];
                next += on;
            }
            drawing = !drawing;
        }
        if drawing && current.last().is_none_or(|l| l.pos.distance(w[1].pos) > 1e-9) {
            current.push(w[1]);
        }
        dist += seg;
    }
    if drawing && current.len() > 1 {
        out.push(current);
    }
    out.retain(|p| !p.is_empty());
    out
}

/// How far (world units) a merged capsule may stray from the samples it
/// replaces. Invisible even zoomed in 10x, and it keeps long straight or
/// gently curved runs to a few capsules.
const MERGE_TOLERANCE: f64 = 0.015;
/// Longest run of samples merged into one capsule.
const MAX_MERGE: usize = 32;

pub fn mesh_from_samples(s: &[Sample]) -> Mesh {
    let mut m = Mesh { origin: s.first().map(|s| s.pos).unwrap_or_default(), ..Default::default() };
    match s.len() {
        0 => return m,
        1 => {
            m.push(&s[0], &s[0]);
            return m;
        }
        _ => {}
    }
    // Can samples i..=k be drawn as one capsule from i to k?
    let fits = |i: usize, k: usize| {
        let (a, b) = (s[i], s[k]);
        let d = b.pos - a.pos;
        let len2 = d.dot(d);
        (i + 1..k).all(|j| {
            let t = if len2 > 0.0 { ((s[j].pos - a.pos).dot(d) / len2).clamp(0.0, 1.0) } else { 0.0 };
            let off = s[j].pos.distance(a.pos + d * t);
            let w = a.width + (b.width - a.width) * t;
            let o = a.opacity + (b.opacity - a.opacity) * t as f32;
            off <= MERGE_TOLERANCE
                && (s[j].width - w).abs() <= 2.0 * MERGE_TOLERANCE
                && (s[j].opacity - o).abs() <= 0.02
        })
    };
    let mut i = 0;
    while i + 1 < s.len() {
        let mut k = i + 1;
        while k + 1 < s.len() && k + 1 - i <= MAX_MERGE && fits(i, k + 1) {
            k += 1;
        }
        m.push(&s[i], &s[k]);
        i = k;
    }
    m
}

/// Closed outline polygon (for SVG) of a solid stroke. Self-intersections
/// are fine with the non-zero fill rule.
pub fn outline(stroke: &Stroke) -> Vec<Vec2> {
    outline_from_samples(&samples(stroke))
}

/// Outline polygons of every visible piece (dashes / dots) of a stroke.
pub fn outlines(stroke: &Stroke) -> Vec<Vec<Vec2>> {
    outlines_for(stroke, &samples(stroke))
}

/// Points closer together than this (world units) are dropped from SVG
/// outlines: invisible, and it keeps files small and fast to write.
const OUTLINE_MIN_STEP: f64 = 0.2;

/// Like [`outlines`] for samples already computed.
pub fn outlines_for(stroke: &Stroke, s: &[Sample]) -> Vec<Vec<Vec2>> {
    pieces(stroke, s)
        .iter()
        .map(|p| {
            let o = outline_from_samples(p);
            let mut out: Vec<Vec2> = Vec::with_capacity(o.len());
            for q in o {
                if out.last().is_none_or(|l| l.distance(q) >= OUTLINE_MIN_STEP) {
                    out.push(q);
                }
            }
            out
        })
        .filter(|o| !o.is_empty())
        .collect()
}

pub fn outline_from_samples(s: &[Sample]) -> Vec<Vec2> {
    let arc = |out: &mut Vec<Vec2>, c: Vec2, r: f64, a0: f64, sweep: f64| {
        let segs = circle_segments(r, sweep);
        for i in 1..segs {
            let a = a0 + sweep * i as f64 / segs as f64;
            out.push(c + Vec2::new(a.cos(), a.sin()) * r);
        }
    };
    let mut out = Vec::new();
    match s.len() {
        0 => return out,
        1 => {
            let r = s[0].width / 2.0;
            out.push(s[0].pos + Vec2::new(r, 0.0));
            arc(&mut out, s[0].pos, r, 0.0, 2.0 * PI);
            return out;
        }
        _ => {}
    }
    let tan = tangents(s);
    let n = s.len();
    for i in 0..n {
        out.push(s[i].pos + tan[i].perp() * (s[i].width / 2.0));
    }
    // End cap: from the left side around the front to the right side.
    let lp = tan[n - 1].perp();
    arc(&mut out, s[n - 1].pos, s[n - 1].width / 2.0, lp.y.atan2(lp.x), -PI);
    for i in (0..n).rev() {
        out.push(s[i].pos - tan[i].perp() * (s[i].width / 2.0));
    }
    let rp = -1.0;
    let fp = tan[0].perp() * rp;
    arc(&mut out, s[0].pos, s[0].width / 2.0, fp.y.atan2(fp.x), -PI);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::{Brush, BrushKind};
    use crate::color::Rgba;
    use crate::stroke::{InputDevice, StrokeId};

    fn line(kind: BrushKind, n: usize) -> Stroke {
        let pts = (0..n).map(|i| InputPoint::new(i as f64 * 5.0, 0.0, 0.5).at(i as f64 * 4.0)).collect();
        Stroke::new(StrokeId(1), Brush::new(kind, Rgba::BLACK, 4.0), 0.0, InputDevice::Pen, pts)
    }

    fn assert_valid(m: &Mesh) {
        for g in &m.segments {
            assert!(g.a.iter().chain(&g.b).all(|c| c.is_finite()));
            assert!(g.ra > 0.0 && g.rb > 0.0 && g.ra.is_finite() && g.rb.is_finite());
            assert!((0.0..=1.0).contains(&g.alpha_a) && (0.0..=1.0).contains(&g.alpha_b));
        }
    }

    #[test]
    fn empty_stroke_has_empty_mesh() {
        let m = mesh(&line(BrushKind::Pen, 0));
        assert!(m.segments.is_empty());
        assert!(outline(&line(BrushKind::Pen, 0)).is_empty());
    }

    #[test]
    fn tap_makes_a_dot() {
        let s = line(BrushKind::Pen, 1);
        let m = mesh(&s);
        assert_valid(&m);
        assert_eq!(m.segment_count(), 1, "one round dab");
        assert_eq!(m.segments[0].a, m.segments[0].b);
        let b = m.bounds();
        let w = Brush::new(BrushKind::Pen, Rgba::BLACK, 4.0).footprint(&s.points[0], 0.0).width as f64;
        assert!((b.width() - w).abs() < 0.1, "dot width {} vs {}", b.width(), w);
    }

    #[test]
    fn line_mesh_is_valid_and_covers_the_line() {
        for kind in BrushKind::ALL {
            let s = line(kind, 20);
            let m = mesh(&s);
            assert_valid(&m);
            let b = m.bounds();
            assert!(b.min.x <= 0.0 && b.max.x >= 95.0, "{kind:?} bounds {b:?}");
            // Never larger than the stroke's conservative bounds.
            assert!(s.bounds().inflate(0.01).contains(b.min) && s.bounds().inflate(0.01).contains(b.max));
        }
    }

    #[test]
    fn mesh_is_precise_far_from_origin() {
        let pts = (0..10).map(|i| InputPoint::new(1.0e9 + i as f64 * 0.5, -3.0e9, 1.0)).collect();
        let s = Stroke::new(StrokeId(2), Brush::default(), 0.0, InputDevice::Pen, pts);
        let m = mesh(&s);
        assert_valid(&m);
        assert!(m.segments.iter().all(|g| g.a.iter().chain(&g.b).all(|c| c.abs() < 100.0)));
    }

    #[test]
    fn outline_is_closed_polygon_around_samples() {
        let s = line(BrushKind::Marker, 10);
        let o = outline(&s);
        assert!(o.len() > 20);
        let mut r = Rect::EMPTY;
        o.iter().for_each(|p| r.include(*p));
        assert!(r.min.x < 0.0 && r.max.x > 45.0);
        assert!(r.height() > 3.0);
    }

    #[test]
    fn smoothing_keeps_endpoints() {
        let pts: Vec<_> = (0..5).map(|i| InputPoint::new(i as f64, (i % 2) as f64, 0.5)).collect();
        let sm = smooth(&pts);
        assert_eq!(sm.len(), pts.len());
        assert_eq!(sm[0], pts[0]);
        assert_eq!(sm[4], pts[4]);
        assert!((sm[1].y - 0.5).abs() < 1e-9);
    }

    #[test]
    fn resample_density_follows_step() {
        let pts = vec![InputPoint::new(0.0, 0.0, 0.5), InputPoint::new(10.0, 0.0, 0.5)];
        let r = resample(&pts, 1.0);
        assert_eq!(r.len(), 11);
        // Catmull-Rom is not arc-length parametrised; allow some slack.
        for w in r.windows(2) {
            assert!(w[0].pos().distance(w[1].pos()) <= 1.5);
        }
    }

    fn styled(style: LineStyle) -> Stroke {
        let mut s = line(BrushKind::Pen, 41); // 200 units long
        s.brush = s.brush.with_style(style);
        s
    }

    #[test]
    fn dashed_line_has_gaps() {
        let s = styled(LineStyle::Dashed);
        let smp = samples(&s);
        let p = pieces(&s, &smp);
        // size 4: dash 16 + gap 10 = 26 per period over 200 units -> 8 dashes.
        assert_eq!(p.len(), 8, "{} dashes", p.len());
        for d in &p {
            let len = d.first().unwrap().pos.distance(d.last().unwrap().pos);
            assert!(len <= 16.0 + 1e-6, "dash length {len}");
        }
        // Nothing is drawn in the middle of the first gap (x 16..26, minus the round caps).
        let m = mesh(&s);
        assert!(m.segments.iter().all(|g| {
            let (x0, x1) = (g.a[0] as f64 + m.origin.x - g.ra as f64, g.b[0] as f64 + m.origin.x + g.rb as f64);
            x1 <= 19.0 || x0 >= 23.0
        }));
        // A dash boundary that lands exactly on a sample (x = 120) still splits there.
        assert!(p.iter().any(|d| (d[0].pos.x - 104.0).abs() < 1e-6 && (d.last().unwrap().pos.x - 120.0).abs() < 1e-6));
        assert_eq!(outlines(&s).len(), 8);
    }

    #[test]
    fn dotted_line_is_evenly_spaced_dots() {
        let s = styled(LineStyle::Dotted);
        let p = pieces(&s, &samples(&s));
        assert!(p.iter().all(|d| d.len() == 1));
        // spacing 8.8 over 200 units -> 23 dots including the first.
        assert_eq!(p.len(), 23);
        for w in p.windows(2) {
            assert!((w[0][0].pos.distance(w[1][0].pos) - 8.8).abs() < 0.05);
        }
    }

    #[test]
    fn solid_is_one_piece() {
        let s = styled(LineStyle::Solid);
        assert_eq!(pieces(&s, &samples(&s)).len(), 1);
    }

    #[test]
    fn stabilizer_smooths_jitter_and_ends_at_the_pen() {
        // A shaky horizontal line: y alternates +-2 at 240 Hz.
        let pts: Vec<_> = (0..120)
            .map(|i| InputPoint::new(i as f64 * 2.0, if i % 2 == 0 { 2.0 } else { -2.0 }, 0.5).at(i as f64 * 4.2))
            .collect();
        let shake = |p: &[InputPoint]| p.windows(2).map(|w| (w[1].y - w[0].y).abs()).sum::<f64>() / p.len() as f64;
        let raw = shake(&pts);
        let st = stabilize(&pts, 0.8);
        assert!(shake(&st) < raw * 0.3, "raw {raw} stabilised {}", shake(&st));
        assert_eq!(st.last().unwrap().pos(), pts.last().unwrap().pos());
        assert_eq!(stabilize(&pts, 0.0), pts, "off means untouched");
    }

    #[test]
    fn stabilizer_is_rate_independent() {
        // The same corner drawn at 60 Hz and 240 Hz lags by about the same distance.
        let corner = |hz: f64| -> f64 {
            let dt = 1000.0 / hz;
            let pts: Vec<_> = (0..(hz as usize / 2))
                .map(|i| {
                    let t = i as f64 * dt;
                    let x = if t < 250.0 { t * 0.4 } else { 100.0 };
                    let y = if t < 250.0 { 0.0 } else { (t - 250.0) * 0.4 };
                    InputPoint::new(x, y, 0.5).at(t)
                })
                .collect();
            let st = stabilize(&pts, 0.7);
            // Distance between pen and line right after the corner.
            let i = pts.iter().position(|p| p.t >= 300.0).unwrap();
            pts[i].pos().distance(st[i].pos())
        };
        let (a, b) = (corner(60.0), corner(240.0));
        assert!((a - b).abs() < a * 0.25, "60 Hz lag {a} vs 240 Hz lag {b}");
    }

    #[test]
    fn duplicate_points_do_not_produce_nan() {
        let pts = vec![InputPoint::new(1.0, 1.0, 0.5); 6];
        let s = Stroke::new(StrokeId(3), Brush::default(), 0.0, InputDevice::Pen, pts);
        let m = mesh(&s);
        assert_valid(&m);
        assert!(m.segment_count() > 0);
    }

    /// Distance from `p` to the union of the mesh's capsules (negative inside).
    fn sdf(m: &Mesh, p: Vec2) -> f64 {
        m.segments
            .iter()
            .map(|g| {
                let a = Vec2::new(g.a[0] as f64, g.a[1] as f64) + m.origin;
                let b = Vec2::new(g.b[0] as f64, g.b[1] as f64) + m.origin;
                let d = b - a;
                let l2 = d.dot(d);
                let t = if l2 > 0.0 { ((p - a).dot(d) / l2).clamp(0.0, 1.0) } else { 0.0 };
                p.distance(a + d * t) - (g.ra as f64 + (g.rb - g.ra) as f64 * t)
            })
            .fold(f64::INFINITY, f64::min)
    }

    #[test]
    fn dots_and_ends_are_true_circles() {
        // Bug: round ends were 12-sided polygons with visible flat edges.
        let s = Stroke::new(
            StrokeId(9),
            Brush::new(BrushKind::Marker, Rgba::BLACK, 30.0),
            0.0,
            InputDevice::Pen,
            vec![InputPoint::new(0.0, 0.0, 0.5)],
        );
        let m = mesh(&s);
        let r = m.segments[0].ra as f64;
        for i in 0..360 {
            let a = (i as f64).to_radians();
            let d = sdf(&m, Vec2::new(a.cos(), a.sin()) * r);
            assert!(d.abs() < 1e-4, "edge at {i} degrees is {d} off the circle");
        }
    }

    #[test]
    fn slow_jittery_reversal_has_no_spikes() {
        // Bug: a slow pen that turns back on itself (with digitiser jitter)
        // made the outline fold into spikes and triangles sticking out.
        let mut pts = Vec::new();
        let mut t = 0.0;
        for i in 0..80 {
            let x = if i < 40 { i as f64 * 0.25 } else { (80 - i) as f64 * 0.25 };
            let jitter = if i % 2 == 0 { 0.06 } else { -0.06 };
            pts.push(InputPoint::new(x, jitter + (i as f64 * 0.01), 0.7).at(t));
            t += 4.0;
        }
        let s = Stroke::new(StrokeId(10), Brush::new(BrushKind::Pen, Rgba::BLACK, 6.0), 0.0, InputDevice::Pen, pts);
        let m = mesh(&s);
        assert_valid(&m);
        let max_r = m.segments.iter().map(|g| g.ra.max(g.rb)).fold(0.0, f32::max) as f64;
        let b = m.bounds();
        // Everything stays within the widest radius of the centre line's extent.
        assert!(b.min.x >= -max_r - 1e-6 && b.max.x <= 10.0 + max_r + 1e-6, "{b:?}");
        assert!(b.height() <= 1.0 + 2.0 * max_r, "{b:?}");
    }

    #[test]
    fn pressure_spike_does_not_make_a_blob() {
        // Bug: one noisy pressure sample (or pressing harder while moving
        // slowly) ballooned the line into a blob.
        let pts: Vec<_> = (0..60)
            .map(|i| {
                let p = if i == 30 { 1.0 } else { 0.15 };
                InputPoint::new(i as f64 * 0.3, 0.0, p).at(i as f64 * 4.0)
            })
            .collect();
        let s = Stroke::new(StrokeId(11), Brush::new(BrushKind::Pen, Rgba::BLACK, 8.0), 0.0, InputDevice::Pen, pts);
        let smp = samples(&s);
        let base = smp[5].width;
        let peak = smp.iter().map(|x| x.width).fold(0.0, f64::max);
        assert!(peak < base * 1.6, "spike grew the line from {base} to {peak}");
        // Sustained pressure still widens the line.
        let pts: Vec<_> = (0..60)
            .map(|i| InputPoint::new(i as f64, 0.0, if i < 30 { 0.1 } else { 1.0 }).at(i as f64 * 4.0))
            .collect();
        let s = Stroke::new(StrokeId(12), Brush::new(BrushKind::Pen, Rgba::BLACK, 8.0), 0.0, InputDevice::Pen, pts);
        let smp = samples(&s);
        assert!(smp.last().unwrap().width > smp[0].width * 2.0);
    }

    #[test]
    fn fountain_nib_ignores_jitter_when_moving_slowly() {
        // Bug: at slow speed, direction between neighbouring samples is mostly
        // noise, so the direction-sensitive nib flickered between thin and fat.
        let pts: Vec<_> = (0..100)
            .map(|i| {
                let jitter = if i % 2 == 0 { 0.08 } else { -0.08 };
                InputPoint::new(i as f64 * 0.12, jitter, 0.5).at(i as f64 * 4.0)
            })
            .collect();
        let s =
            Stroke::new(StrokeId(13), Brush::new(BrushKind::Fountain, Rgba::BLACK, 6.0), 0.0, InputDevice::Pen, pts);
        let smp = samples(&s);
        let inner = &smp[smp.len() / 5..smp.len() * 4 / 5];
        let (lo, hi) = inner.iter().fold((f64::MAX, 0.0f64), |(l, h), x| (l.min(x.width), h.max(x.width)));
        assert!(hi < lo * 1.25, "width flickers between {lo} and {hi}");
    }

    #[test]
    fn straight_lines_use_few_capsules() {
        let m = mesh(&line(BrushKind::Pen, 41));
        assert!(m.segment_count() <= 20, "{} capsules for a straight line", m.segment_count());
    }
}
