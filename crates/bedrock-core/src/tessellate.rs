//! Stroke geometry: smoothing, resampling and conversion to
//! * a triangle [`Mesh`] for the GPU renderer, and
//! * a closed outline polygon for SVG export.
//!
//! Both come from the same samples so screen and file look identical.

use crate::brush::{Footprint, LineStyle};
use crate::geom::{Rect, Vec2};
use crate::input::InputPoint;
use crate::pen;
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

/// Stabiliser: a pulled string (see [`pen::pulled_string`]) whose length
/// grows with `amount` (0..=1). Rate independent, and the stroke still ends
/// exactly where the pen lifted.
pub fn stabilize(points: &[InputPoint], amount: f32) -> Vec<InputPoint> {
    pen::pulled_string(points, pen::stabilizer_radius(amount))
}

/// The stabiliser as strokes use it: the pen's amount plus steady-hand
/// smoothing, easing off at speed (see [`pen::pulled_string_eased`]).
fn stabilize_eased(points: &[InputPoint], amount: f32, px: f64) -> Vec<InputPoint> {
    let a = pen::effective_stabilizer(amount);
    if a <= 0.0 {
        return points.to_vec();
    }
    pen::pulled_string_eased(points, pen::stabilizer_radius(a) * px, px)
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

/// Centre-line samples with brush footprints applied, for a finished stroke.
pub fn samples(stroke: &Stroke) -> Vec<Sample> {
    samples_with_step(stroke, &stroke.points, 1.0, true)
}

/// Like [`samples`] but for a stroke still being drawn, with an explicit
/// point list: the stroke's points, optionally followed by predicted ones.
/// No end taper, since the pen hasn't lifted yet.
pub fn samples_for(stroke: &Stroke, points: &[InputPoint]) -> Vec<Sample> {
    samples_with_step(stroke, points, 1.0, false)
}

/// Coarser samples (`scale` times the normal spacing), e.g. for thumbnails.
pub fn samples_coarse(stroke: &Stroke, scale: f64) -> Vec<Sample> {
    samples_with_step(stroke, &stroke.points, scale, true)
}

/// Raw samples closer than this (world units) are merged: about half a
/// pixel at 100%, finer for thin brushes that are usually zoomed in on.
fn merge_spacing(size: f64) -> f64 {
    (size * 0.2).clamp(0.1, 0.5)
}

fn samples_with_step(stroke: &Stroke, points: &[InputPoint], scale: f64, finished: bool) -> Vec<Sample> {
    let brush = &stroke.brush;
    let size = brush.size.max(0.1) as f64;
    // World units per input pixel when drawn: the size of input noise.
    let px = if stroke.input_scale.is_finite() && stroke.input_scale > 0.0 { stroke.input_scale } else { 1.0 };
    // Input clean-up, in order: 1€ filters (noise out, little lag), merge
    // points too close to carry a direction, smooth away the whole-pixel
    // staircase, then the stabiliser's pulled string if on.
    // A live stroke may end in predicted points (a guess at where the pen is
    // going). They are left out of the spatial smoothing and appended after
    // it, so a wrong guess can't bend the real line it joins.
    let real = if finished { points.len() } else { stroke.points.len().min(points.len()) };
    let merge = merge_spacing(size).min(0.5 * px);
    let filtered = pen::filter_points(&points[..real], px);
    let merged = pen::decimate(&filtered, merge);
    let mut smoothed = pen::smooth_along(&merged, pen::PIXEL_SMOOTHING * px);
    if real < points.len() {
        let all = pen::filter_points(points, px);
        smoothed.extend(all.iter().skip(real).copied());
    }
    let cleaned = stabilize_eased(&smoothed, brush.stabilizer, px);
    // Dense resampling: capsules are cheap on the GPU and long straight runs
    // are merged again afterwards, so curves can be finely sampled.
    let step = (size * 0.15).clamp(0.15, 0.75) * scale.max(1.0);
    let pts = resample(&cleaned, step);
    // Drop duplicates so tangents are well defined.
    let mut dedup: Vec<InputPoint> = Vec::with_capacity(pts.len());
    for p in pts {
        if dedup.last().is_none_or(|l| l.pos().distance(p.pos()) > 1e-6) {
            dedup.push(p);
        }
    }
    let alpha = brush.stroke_alpha();
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
    let curve = pen::pressure_curve();
    // No speed without timestamps (imported strokes): don't guess.
    let thinning = if pen::has_timing(points) { brush.thinning() } else { 0.0 };
    let speed = if thinning > 0.0 { pen::speeds(&dedup) } else { Vec::new() };
    let mut out: Vec<Sample> = (0..n)
        .map(|i| {
            let mut p = dedup[i];
            p.pressure = curve.apply(p.pressure);
            let Footprint { width, opacity } = brush.footprint(&p, angles[i]);
            let thin = if thinning > 0.0 { pen::speed_factor(thinning, speed[i]) } else { 1.0 };
            Sample { pos: p.pos(), width: (width * thin) as f64, opacity: opacity * alpha }
        })
        .collect();
    calm_widths(&mut out, &arc, size);
    if brush.tapers() {
        let ends = Ends {
            start: brush.taper_start(),
            end: brush.taper_end(),
            fade: brush.taper_fade(),
            last_pressure: dedup[n - 1].pressure,
            end_speed: if pen::has_timing(points) { end_speed(&points[..real], px) } else { 0.0 },
            // Fingers and mice have no pressure to shape the ends, so they
            // get a fuller taper (Procreate's "touch taper").
            synthetic: stroke.device != crate::stroke::InputDevice::Pen,
        };
        taper(&mut out, &arc, finished, &ends);
    }
    out
}

/// Pen speed over the last few milliseconds before it lifted, in input
/// pixels per millisecond (so zoom doesn't change it).
fn end_speed(points: &[InputPoint], px: f64) -> f64 {
    let Some(last) = points.last() else { return 0.0 };
    let Some(from) = points.iter().rev().find(|p| last.t - p.t >= END_SPEED_MS) else { return 0.0 };
    let dt = last.t - from.t;
    if dt <= 0.0 {
        return 0.0;
    }
    last.pos().distance(from.pos()) / px.max(1e-9) / dt
}

/// How far back [`end_speed`] looks.
const END_SPEED_MS: f64 = 16.0;

/// How a stroke's ends are shaped (see [`taper`]).
struct Ends {
    start: f32,
    end: f32,
    fade: f32,
    last_pressure: f32,
    /// Input pixels per millisecond as the pen lifted.
    end_speed: f64,
    /// No pressure (finger, mouse): taper fully.
    synthetic: bool,
}

/// Ends shaped by arc length (so 60 Hz and 240 Hz input taper alike), each
/// by an amount 0..=1 from the brush:
/// * start: grows from thin to full, as a nib does when it touches down
///   (0.5: from 40% over one stroke width; 1: from 5% over two). Pencil
///   pressure in the first milliseconds is unreliable, so this doesn't
///   rely on it.
/// * end (finished strokes only; 0.5: down to 65% over one width). Pressure
///   already thins a lift that eases off, so the taper is for lifts that
///   don't: still pressing, or flicked away fast (velocity taper, as in
///   Fresco). A fast flick tapers up to 80% more.
/// * fade: tapered ends also lose opacity, for a dry-ink look.
///
/// Fingers and mice taper at least 0.7 at both ends. Strokes shorter than
/// two widths (dots, short ticks) keep their full width.
fn taper(s: &mut [Sample], arc: &[f64], finished: bool, e: &Ends) {
    let n = s.len();
    let total = arc[n - 1];
    let w = s.iter().map(|x| x.width).fold(0.0, f64::max);
    if n < 3 || total < 2.0 * w || w <= 0.0 {
        return;
    }
    let ease = |t: f64| {
        let t = t.clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    let fuller = |a: f32| if e.synthetic && a > 0.0 { a.max(0.7) } else { a } as f64;
    let fade = e.fade as f64;
    let mut shape = |i: usize, f: f64| {
        s[i].width *= f;
        s[i].opacity *= (1.0 - fade * (1.0 - f)) as f32;
    };
    let start = fuller(e.start);
    if start > 0.0 {
        let len = (w * 2.0 * start).min(total * 0.5);
        let min = (1.0 - 1.2 * start).max(0.05);
        for (i, &a) in arc.iter().enumerate().take(n) {
            if a >= len {
                break;
            }
            shape(i, min + (1.0 - min) * ease(a / len));
        }
    }
    let end = fuller(e.end);
    if finished && end > 0.0 {
        let smooth = |a: f64, b: f64, x: f64| ease((x - a) / (b - a));
        let flick = smooth(0.5, 2.5, e.end_speed);
        let pressing = if e.synthetic { 1.0 } else { smooth(0.1, 0.35, e.last_pressure as f64) };
        let k = pressing.max(flick);
        let amount = (end * (1.0 + 0.8 * flick)).min(1.0);
        let len = (w * 2.0 * amount).min(total * 0.5);
        let min = 1.0 - 0.7 * amount;
        for i in (0..n).rev() {
            let d = total - arc[i];
            if d >= len {
                break;
            }
            let f = min + (1.0 - min) * ease(d / len);
            shape(i, 1.0 - k * (1.0 - f));
        }
    }
}

/// Keep width and opacity changes gradual along the line.
///
/// Pressure and tilt from a real pen are noisy, and a single spike, or a
/// pause where the pen presses harder, used to show up as a blob. Two
/// passes fix that without dulling deliberate swells and tapers:
/// * a light forward-backward smoothing over about one brush size of line,
/// * a slope limit: the radius may grow at most ~0.35 units per unit of
///   line, so the stroke can't balloon in a short distance. Only growth is
///   limited: a line may thin quickly (a lift, a fast flick).
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
    fn input_cleanup_keeps_endpoints() {
        let pts: Vec<_> = (0..20).map(|i| InputPoint::new(i as f64, (i % 2) as f64, 0.5).at(i as f64 * 4.0)).collect();
        let f = pen::filter_points(&pts, 1.0);
        assert_eq!(f[0].pos(), pts[0].pos());
        assert_eq!(f.last().unwrap().pos(), pts.last().unwrap().pos());
        let wobble = f[5..15].iter().map(|p| (p.y - 0.5).abs()).fold(0.0, f64::max);
        assert!(wobble < 0.3, "zigzag left at {wobble}");
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
            let pen = pts.iter().find(|p| p.t >= 300.0).unwrap();
            let ink = st.iter().rev().find(|q| q.t <= pen.t).unwrap();
            pen.pos().distance(ink.pos())
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
        let pts: Vec<_> = (0..300)
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

    // Tests from the pen-feel research.

    fn pen_stroke(id: u64, kind: BrushKind, size: f32, pts: Vec<InputPoint>) -> Stroke {
        Stroke::new(StrokeId(id), Brush::new(kind, Rgba::BLACK, size), 0.0, InputDevice::Pen, pts)
    }

    #[test]
    fn slow_jittery_circle_stays_round() {
        // A slow circle (r 20, 2 s at 240 Hz) with ±0.4 digitiser noise.
        let mut seed = 7u32;
        let mut noise = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f64 / (1u32 << 24) as f64 * 0.8 - 0.4
        };
        let pts: Vec<_> = (0..480)
            .map(|i| {
                let a = i as f64 / 480.0 * 2.0 * PI;
                InputPoint::new(20.0 * a.cos() + noise(), 20.0 * a.sin() + noise(), 0.5).at(i as f64 * 4.17)
            })
            .collect();
        let s = pen_stroke(20, BrushKind::Pen, 4.0, pts);
        let smp = samples(&s);
        let w = smp.iter().map(|x| x.width).fold(0.0, f64::max);
        let worst = smp.iter().map(|x| (x.pos.length() - 20.0).abs()).fold(0.0, f64::max);
        assert!(worst < 0.5 * w, "centre line strays {worst} from the circle (width {w})");
    }

    #[test]
    fn hesitation_does_not_kink_the_line() {
        // 50 samples bunched within 1 unit while the pen pauses mid-line,
        // with typical Pencil noise.
        let mut pts = Vec::new();
        let mut t = 0.0;
        for i in 0..40 {
            pts.push(InputPoint::new(i as f64, 0.0, 0.5).at(t));
            t += 4.0;
        }
        for i in 0..50 {
            let j = if i % 2 == 0 { 0.15 } else { -0.15 };
            pts.push(InputPoint::new(40.0 + (i % 5) as f64 * 0.1, j, 0.5).at(t));
            t += 4.0;
        }
        for i in 1..40 {
            pts.push(InputPoint::new(40.5 + i as f64, 0.0, 0.5).at(t));
            t += 4.0;
        }
        let s = pen_stroke(21, BrushKind::Pen, 3.0, pts.clone());
        let m = mesh(&s);
        let wobble = m.segments.iter().map(|g| g.a[1].abs().max(g.b[1].abs())).fold(0.0, f32::max);
        assert!(wobble < 0.15 * 3.0, "line wobbles {wobble} off course");
        let dirs: Vec<f64> = m
            .segments
            .iter()
            .filter(|g| g.a != g.b)
            .map(|g| ((g.b[1] - g.a[1]) as f64).atan2((g.b[0] - g.a[0]) as f64))
            .collect();
        for w in dirs.windows(2) {
            let mut d = (w[1] - w[0]).abs();
            if d > PI {
                d = 2.0 * PI - d;
            }
            assert!(d < 30f64.to_radians(), "capsules turn {}°", d.to_degrees());
        }
    }

    fn mid_width_at(kind: BrushKind, speed: f64, pressure: f32) -> f64 {
        let pts: Vec<_> =
            (0..200).map(|i| InputPoint::new(i as f64 * speed * 4.0, 0.0, pressure).at(i as f64 * 4.0)).collect();
        let smp = samples(&pen_stroke(22, kind, 4.0, pts));
        smp[smp.len() / 2].width
    }

    fn mid_width(kind: BrushKind, speed: f64) -> f64 {
        mid_width_at(kind, speed, 0.5)
    }

    #[test]
    fn faster_strokes_are_thinner_for_pens_only() {
        let (slow, fast) = (mid_width(BrushKind::Pen, 1.5), mid_width(BrushKind::Pen, 3.0));
        let thinner = 1.0 - fast / slow;
        assert!((0.05..=0.4).contains(&thinner), "2x speed thinned the pen by {:.0}%", thinner * 100.0);
        let (slow, fast) = (mid_width(BrushKind::Marker, 0.8), mid_width(BrushKind::Marker, 1.6));
        assert!((slow - fast).abs() < 1e-9, "marker {slow} vs {fast}");
    }

    #[test]
    fn pressure_matters_more_than_speed() {
        // Bug report: with speed thinning the pen felt like it ignored
        // pressure. Over everyday ranges (light to firm, slow to quick
        // writing) pressure must change the width far more than speed.
        let by_pressure = mid_width_at(BrushKind::Pen, 1.0, 0.9) / mid_width_at(BrushKind::Pen, 1.0, 0.15);
        let by_speed = mid_width_at(BrushKind::Pen, 0.3, 0.5) / mid_width_at(BrushKind::Pen, 2.5, 0.5);
        assert!(by_pressure > 1.8, "pressure only changes width {by_pressure:.2}x");
        assert!(by_speed < 1.2, "speed changes width {by_speed:.2}x");
    }

    #[test]
    fn tapers_follow_arc_length_and_spare_dots() {
        let line_at = |hz: f64| -> Vec<Sample> {
            let n = (hz * 0.4) as usize;
            let pts = (0..n)
                .map(|i| InputPoint::new(i as f64 * 100.0 / (n - 1) as f64, 0.0, 0.8).at(i as f64 * 1000.0 / hz))
                .collect();
            samples(&pen_stroke(23, BrushKind::Pen, 6.0, pts))
        };
        // Where the start taper reaches 95% of the full width.
        let reach = |s: &[Sample]| {
            let full = s[s.len() / 2].width;
            s.iter().find(|x| x.width >= 0.95 * full).unwrap().pos.x
        };
        let (a, b) = (line_at(60.0), line_at(240.0));
        assert!(a[0].width < a[a.len() / 2].width * 0.6, "starts thin");
        assert!((reach(&a) - reach(&b)).abs() < 1.5, "60 Hz {} vs 240 Hz {}", reach(&a), reach(&b));
        // Lifted while pressing: the end eases off too.
        assert!(a.last().unwrap().width < a[a.len() / 2].width * 0.8);
        // A short tick, one width long, keeps at least 80% of its radius.
        let pts = (0..6).map(|i| InputPoint::new(i as f64, 0.0, 0.8).at(i as f64 * 4.0)).collect();
        let s = pen_stroke(24, BrushKind::Pen, 6.0, pts);
        let full =
            Brush::new(BrushKind::Pen, Rgba::BLACK, 6.0).footprint(&InputPoint::new(0.0, 0.0, 0.8), 0.0).width as f64;
        assert!(samples(&s).iter().all(|x| x.width >= 0.8 * full * 0.7), "tick lost its width");
        // Markers aren't tapered.
        let pts = (0..40).map(|i| InputPoint::new(i as f64 * 3.0, 0.0, 0.8).at(i as f64 * 4.0)).collect();
        let m = samples(&pen_stroke(25, BrushKind::Marker, 6.0, pts));
        assert!((m[0].width - m[m.len() / 2].width).abs() < 1e-9);
    }

    #[test]
    fn taper_settings_fingers_and_flicks() {
        // A 100-unit line at 0.4 px/ms (slow), pressing to the end.
        let line = |speed_ms: f64, pressure: f32| -> Vec<InputPoint> {
            (0..50).map(|i| InputPoint::new(i as f64 * 2.0, 0.0, pressure).at(i as f64 * 2.0 / speed_ms)).collect()
        };
        let run = |brush: Brush, device: InputDevice, pts: Vec<InputPoint>| {
            let mut st = Stroke::new(StrokeId(30), brush, 0.0, device, pts);
            st.input_scale = 1.0;
            samples(&st)
        };
        let pen = Brush::new(BrushKind::Pen, Rgba::BLACK, 6.0);
        let mid = |s: &[Sample]| s[s.len() / 2];
        // No start taper: full width from the first sample.
        let flat = run(Brush { taper_start: Some(0.0), ..pen }, InputDevice::Pen, line(0.4, 0.8));
        assert!(flat[0].width > mid(&flat).width * 0.95);
        // A strong one starts much thinner than the default.
        let strong = run(Brush { taper_start: Some(1.0), ..pen }, InputDevice::Pen, line(0.4, 0.8));
        let normal = run(pen, InputDevice::Pen, line(0.4, 0.8));
        assert!(strong[0].width < normal[0].width * 0.3);
        // Fade: the tapered ends also get lighter.
        let faded = run(Brush { taper_fade: Some(1.0), ..pen }, InputDevice::Pen, line(0.4, 0.8));
        assert!(faded[0].opacity < mid(&faded).opacity * 0.6);
        assert!((normal[0].opacity - mid(&normal).opacity).abs() < 1e-6, "no fade by default");
        // A light lift is already thinned by pressure: no extra end taper...
        let light = run(pen, InputDevice::Pen, line(0.4, 0.05));
        assert!(light.last().unwrap().width > mid(&light).width * 0.95);
        // ...unless it was flicked away fast.
        let flick = run(pen, InputDevice::Pen, line(4.0, 0.05));
        assert!(flick.last().unwrap().width < mid(&flick).width * 0.6, "velocity taper");
        // A flick tapers more than a slow lift that was still pressing.
        let fast = run(pen, InputDevice::Pen, line(4.0, 0.8));
        assert!(fast.last().unwrap().width < normal.last().unwrap().width);
        // Fingers have no pressure: both ends taper fully, even on a marker
        // set to taper a little.
        let finger = run(
            Brush { taper_end: Some(0.2), taper_start: Some(0.2), ..Brush::new(BrushKind::Marker, Rgba::BLACK, 6.0) },
            InputDevice::Touch,
            line(0.4, 0.5),
        );
        assert!(finger[0].width < mid(&finger).width * 0.3);
        assert!(finger.last().unwrap().width < mid(&finger).width * 0.6);
        // A marker left alone still doesn't taper, even from a finger.
        let marker = run(Brush::new(BrushKind::Marker, Rgba::BLACK, 6.0), InputDevice::Touch, line(0.4, 0.5));
        assert!((marker[0].width - mid(&marker).width).abs() < 1e-9);
    }

    #[test]
    fn live_strokes_get_no_end_taper() {
        let pts: Vec<_> = (0..60).map(|i| InputPoint::new(i as f64 * 2.0, 0.0, 0.8).at(i as f64 * 4.0)).collect();
        let s = pen_stroke(26, BrushKind::Pen, 6.0, pts.clone());
        let live = samples_for(&s, &pts);
        let done = samples(&s);
        assert!(live.last().unwrap().width > done.last().unwrap().width * 1.2);
        // The start is identical, so nothing jumps when the pen lifts.
        assert_eq!(live[0], done[0]);
    }

    #[test]
    fn fountain_width_is_continuous_as_the_pen_tilts() {
        // Bug class: the nib angle switched abruptly at 0.15 tilt, so a
        // stroke drawn while straightening the pen changed width in one step.
        let b = Brush::new(BrushKind::Fountain, Rgba::BLACK, 6.0);
        let at = |tilt: f32| {
            let mut p = InputPoint::new(0.0, 0.0, 0.5);
            p.altitude = (1.0 - tilt) * std::f32::consts::FRAC_PI_2;
            p.azimuth = 0.3;
            b.footprint(&p, 0.0).width
        };
        let mut prev = at(0.0);
        for i in 1..=100 {
            let w = at(i as f32 * 0.004);
            assert!((w - prev).abs() < 0.25, "width jumps from {prev} to {w} at tilt {}", i as f32 * 0.004);
            prev = w;
        }
    }

    #[test]
    fn unreliable_first_pressure_is_ignored() {
        // Pencil often reports ~0 pressure for the first few ms.
        let pts: Vec<_> = (0..60)
            .map(|i| InputPoint::new(i as f64 * 2.0, 0.0, if i < 2 { 0.02 } else { 0.8 }).at(i as f64 * 4.0))
            .collect();
        let f = pen::filter_points(&pts, 1.0);
        assert!(f[0].pressure > 0.7 && f[1].pressure > 0.7, "{} {}", f[0].pressure, f[1].pressure);
    }

    #[test]
    fn strokes_without_timestamps_are_not_thinned() {
        // Bug: imported strokes (all t = 0) looked infinitely fast and were
        // drawn at the thinnest width.
        let pts: Vec<_> = (0..40).map(|i| InputPoint::new(i as f64 * 3.0, 0.0, 0.8)).collect();
        let smp = samples(&pen_stroke(27, BrushKind::Pen, 6.0, pts));
        let full =
            Brush::new(BrushKind::Pen, Rgba::BLACK, 6.0).footprint(&InputPoint::new(0.0, 0.0, 0.8), 0.0).width as f64;
        assert!((smp[smp.len() / 2].width - full).abs() < 0.05, "{} vs {full}", smp[smp.len() / 2].width);
    }

    /// Positions as Safari reports them: whole CSS pixels.
    fn quantized(pts: Vec<InputPoint>) -> Vec<InputPoint> {
        pts.into_iter()
            .map(|mut p| {
                p.x = p.x.round();
                p.y = p.y.round();
                p
            })
            .collect()
    }

    #[test]
    fn whole_pixel_input_is_not_wobbly_at_100_percent() {
        // Bug: writing at 100% looked wobbly and only improved when zoomed
        // in. The browser gives whole-pixel positions, so a slow, shallow
        // line arrives as a staircase that the filters passed through.
        let line: Vec<_> =
            (0..400).map(|i| InputPoint::new(i as f64 * 0.3, i as f64 * 0.03, 0.5).at(i as f64 * 4.17)).collect();
        let s = pen_stroke(30, BrushKind::Pen, 3.0, quantized(line));
        let smp = samples(&s);
        let inner = &smp[smp.len() / 10..smp.len() * 9 / 10];
        let worst = inner.iter().map(|p| (p.pos.y - p.pos.x * 0.1).abs()).fold(0.0, f64::max);
        assert!(worst < 0.25, "line wobbles {worst} px off course (raw staircase is up to 0.5)");
        // A slow small circle, as in handwriting.
        let circle: Vec<_> = (0..480)
            .map(|i| {
                let a = i as f64 / 480.0 * 2.0 * PI;
                InputPoint::new(100.0 + 12.0 * a.cos(), 100.0 + 12.0 * a.sin(), 0.5).at(i as f64 * 4.17)
            })
            .collect();
        let s = pen_stroke(31, BrushKind::Pen, 3.0, quantized(circle));
        let smp = samples(&s);
        let inner = &smp[smp.len() / 10..smp.len() * 9 / 10];
        let worst = inner.iter().map(|p| ((p.pos - Vec2::new(100.0, 100.0)).length() - 12.0).abs()).fold(0.0, f64::max);
        assert!(worst < 0.35, "circle wobbles {worst} px");
    }

    #[test]
    fn smoothing_follows_the_zoom_the_stroke_was_drawn_at() {
        // The same hand movement drawn at 400% is 4x smaller in the world,
        // and its pixel staircase is too: it must be smoothed just as well,
        // without rounding off the (smaller) letters more.
        let line: Vec<_> =
            (0..400).map(|i| InputPoint::new(i as f64 * 0.3, i as f64 * 0.03, 0.5).at(i as f64 * 4.17)).collect();
        let q: Vec<_> = quantized(line).into_iter().map(|p| InputPoint { x: p.x / 4.0, y: p.y / 4.0, ..p }).collect();
        let mut s = pen_stroke(32, BrushKind::Pen, 0.75, q);
        s.input_scale = 0.25;
        let smp = samples(&s);
        let inner = &smp[smp.len() / 10..smp.len() * 9 / 10];
        let worst = inner.iter().map(|p| (p.pos.y - p.pos.x * 0.1).abs()).fold(0.0, f64::max);
        assert!(worst < 0.25 / 4.0, "line wobbles {worst} units at 400%");
    }

    #[test]
    fn smoothing_keeps_sharp_corners_of_letters() {
        // A "v" 20 px tall: the tip must stay pointed (within about a pixel).
        let mut pts = Vec::new();
        for i in 0..=40 {
            pts.push(InputPoint::new(i as f64 * 0.25, i as f64 * 0.5, 0.5).at(i as f64 * 4.0));
        }
        for i in 1..=40 {
            pts.push(InputPoint::new(10.0 + i as f64 * 0.25, 20.0 - i as f64 * 0.5, 0.5).at(160.0 + i as f64 * 4.0));
        }
        let smp = samples(&pen_stroke(33, BrushKind::Pen, 2.0, pts));
        let tip = smp.iter().map(|p| p.pos.y).fold(0.0, f64::max);
        assert!(tip > 19.0, "the tip of the v moved up to {tip}");
    }

    #[test]
    fn pencil_noise_does_not_make_the_width_wobble() {
        // Apple Pencil (unlike a mouse) sends noisy pressure at 240 Hz, with
        // samples bunched in time as Safari coalesces them, and whole-pixel
        // positions. Writing speed and pressure are steady here, so the width
        // must be too.
        let mut seed = 11u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f64 / (1u32 << 24) as f64 - 0.5
        };
        let pts: Vec<_> = (0..480)
            .map(|i| {
                let t = (i / 4) as f64 * 16.67 + (i % 4) as f64 * 0.5; // bunches of 4 per frame
                let x = i as f64 * 0.35;
                InputPoint::new(x, 50.0 + (x * 0.05).sin() * 6.0, (0.5 + rnd() * 0.12) as f32).at(t)
            })
            .collect();
        let s = pen_stroke(34, BrushKind::Pen, 3.0, quantized(pts));
        let smp = samples(&s);
        let inner = &smp[smp.len() / 10..smp.len() * 9 / 10];
        let (lo, hi) = inner.iter().fold((f64::MAX, 0.0f64), |(l, h), x| (l.min(x.width), h.max(x.width)));
        assert!(hi / lo < 1.08, "width wobbles between {lo:.3} and {hi:.3}");
    }

    #[test]
    fn a_wrong_prediction_does_not_bend_the_real_line() {
        // While drawing, predicted points are appended to the live stroke.
        // A bad guess (here: a sharp hook) must not move the line already
        // drawn, or the line wiggles under the pen.
        let real: Vec<_> = (0..120).map(|i| InputPoint::new(i as f64 * 0.5, 0.0, 0.5).at(i as f64 * 4.17)).collect();
        let s = pen_stroke(35, BrushKind::Pen, 3.0, real.clone());
        let plain = samples_for(&s, &real);
        let mut guessed = real.clone();
        for k in 1..=4 {
            guessed.push(InputPoint::new(59.5, k as f64 * 3.0, 0.5).at(500.0 + k as f64 * 4.0));
        }
        let bent = samples_for(&s, &guessed);
        let worst = bent.iter().filter(|p| p.pos.x < 58.0).map(|p| p.pos.y.abs()).fold(0.0, f64::max);
        assert!(worst < 0.05, "a predicted hook moved the drawn line by {worst}");
        assert!(plain.len() > 10);
    }
}
