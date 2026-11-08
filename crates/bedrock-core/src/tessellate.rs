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

/// One mesh vertex. Besides position and opacity it carries what the GPU
/// needs for analytic antialiasing (independent of the browser's MSAA, which
/// iOS Safari does not reliably provide):
/// * `dir`: unit direction pointing out of the stroke at this vertex,
/// * `edge`: 0 on the centre line, ±1 on the outline,
/// * `half_width`: the stroke's half width here, in world units.
///
/// The shader pushes outline vertices half a pixel outwards along `dir` and
/// fades coverage over that pixel, giving smooth edges at any zoom.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeshVertex {
    pub pos: [f32; 2],
    pub dir: [f32; 2],
    pub edge: f32,
    pub half_width: f32,
    pub alpha: f32,
}

/// Triangle mesh in coordinates relative to `origin` (keeps `f32` precise
/// anywhere on the infinite canvas).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mesh {
    pub origin: Vec2,
    pub vertices: Vec<MeshVertex>,
    pub indices: Vec<u32>,
}

impl Mesh {
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    pub fn bounds(&self) -> Rect {
        let mut r = Rect::EMPTY;
        for v in &self.vertices {
            r.include(Vec2::new(v.pos[0] as f64 + self.origin.x, v.pos[1] as f64 + self.origin.y));
        }
        r
    }

    /// Append another mesh (re-based onto this mesh's origin).
    pub fn append(&mut self, other: &Mesh) {
        if self.vertices.is_empty() {
            self.origin = other.origin;
        }
        let base = self.vertices.len() as u32;
        let dx = (other.origin.x - self.origin.x) as f32;
        let dy = (other.origin.y - self.origin.y) as f32;
        self.vertices.extend(other.vertices.iter().map(|v| MeshVertex { pos: [v.pos[0] + dx, v.pos[1] + dy], ..*v }));
        self.indices.extend(other.indices.iter().map(|i| i + base));
    }

    fn vertex(&mut self, p: Vec2, dir: Vec2, edge: f32, half_width: f64, alpha: f32) -> u32 {
        let i = self.vertices.len() as u32;
        self.vertices.push(MeshVertex {
            pos: [(p.x - self.origin.x) as f32, (p.y - self.origin.y) as f32],
            dir: [dir.x as f32, dir.y as f32],
            edge,
            half_width: half_width as f32,
            alpha,
        });
        i
    }

    /// Fan of triangles approximating a circle arc around `c` from angle `a0`
    /// sweeping `sweep` radians.
    fn fan(&mut self, c: Vec2, r: f64, a0: f64, sweep: f64, alpha: f32) {
        let segs = circle_segments(r, sweep);
        let center = self.vertex(c, Vec2::ZERO, 0.0, r, alpha);
        let d0 = Vec2::new(a0.cos(), a0.sin());
        let mut prev = self.vertex(c + d0 * r, d0, 1.0, r, alpha);
        for i in 1..=segs {
            let a = a0 + sweep * i as f64 / segs as f64;
            let d = Vec2::new(a.cos(), a.sin());
            let v = self.vertex(c + d * r, d, 1.0, r, alpha);
            self.indices.extend_from_slice(&[center, prev, v]);
            prev = v;
        }
    }
}

fn circle_segments(r: f64, sweep: f64) -> usize {
    let full = (r * 3.0).clamp(12.0, 48.0);
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
    let stabilized;
    let points = if stroke.brush.stabilizer > 0.0 {
        stabilized = stabilize(points, stroke.brush.stabilizer);
        &stabilized[..]
    } else {
        points
    };
    let smoothed = smooth(points);
    let step = (stroke.brush.size as f64 * 0.35).clamp(0.35, 2.0);
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
        let hw = smp.width / 2.0;
        let nd = tan[i].perp();
        let n = nd * hw;
        let l = m.vertex(smp.pos + n, nd, 1.0, hw, smp.opacity);
        let r = m.vertex(smp.pos - n, nd * -1.0, -1.0, hw, smp.opacity);
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

/// Closed outline polygon (for SVG) of a solid stroke. Self-intersections
/// are fine with the non-zero fill rule.
pub fn outline(stroke: &Stroke) -> Vec<Vec2> {
    outline_from_samples(&samples(stroke))
}

/// Outline polygons of every visible piece (dashes / dots) of a stroke.
pub fn outlines(stroke: &Stroke) -> Vec<Vec<Vec2>> {
    let s = samples(stroke);
    pieces(stroke, &s).iter().map(|p| outline_from_samples(p)).filter(|o| !o.is_empty()).collect()
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
            assert!(v.pos.iter().chain(&v.dir).all(|c| c.is_finite()));
            assert!(v.alpha >= 0.0 && v.alpha <= 1.0);
            assert!(v.half_width > 0.0);
            assert!(v.edge.abs() <= 1.0);
            let dl = (v.dir[0] * v.dir[0] + v.dir[1] * v.dir[1]).sqrt();
            // Outline vertices point outwards with a unit direction; centres have none.
            if v.edge == 0.0 {
                assert_eq!(dl, 0.0)
            } else {
                assert!((dl - 1.0).abs() < 1e-3)
            }
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
        assert!(m.vertices.iter().all(|v| v.pos[0].abs() < 100.0 && v.pos[1].abs() < 100.0));
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
        assert!(m.vertices.iter().all(|v| {
            let x = v.pos[0] as f64 + m.origin.x;
            !(19.0..23.0).contains(&x)
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
        assert!(m.triangle_count() > 0);
    }
}
