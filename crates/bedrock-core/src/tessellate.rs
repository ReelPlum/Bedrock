//! Stroke geometry: smoothing, resampling and conversion to
//! * a triangle [`Mesh`] for the GPU renderer, and
//! * a closed outline polygon for SVG export.
//!
//! Both come from the same samples so screen and file look identical.

use crate::brush::Footprint;
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

/// Triangle mesh in coordinates relative to `origin` (keeps `f32` precise
/// anywhere on the infinite canvas). Vertex = `[x, y, alpha]`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mesh {
    pub origin: Vec2,
    pub vertices: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
}

impl Mesh {
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    pub fn bounds(&self) -> Rect {
        let mut r = Rect::EMPTY;
        for v in &self.vertices {
            r.include(Vec2::new(v[0] as f64 + self.origin.x, v[1] as f64 + self.origin.y));
        }
        r
    }

    fn vertex(&mut self, p: Vec2, alpha: f32) -> u32 {
        let i = self.vertices.len() as u32;
        self.vertices.push([(p.x - self.origin.x) as f32, (p.y - self.origin.y) as f32, alpha]);
        i
    }

    /// Fan of triangles approximating a circle arc around `c` from angle `a0`
    /// sweeping `sweep` radians.
    fn fan(&mut self, c: Vec2, r: f64, a0: f64, sweep: f64, alpha: f32) {
        let segs = circle_segments(r, sweep);
        let center = self.vertex(c, alpha);
        let mut prev = self.vertex(c + Vec2::new(a0.cos(), a0.sin()) * r, alpha);
        for i in 1..=segs {
            let a = a0 + sweep * i as f64 / segs as f64;
            let v = self.vertex(c + Vec2::new(a.cos(), a.sin()) * r, alpha);
            self.indices.extend_from_slice(&[center, prev, v]);
            prev = v;
        }
    }
}

fn circle_segments(r: f64, sweep: f64) -> usize {
    let full = (r * 3.0).clamp(8.0, 48.0);
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
    let smoothed = smooth(points);
    let step = (stroke.brush.size as f64 * 0.5).clamp(0.5, 3.0);
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
    (0..n)
        .map(|i| {
            let prev = dedup[i.saturating_sub(1)].pos();
            let next = dedup[(i + 1).min(n - 1)].pos();
            let d = next - prev;
            let angle = if d.length() > 0.0 { d.y.atan2(d.x) as f32 } else { 0.0 };
            let Footprint { width, opacity } = stroke.brush.footprint(&dedup[i], angle);
            Sample { pos: dedup[i].pos(), width: width as f64, opacity: opacity * alpha }
        })
        .collect()
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

/// GPU mesh for a stroke.
pub fn mesh(stroke: &Stroke) -> Mesh {
    mesh_from_samples(&samples(stroke))
}

pub fn mesh_from_samples(s: &[Sample]) -> Mesh {
    let mut m = Mesh { origin: s.first().map(|s| s.pos).unwrap_or_default(), ..Default::default() };
    match s.len() {
        0 => return m,
        1 => {
            m.fan(s[0].pos, s[0].width / 2.0, 0.0, 2.0 * PI, s[0].opacity);
            return m;
        }
        _ => {}
    }
    let tan = tangents(s);
    // Body: a triangle strip between the left and right offset curves.
    let mut prev: Option<(u32, u32)> = None;
    for (i, smp) in s.iter().enumerate() {
        let n = tan[i].perp() * (smp.width / 2.0);
        let l = m.vertex(smp.pos + n, smp.opacity);
        let r = m.vertex(smp.pos - n, smp.opacity);
        if let Some((pl, pr)) = prev {
            m.indices.extend_from_slice(&[pl, pr, l, pr, r, l]);
        }
        prev = Some((l, r));
    }
    // Round joins where the stroke turns sharply, so corners stay solid.
    for i in 1..s.len() - 1 {
        let din = (s[i].pos - s[i - 1].pos).normalized();
        let dout = (s[i + 1].pos - s[i].pos).normalized();
        // Only real corners (> ~45°) need a join; smooth curves are dense enough.
        if din.dot(dout) < 0.7 {
            m.fan(s[i].pos, s[i].width / 2.0, 0.0, 2.0 * PI, s[i].opacity);
        }
    }
    // Round caps.
    let first = s[0];
    let last = s[s.len() - 1];
    let a_start = tan[0].perp().y.atan2(tan[0].perp().x);
    m.fan(first.pos, first.width / 2.0, a_start, PI, first.opacity);
    let te = tan[s.len() - 1];
    let a_end = (-te.perp().y).atan2(-te.perp().x);
    m.fan(last.pos, last.width / 2.0, a_end, PI, last.opacity);
    m
}

/// Closed outline polygon (for SVG). Self-intersections are fine with the
/// non-zero fill rule.
pub fn outline(stroke: &Stroke) -> Vec<Vec2> {
    outline_from_samples(&samples(stroke))
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
        assert_eq!(m.indices.len() % 3, 0);
        for &i in &m.indices {
            assert!((i as usize) < m.vertices.len(), "index out of range");
        }
        for v in &m.vertices {
            assert!(v.iter().all(|c| c.is_finite()));
            assert!(v[2] >= 0.0 && v[2] <= 1.0);
        }
    }

    #[test]
    fn empty_stroke_has_empty_mesh() {
        let m = mesh(&line(BrushKind::Pen, 0));
        assert!(m.vertices.is_empty());
        assert!(outline(&line(BrushKind::Pen, 0)).is_empty());
    }

    #[test]
    fn tap_makes_a_dot() {
        let s = line(BrushKind::Pen, 1);
        let m = mesh(&s);
        assert_valid(&m);
        assert!(m.triangle_count() >= 8);
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
        assert!(m.vertices.iter().all(|v| v[0].abs() < 100.0 && v[1].abs() < 100.0));
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

    #[test]
    fn duplicate_points_do_not_produce_nan() {
        let pts = vec![InputPoint::new(1.0, 1.0, 0.5); 6];
        let s = Stroke::new(StrokeId(3), Brush::default(), 0.0, InputDevice::Pen, pts);
        let m = mesh(&s);
        assert_valid(&m);
        assert!(m.triangle_count() > 0);
    }
}
