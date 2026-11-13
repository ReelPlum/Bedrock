//! Signal processing for pen input, applied at render time to the raw
//! samples stored in the file (so every improvement here also improves old
//! notes, and the file never changes):
//!
//! * [`filter_points`]: the input clean-up. By default Google's Ink Stroke
//!   Modeler (see [`model_points`]): a wobble smoother for slow, shaky
//!   movement and a spring and mass model that pulls the line along behind
//!   the pen. The writer can switch back to the 1€ filters below
//!   ([`set_smoother`], device-local).
//! * [`OneEuro`] / [`OneEuro2`]: the 1€ filter (Casiez, Roussel, Vogel,
//!   CHI 2012), a low-pass filter in *time* whose cutoff rises with speed.
//!   Slow movement, where digitiser noise dominates, is smoothed hard; fast
//!   movement is barely delayed. This is what removes slow-turn wobble and
//!   blobs without making fast writing lag.
//! * [`decimate`]: raw samples closer than about half a pixel carry only
//!   noise in their direction; they are merged before the spline.
//! * [`PressureCurve`]: the user's pressure feel (soft to firm), a monotone
//!   cubic through (0,0) and (1,1). Device-local, set with
//!   [`set_pressure_softness`].
//! * [`speed_factor`]: faster strokes get thinner, as real ink does.
//! * [`pulled_string`]: the stabiliser, a "lazy brush" with a fixed radius.

use crate::input::InputPoint;
use std::f64::consts::PI;
use std::sync::atomic::{AtomicU32, AtomicU8, Ordering};

fn alpha(cutoff_hz: f64, dt_s: f64) -> f64 {
    let r = 2.0 * PI * cutoff_hz * dt_s;
    r / (r + 1.0)
}

/// 1€ filter for one channel. Time in milliseconds.
#[derive(Debug, Clone, Copy)]
pub struct OneEuro {
    pub min_cutoff: f64,
    pub beta: f64,
    pub d_cutoff: f64,
    state: Option<(f64, f64, f64)>, // value, derivative, time
}

impl OneEuro {
    pub fn new(min_cutoff: f64, beta: f64, d_cutoff: f64) -> Self {
        OneEuro { min_cutoff, beta, d_cutoff, state: None }
    }

    pub fn filter(&mut self, x: f64, t_ms: f64) -> f64 {
        match self.state {
            None => {
                self.state = Some((x, 0.0, t_ms));
                x
            }
            Some((prev, dx, t0)) => {
                let dt = ((t_ms - t0).max(0.5)) / 1000.0;
                let dx = dx + alpha(self.d_cutoff, dt) * ((x - prev) / dt - dx);
                let fc = self.min_cutoff + self.beta * dx.abs();
                let v = prev + alpha(fc, dt) * (x - prev);
                self.state = Some((v, dx, t_ms));
                v
            }
        }
    }
}

/// 1€ filter for a 2D position: one cutoff from the speed (not per axis), so
/// a diagonal stroke is treated like a horizontal one.
#[derive(Debug, Clone, Copy)]
pub struct OneEuro2 {
    pub min_cutoff: f64,
    pub beta: f64,
    pub d_cutoff: f64,
    state: Option<([f64; 2], f64, f64)>, // value, speed (units/s), time
}

impl OneEuro2 {
    pub fn new(min_cutoff: f64, beta: f64, d_cutoff: f64) -> Self {
        OneEuro2 { min_cutoff, beta, d_cutoff, state: None }
    }

    pub fn filter(&mut self, p: [f64; 2], t_ms: f64) -> [f64; 2] {
        match self.state {
            None => {
                self.state = Some((p, 0.0, t_ms));
                p
            }
            Some((prev, speed, t0)) => {
                let dt = ((t_ms - t0).max(0.5)) / 1000.0;
                let raw = ((p[0] - prev[0]).hypot(p[1] - prev[1])) / dt;
                let speed = speed + alpha(self.d_cutoff, dt) * (raw - speed);
                let a = alpha(self.min_cutoff + self.beta * speed, dt);
                let v = [prev[0] + a * (p[0] - prev[0]), prev[1] + a * (p[1] - prev[1])];
                self.state = Some((v, speed, t_ms));
                v
            }
        }
    }
}

/// Position filter settings (world units ≈ CSS px at 100% zoom).
/// Tuned with the tests below: a slow jittery circle stays round, and a
/// fast stroke lags less than 2 units.
pub const POS_MIN_CUTOFF: f64 = 2.0;
pub const POS_BETA: f64 = 0.1;
pub const POS_D_CUTOFF: f64 = 8.0;

/// Pressure is quantised and spiky: smooth over roughly 10 ms.
pub const PRESSURE_CUTOFF: f64 = 15.0;
/// Tilt changes slowly and its azimuth is noisy near upright.
pub const TILT_CUTOFF: f64 = 6.0;

/// Pressure in the first few milliseconds of a Pencil stroke is unreliable
/// (often zero or tiny); those samples take the first reliable value.
pub const UNRELIABLE_START_MS: f64 = 8.0;

/// Merge raw samples closer together than this (world units) to the last
/// kept one, except the first and last sample.
pub fn decimate(points: &[InputPoint], min_spacing: f64) -> Vec<InputPoint> {
    let n = points.len();
    if n < 3 {
        return points.to_vec();
    }
    let mut out: Vec<InputPoint> = Vec::with_capacity(n);
    out.push(points[0]);
    for p in &points[1..n - 1] {
        if out.last().unwrap().pos().distance(p.pos()) >= min_spacing {
            out.push(*p);
        }
    }
    let last = points[n - 1];
    if out.len() > 1 && out.last().unwrap().pos().distance(last.pos()) < min_spacing {
        out.pop();
    }
    out.push(last);
    out
}

/// Which input clean-up smooths the ink.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Smoother {
    /// Google's Ink Stroke Modeler ([`model_points`]). The default.
    Modeler,
    /// Bedrock's own 1€ filters ([`one_euro_points`]), used before the
    /// modeler.
    OneEuro,
}

static SMOOTHER: AtomicU8 = AtomicU8::new(0);

/// Choose the input clean-up for every pen. Device-local, rendering only:
/// the file keeps raw samples. Re-tessellate afterwards.
pub fn set_smoother(s: Smoother) {
    SMOOTHER.store(if s == Smoother::OneEuro { 1 } else { 0 }, Ordering::Relaxed);
}

pub fn smoother() -> Smoother {
    if SMOOTHER.load(Ordering::Relaxed) == 1 {
        Smoother::OneEuro
    } else {
        Smoother::Modeler
    }
}

/// The input clean-up chosen with [`set_smoother`]. The first point stays
/// exact, and the line still reaches the point where the pen lifted.
/// `scale` is world units per input pixel (see `Stroke::input_scale`).
/// Strokes without timing (imported ones) always use the 1€ filters, which
/// then leave them as they are.
pub fn filter_points(points: &[InputPoint], scale: f64) -> Vec<InputPoint> {
    match smoother() {
        Smoother::Modeler if has_timing(points) => {
            model_points(points, scale).unwrap_or_else(|| one_euro_points(points, scale))
        }
        _ => one_euro_points(points, scale),
    }
}

/// Typical writing speed in input pixels per second, which the modeler's
/// wobble smoother is tuned from: Google suggests smoothing fully below 2%
/// of it and not at all above 3%.
pub const MODELER_WRITING_SPEED: f64 = 400.0;
/// The wobble smoother's window, seconds: Google suggests 2.5 divided by
/// the input rate (Apple Pencil gives 120 to 240 samples a second).
pub const MODELER_WOBBLE_WINDOW_S: f64 = 0.02;

/// How tightly the modeler's line follows the pen (mass over spring
/// constant, seconds squared). Google's starting point, 11/32400, rounds
/// the tip of a small "v" by over a pixel; 7/32400 to 9/32400 keep letters'
/// corners and still iron out a whole-pixel staircase (the tessellate tests).
pub const MODELER_SPRING: f32 = 8.0 / 32400.0;

fn modeler_params() -> ink_stroke_modeler::Params {
    // Steady-hand smoothing widens the range of speeds that are smoothed.
    let calm = 1.0 + 4.0 * smoothing() as f64;
    ink_stroke_modeler::Params {
        wobble_timeout: MODELER_WOBBLE_WINDOW_S,
        wobble_speed_floor: 0.02 * MODELER_WRITING_SPEED * calm,
        wobble_speed_ceiling: 0.03 * MODELER_WRITING_SPEED * calm,
        spring_mass_constant: MODELER_SPRING,
        end_of_stroke_stopping_distance: 0.01,
        predict: false,
        ..ink_stroke_modeler::Params::default()
    }
}

thread_local! {
    static MODELER: std::cell::RefCell<Option<ink_stroke_modeler::Modeler>> = const { std::cell::RefCell::new(None) };
}

/// The input clean-up by Google's Ink Stroke Modeler: unreliable start
/// pressure, then the modeler on position, pressure and tilt, in input
/// pixels and seconds. The modeler resamples, so the points it gives back
/// are not the ones it was given (at least 180 a second, in time order).
/// None if the modeler refuses the input.
pub fn model_points(points: &[InputPoint], scale: f64) -> Option<Vec<InputPoint>> {
    use ink_stroke_modeler::{Event, Input};
    let n = points.len();
    if n < 3 {
        return Some(points.to_vec());
    }
    let points = reliable_start(points);
    let params = modeler_params();
    MODELER.with(|cell| {
        let mut cell = cell.borrow_mut();
        let m = match cell.as_mut() {
            Some(m) => {
                m.reset(&params).ok()?;
                m
            }
            None => cell.insert(ink_stroke_modeler::Modeler::new(&params).ok()?),
        };
        let mut out = Vec::with_capacity(n * 2);
        let mut last_t = f64::NEG_INFINITY;
        for (i, p) in points.iter().enumerate() {
            let event = match i {
                0 => Event::Down,
                i if i == n - 1 => Event::Up,
                _ => Event::Move,
            };
            // The modeler needs time to move forwards; samples that arrive
            // together (coalesced) are spaced a microsecond apart.
            let t = (p.t / 1000.0).max(last_t + 1e-6);
            last_t = t;
            let azimuth = (p.azimuth as f64).rem_euclid(std::f64::consts::TAU) as f32;
            let input = Input {
                x: (p.x / scale) as f32,
                y: (p.y / scale) as f32,
                time: t,
                pressure: p.pressure.clamp(0.0, 1.0),
                tilt: (std::f32::consts::FRAC_PI_2 - p.altitude).clamp(0.0, std::f32::consts::FRAC_PI_2),
                orientation: azimuth,
            };
            m.update(event, input, &mut out).ok()?;
        }
        let first = points[0];
        let mut pts: Vec<InputPoint> = out
            .iter()
            .map(|s| InputPoint {
                x: s.x as f64 * scale,
                y: s.y as f64 * scale,
                pressure: s.pressure.clamp(0.0, 1.0),
                altitude: std::f32::consts::FRAC_PI_2 - s.tilt.max(0.0),
                azimuth: if s.orientation >= 0.0 { s.orientation } else { first.azimuth },
                t: s.time * 1000.0,
            })
            .collect();
        if pts.is_empty() {
            return None;
        }
        // The first point exactly where the pen touched down, and the line
        // reaching the point where it lifted.
        pts[0].x = first.x;
        pts[0].y = first.y;
        let lift = points[n - 1];
        let end = *pts.last().unwrap();
        if end.pos().distance(lift.pos()) > 1e-6 {
            pts.push(InputPoint { x: lift.x, y: lift.y, t: end.t.max(lift.t), ..end });
        }
        Some(pts)
    })
}

/// Pressure in the first few milliseconds is replaced by the first reliable
/// value (see [`UNRELIABLE_START_MS`]).
fn reliable_start(points: &[InputPoint]) -> Vec<InputPoint> {
    let n = points.len();
    let t0 = points[0].t;
    let reliable = points.iter().find(|p| p.t - t0 >= UNRELIABLE_START_MS).map(|p| p.pressure);
    let duration = points[n - 1].t - t0;
    points
        .iter()
        .map(|p| {
            let mut q = *p;
            if let Some(r) = reliable {
                if duration > 2.0 * UNRELIABLE_START_MS && p.t - t0 < UNRELIABLE_START_MS {
                    q.pressure = r;
                }
            }
            q
        })
        .collect()
}

/// The 1€ input clean-up: unreliable start pressure, then 1€ filters on
/// position, pressure and tilt. The first point stays exact, and the line
/// still reaches the point where the pen lifted. `scale` is world units per
/// input pixel (see `Stroke::input_scale`).
pub fn one_euro_points(points: &[InputPoint], scale: f64) -> Vec<InputPoint> {
    let n = points.len();
    if n < 3 {
        return points.to_vec();
    }
    let t0 = points[0].t;
    let reliable = points.iter().find(|p| p.t - t0 >= UNRELIABLE_START_MS).map(|p| p.pressure);
    let duration = points[n - 1].t - t0;
    // Steady-hand smoothing lowers the cutoffs: slow wobble is filtered
    // harder, while the speed term still lets deliberate motion through.
    let calm = 1.0 - 0.75 * smoothing() as f64;
    let mut pos = OneEuro2::new(POS_MIN_CUTOFF * calm, POS_BETA, POS_D_CUTOFF);
    let mut pr = OneEuro::new(PRESSURE_CUTOFF * calm, 0.0, 1.0);
    let mut alt = OneEuro::new(TILT_CUTOFF, 0.0, 1.0);
    let mut az_c = OneEuro::new(TILT_CUTOFF, 0.0, 1.0);
    let mut az_s = OneEuro::new(TILT_CUTOFF, 0.0, 1.0);
    let mut out: Vec<InputPoint> = points
        .iter()
        .map(|p| {
            let mut q = *p;
            if let Some(r) = reliable {
                if duration > 2.0 * UNRELIABLE_START_MS && p.t - t0 < UNRELIABLE_START_MS {
                    q.pressure = r;
                }
            }
            // Filter in input pixels, so a stroke drawn zoomed in is
            // smoothed like the same hand movement at 100%.
            let [x, y] = pos.filter([q.x / scale, q.y / scale], q.t);
            q.x = x * scale;
            q.y = y * scale;
            q.pressure = pr.filter(q.pressure as f64, q.t).clamp(0.0, 1.0) as f32;
            q.altitude = alt.filter(q.altitude as f64, q.t) as f32;
            // Azimuth is filtered as a direction (cos, sin), never as an
            // angle, so it doesn't spin when it wraps around.
            let c = az_c.filter((q.azimuth as f64).cos(), q.t);
            let s = az_s.filter((q.azimuth as f64).sin(), q.t);
            q.azimuth = s.atan2(c) as f32;
            q
        })
        .collect();
    // Catch up with the pen so the line ends where it was lifted.
    let last = points[n - 1];
    if out[n - 1].pos().distance(last.pos()) > 1e-6 {
        let mut end = last;
        end.pressure = out[n - 1].pressure;
        end.altitude = out[n - 1].altitude;
        end.azimuth = out[n - 1].azimuth;
        out.push(end);
    }
    out
}

/// Sigma of [`smooth_along`] in input pixels: enough to iron out a
/// whole-pixel staircase, small enough to keep letters' corners crisp.
pub const PIXEL_SMOOTHING: f64 = 1.5;

/// Arc-length Gaussian smoothing of positions (`sigma` in world units).
///
/// Browsers often report whole-pixel positions, so a slow shallow line
/// arrives as a staircase: 1 px jumps every few pixels. Time filters can't
/// remove that (the steps arrive at writing speed); averaging over a couple
/// of pixels of line can. The window shrinks symmetrically near the ends, so
/// the first and last points stay exactly where the pen was.
pub fn smooth_along(points: &[InputPoint], sigma: f64) -> Vec<InputPoint> {
    let n = points.len();
    if n < 3 || sigma <= 0.0 {
        return points.to_vec();
    }
    let mut arc = Vec::with_capacity(n);
    let mut acc = 0.0;
    for i in 0..n {
        if i > 0 {
            acc += points[i].pos().distance(points[i - 1].pos());
        }
        arc.push(acc);
    }
    let total = acc;
    // Corners (the tip of a v, the top of an n) stay sharp: find points
    // where the line turns by more than ~55° within a couple of sigma, and
    // never let the averaging window reach across one.
    let corners = corner_arcs(points, &arc, 2.0 * sigma);
    let reach = 3.0 * sigma;
    let inv = 1.0 / (2.0 * sigma * sigma);
    let (mut lo, mut hi) = (0usize, 0usize);
    (0..n)
        .map(|i| {
            let to_corner = corners.iter().map(|c| (c - arc[i]).abs()).fold(f64::INFINITY, f64::min);
            let r = reach.min(arc[i]).min(total - arc[i]).min(to_corner);
            let mut q = points[i];
            if r <= 1e-9 {
                return q;
            }
            while arc[i] - arc[lo] > r {
                lo += 1;
            }
            while lo > 0 && arc[i] - arc[lo - 1] <= r {
                lo -= 1;
            }
            hi = hi.max(i);
            while hi + 1 < n && arc[hi + 1] - arc[i] <= r {
                hi += 1;
            }
            while hi > i && arc[hi] - arc[i] > r {
                hi -= 1;
            }
            let (mut sx, mut sy, mut sw) = (0.0, 0.0, 0.0);
            for (j, p) in points.iter().enumerate().take(hi + 1).skip(lo) {
                let d = arc[j] - arc[i];
                let w = (-d * d * inv).exp();
                sx += p.x * w;
                sy += p.y * w;
                sw += w;
            }
            q.x = sx / sw;
            q.y = sy / sw;
            q
        })
        .collect()
}

/// Arc positions of sharp turns: local maxima of the turn angle between the
/// chord `span` behind and the chord `span` ahead, where it exceeds ~55°.
fn corner_arcs(points: &[InputPoint], arc: &[f64], span: f64) -> Vec<f64> {
    let n = points.len();
    let at = |target: f64| -> crate::geom::Vec2 {
        // Position at arc length `target` (clamped), by linear search from a
        // binary-searched start.
        let t = target.clamp(0.0, arc[n - 1]);
        let k = arc.partition_point(|&a| a < t).min(n - 1);
        if k == 0 {
            return points[0].pos();
        }
        let (a0, a1) = (arc[k - 1], arc[k]);
        let f = if a1 > a0 { (t - a0) / (a1 - a0) } else { 0.0 };
        points[k - 1].pos().lerp(points[k].pos(), f)
    };
    let turn: Vec<f64> = (0..n)
        .map(|i| {
            if arc[i] < span || arc[n - 1] - arc[i] < span {
                return 0.0;
            }
            let p = points[i].pos();
            let (a, b) = (p - at(arc[i] - span), at(arc[i] + span) - p);
            if a.length() < 1e-9 || b.length() < 1e-9 {
                return 0.0;
            }
            (a.dot(b) / (a.length() * b.length())).clamp(-1.0, 1.0).acos()
        })
        .collect();
    const SHARP: f64 = 0.96; // radians, about 55°
    let mut out = Vec::new();
    for i in 0..n {
        if turn[i] > SHARP && (i == 0 || turn[i] >= turn[i - 1]) && (i + 1 == n || turn[i] > turn[i + 1]) {
            out.push(arc[i]);
        }
    }
    out
}

/// Speed in world units per millisecond at each point: distance travelled
/// over the last `WINDOW_MS` of input, so it is smooth, and correct even when
/// several samples share a timestamp (coalesced events on some browsers
/// arrive that way, which made single-pair speeds look enormous).
pub fn speeds(points: &[InputPoint]) -> Vec<f64> {
    const WINDOW_MS: f64 = 24.0;
    let n = points.len();
    let mut arc = Vec::with_capacity(n);
    let mut acc = 0.0;
    for i in 0..n {
        if i > 0 {
            acc += points[i].pos().distance(points[i - 1].pos());
        }
        arc.push(acc);
    }
    let mut out = Vec::with_capacity(n);
    let mut j = 0;
    for i in 0..n {
        while j < i && points[i].t - points[j + 1].t >= WINDOW_MS {
            j += 1;
        }
        // Look ahead too when the window behind is short (stroke start).
        let mut k = i;
        while k + 1 < n && (points[k].t - points[j].t) < WINDOW_MS {
            k += 1;
        }
        let dt = points[k].t - points[j].t;
        out.push(if dt >= 1.0 { (arc[k] - arc[j]) / dt } else { 0.0 });
    }
    out
}

/// Whether the points carry usable timestamps (at most 4 kHz on average).
/// Imported strokes, and some synthetic input, have none: speed is then
/// unknown and nothing that depends on it should change the line.
pub fn has_timing(points: &[InputPoint]) -> bool {
    match (points.first(), points.last()) {
        (Some(a), Some(b)) if points.len() > 1 => (b.t - a.t) >= 0.25 * (points.len() - 1) as f64,
        _ => false,
    }
}

/// Width multiplier for speed: 1 when slow, down to `1 - thinning` when
/// fast. Speed only ever thins, never thickens.
pub fn speed_factor(thinning: f32, speed_px_per_ms: f64) -> f32 {
    const V_LO: f64 = 0.5;
    const V_HI: f64 = 4.0;
    let t = ((speed_px_per_ms - V_LO) / (V_HI - V_LO)).clamp(0.0, 1.0);
    1.0 - thinning * (t * t * (3.0 - 2.0 * t)) as f32
}

/// Stabiliser ("lazy brush" / pulled string): the ink point only moves when
/// the pen is more than `radius` away, dragged along behind it. Gives very
/// smooth lines for lettering. Rate independent by construction. The line
/// still ends at the pen.
pub fn pulled_string(points: &[InputPoint], radius: f64) -> Vec<InputPoint> {
    if points.len() < 3 || radius <= 0.0 {
        return points.to_vec();
    }
    let mut out = Vec::with_capacity(points.len() + 1);
    let mut ink = points[0];
    out.push(ink);
    for p in &points[1..] {
        let d = ink.pos().distance(p.pos());
        let mut q = *p;
        if d > radius {
            let k = (d - radius) / d;
            q.x = ink.x + (p.x - ink.x) * k;
            q.y = ink.y + (p.y - ink.y) * k;
            ink = q;
            out.push(q);
        }
    }
    let last = *points.last().unwrap();
    if ink.pos().distance(last.pos()) > 1e-6 {
        out.push(last);
    }
    out
}

/// The stabiliser, easing off at speed: the string shortens as the pen
/// moves faster (by half at [`EASE_SPEED`] input px/ms), so heavy smoothing
/// still lets quick, deliberate strokes through with little lag while slow
/// wobble is held back. `px` is world units per input pixel. Without
/// timestamps it is the plain [`pulled_string`].
pub fn pulled_string_eased(points: &[InputPoint], radius: f64, px: f64) -> Vec<InputPoint> {
    if points.len() < 3 || radius <= 0.0 {
        return points.to_vec();
    }
    if !has_timing(points) {
        return pulled_string(points, radius);
    }
    let px = px.max(1e-9);
    let mut out = Vec::with_capacity(points.len() + 1);
    let mut ink = points[0];
    out.push(ink);
    let mut speed = 0.0f64;
    for w in points.windows(2) {
        let (a, p) = (w[0], w[1]);
        let dt = p.t - a.t;
        if dt > 0.0 {
            let v = a.pos().distance(p.pos()) / px / dt;
            // Smooth the speed over ~20 ms so one jumpy sample doesn't matter.
            let k = 1.0 - (-dt / 20.0).exp();
            speed += (v - speed) * k;
        }
        let r = radius / (1.0 + speed / EASE_SPEED);
        let d = ink.pos().distance(p.pos());
        if d > r {
            let mut q = p;
            let k = (d - r) / d;
            q.x = ink.x + (p.x - ink.x) * k;
            q.y = ink.y + (p.y - ink.y) * k;
            ink = q;
            out.push(q);
        }
    }
    let last = *points.last().unwrap();
    if ink.pos().distance(last.pos()) > 1e-6 {
        out.push(last);
    }
    out
}

/// Pen speed (input px/ms) at which the stabiliser's string is half length.
pub const EASE_SPEED: f64 = 1.5;

/// Stabiliser radius (world units) for a slider value 0..=1.
pub fn stabilizer_radius(amount: f32) -> f64 {
    (amount.clamp(0.0, 1.0) as f64).powf(1.5) * 12.0
}

/// The person's pressure response: a smooth, monotone curve from (0,0) to
/// (1,1) through up to [`MAX_CURVE_POINTS`] points they place (as
/// Procreate's global pressure curve). Bending it up gives a full line from
/// a light touch; bending it down needs a firmer press. Device-local: it
/// calibrates the hand, not the note, and the file keeps raw pressure.
#[derive(Debug, Clone, PartialEq)]
pub struct PressureCurve {
    /// Knots including both ends, x strictly increasing, y non-decreasing.
    knots: Vec<(f32, f32)>,
    /// Hermite slopes at the knots (Fritsch-Carlson, so no overshoot).
    slopes: Vec<f32>,
}

pub const MAX_CURVE_POINTS: usize = 6;

impl PressureCurve {
    pub fn linear() -> Self {
        Self::from_points(&[])
    }

    /// A curve through these inner points (x, y in 0..=1). Points are
    /// sorted, clamped, thinned to [`MAX_CURVE_POINTS`] and made monotone,
    /// so any input gives a valid curve.
    pub fn from_points(points: &[(f32, f32)]) -> Self {
        let mut inner: Vec<(f32, f32)> = points
            .iter()
            .filter(|p| p.0.is_finite() && p.1.is_finite())
            .map(|&(x, y)| (x.clamp(0.01, 0.99), y.clamp(0.0, 1.0)))
            .collect();
        inner.sort_by(|a, b| a.0.total_cmp(&b.0));
        inner.dedup_by(|b, a| (b.0 - a.0).abs() < 0.01);
        inner.truncate(MAX_CURVE_POINTS);
        let mut knots = vec![(0.0, 0.0)];
        knots.extend(inner);
        knots.push((1.0, 1.0));
        // Monotone: never lower than the knot before.
        for i in 1..knots.len() {
            knots[i].1 = knots[i].1.max(knots[i - 1].1);
        }
        let n = knots.len();
        let d: Vec<f32> = (0..n - 1).map(|i| (knots[i + 1].1 - knots[i].1) / (knots[i + 1].0 - knots[i].0)).collect();
        let mut m = vec![0.0f32; n];
        m[0] = d[0];
        m[n - 1] = d[n - 2];
        for i in 1..n - 1 {
            m[i] = if d[i - 1] * d[i] <= 0.0 { 0.0 } else { (d[i - 1] + d[i]) / 2.0 };
        }
        for i in 0..n - 1 {
            if d[i] == 0.0 {
                m[i] = 0.0;
                m[i + 1] = 0.0;
                continue;
            }
            let (a, b) = (m[i] / d[i], m[i + 1] / d[i]);
            let h = a.hypot(b);
            if h > 3.0 {
                m[i] = 3.0 * a / h * d[i];
                m[i + 1] = 3.0 * b / h * d[i];
            }
        }
        PressureCurve { knots, slopes: m }
    }

    /// `softness` in -1 (firm: needs more pressure) ..= 1 (soft: light touch
    /// gives a full line). 0 is linear. The older single-slider setting.
    pub fn from_softness(softness: f32) -> Self {
        let s = if softness.is_finite() { softness.clamp(-1.0, 1.0) } else { 0.0 };
        if s == 0.0 {
            return Self::linear();
        }
        Self::from_points(&[(0.5, 0.5 + 0.3 * s)])
    }

    /// The inner points (without the fixed ends).
    pub fn points(&self) -> Vec<(f32, f32)> {
        self.knots[1..self.knots.len() - 1].to_vec()
    }

    pub fn is_linear(&self) -> bool {
        self.knots.iter().all(|(x, y)| (x - y).abs() < 1e-6)
    }

    pub fn apply(&self, x: f32) -> f32 {
        let x = if x.is_finite() { x.clamp(0.0, 1.0) } else { 0.0 };
        if self.knots.len() == 2 {
            return x;
        }
        let i = self.knots.windows(2).position(|w| x <= w[1].0).unwrap_or(self.knots.len() - 2);
        let ((x0, y0), (x1, y1)) = (self.knots[i], self.knots[i + 1]);
        let h = x1 - x0;
        let t = (x - x0) / h;
        let (t2, t3) = (t * t, t * t * t);
        let v = (2.0 * t3 - 3.0 * t2 + 1.0) * y0
            + (t3 - 2.0 * t2 + t) * h * self.slopes[i]
            + (-2.0 * t3 + 3.0 * t2) * y1
            + (t3 - t2) * h * self.slopes[i + 1];
        v.clamp(0.0, 1.0)
    }
}

static CURVE: std::sync::RwLock<Vec<(f32, f32)>> = std::sync::RwLock::new(Vec::new());

/// Set the device's pressure curve from its inner points. Rendering only:
/// the file keeps raw pressure. Callers must re-tessellate afterwards.
pub fn set_pressure_points(points: &[(f32, f32)]) {
    let c = PressureCurve::from_points(points);
    if let Ok(mut g) = CURVE.write() {
        *g = c.points();
    }
}

/// Set the device's pressure feel from one value (-1 firm ..= 1 soft).
pub fn set_pressure_softness(softness: f32) {
    set_pressure_points(&PressureCurve::from_softness(softness).points());
}

pub fn pressure_points() -> Vec<(f32, f32)> {
    CURVE.read().map(|g| g.clone()).unwrap_or_default()
}

pub fn pressure_curve() -> PressureCurve {
    PressureCurve::from_points(&pressure_points())
}

static SMOOTHING: AtomicU32 = AtomicU32::new(0); // f32 bits; 0.0

/// Steady-hand smoothing for every pen, 0 ..= 1 (Procreate's accessibility
/// setting for tremors): it strengthens each pen's stabiliser and the
/// jitter filter. Device-local, rendering only. Re-tessellate afterwards.
pub fn set_smoothing(amount: f32) {
    let a = if amount.is_finite() { amount.clamp(0.0, 1.0) } else { 0.0 };
    SMOOTHING.store(a.to_bits(), Ordering::Relaxed);
}

pub fn smoothing() -> f32 {
    f32::from_bits(SMOOTHING.load(Ordering::Relaxed))
}

/// A pen's stabiliser with the steady-hand smoothing added on top.
pub fn effective_stabilizer(brush_amount: f32) -> f32 {
    stabilizer_with(brush_amount, smoothing())
}

/// A pen's stabiliser `brush_amount` with steady-hand smoothing `global`.
pub fn stabilizer_with(brush_amount: f32, global: f32) -> f32 {
    let g = global.clamp(0.0, 1.0) * 0.7;
    1.0 - (1.0 - brush_amount.clamp(0.0, 1.0)) * (1.0 - g)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_euro_smooths_slow_noise_but_follows_fast_motion() {
        // Standing still with ±0.3 jitter at 240 Hz.
        let mut f = OneEuro2::new(POS_MIN_CUTOFF, POS_BETA, POS_D_CUTOFF);
        let mut worst: f64 = 0.0;
        for i in 0..240 {
            let j = if i % 2 == 0 { 0.3 } else { -0.3 };
            let v = f.filter([j, 0.0], i as f64 * 4.17);
            if i > 24 {
                worst = worst.max(v[0].abs());
            }
        }
        assert!(worst < 0.1, "jitter left: {worst}");
        // Fast stroke: 2 px/ms (a quick handwriting stroke).
        let mut f = OneEuro2::new(POS_MIN_CUTOFF, POS_BETA, POS_D_CUTOFF);
        let mut lag = 0.0;
        for i in 0..120 {
            let t = i as f64 * 4.17;
            let v = f.filter([t * 2.0, 0.0], t);
            lag = t * 2.0 - v[0];
        }
        assert!(lag < 2.0, "fast stroke lags {lag} units");
    }

    #[test]
    fn decimate_keeps_ends_and_spacing() {
        let pts: Vec<_> = (0..50).map(|i| InputPoint::new(i as f64 * 0.02, 0.0, 0.5)).collect();
        let d = decimate(&pts, 0.5);
        assert_eq!(d.first(), pts.first());
        assert_eq!(d.last(), pts.last());
        assert!(d.len() <= 3, "{} points kept from a 1 unit squiggle", d.len());
        for w in d.windows(2) {
            assert!(w[0].pos().distance(w[1].pos()) >= 0.5 || w[1] == *pts.last().unwrap());
        }
    }

    #[test]
    fn pressure_curve_through_points_is_smooth_and_monotone() {
        // Any points, even messy ones, give a valid curve.
        let c = PressureCurve::from_points(&[(0.7, 0.6), (0.2, 0.5), (0.4, 0.3), (f32::NAN, 0.1), (0.9, 2.0)]);
        assert_eq!(c.apply(0.0), 0.0);
        assert_eq!(c.apply(1.0), 1.0);
        let mut last = 0.0;
        for i in 0..=200 {
            let y = c.apply(i as f32 / 200.0);
            assert!(y >= last - 1e-6, "monotone");
            last = y;
        }
        assert!((c.apply(0.2) - 0.5).abs() < 1e-5, "passes through its points");
        assert!(
            PressureCurve::from_points(&[
                (0.1, 0.1),
                (0.2, 0.2),
                (0.3, 0.3),
                (0.4, 0.4),
                (0.5, 0.5),
                (0.6, 0.6),
                (0.7, 0.7),
                (0.8, 0.8)
            ])
            .points()
            .len()
                == MAX_CURVE_POINTS
        );
        assert!(PressureCurve::linear().is_linear());
        // A light hand: bend the curve up.
        let light = PressureCurve::from_points(&[(0.2, 0.5)]);
        assert!(light.apply(0.2) > 0.45 && light.apply(0.6) > 0.6);
    }

    #[test]
    fn eased_stabiliser_follows_fast_strokes_closer() {
        // The same zigzag drawn slowly and quickly.
        let zig = |ms_per_pt: f64| -> Vec<InputPoint> {
            (0..200)
                .map(|i| {
                    InputPoint::new(i as f64 * 0.5, if i % 2 == 0 { 0.0 } else { 1.0 }, 0.5).at(i as f64 * ms_per_pt)
                })
                .collect()
        };
        let wobble = |p: &[InputPoint]| {
            p.iter().map(|q| q.y).fold(f64::MIN, f64::max) - p.iter().skip(5).map(|q| q.y).fold(f64::MAX, f64::min)
        };
        let slow = pulled_string_eased(&zig(8.0), 4.0, 1.0);
        let fast = pulled_string_eased(&zig(1.0), 4.0, 1.0);
        assert!(slow.len() < fast.len(), "the string is shorter at speed, so more points pass");
        assert!(wobble(&slow) <= 1.0);
        // Without timing it is the plain pulled string.
        let untimed: Vec<_> = zig(0.0).into_iter().map(|p| p.at(0.0)).collect();
        assert_eq!(pulled_string_eased(&untimed, 4.0, 1.0), pulled_string(&untimed, 4.0));
    }

    /// A shaky line as a pen reports it: a sample every 8 ms, wobbling
    /// 6 px up and down around y = 0.
    fn tremor_line() -> Vec<InputPoint> {
        (0..=60)
            .map(|i| InputPoint::new(i as f64 * 8.0, if i % 2 == 1 { 6.0 } else { -6.0 }, 0.5).at(i as f64 * 8.0))
            .collect()
    }

    #[test]
    fn the_modeler_takes_out_tremor_and_keeps_both_ends() {
        let input = tremor_line();
        let out = model_points(&input, 1.0).expect("the modeler takes a normal stroke");
        let wobble = |pts: &[InputPoint]| {
            let mid: Vec<_> = pts.iter().filter(|p| p.x > 80.0 && p.x < 400.0).collect();
            mid.iter().map(|p| p.y.abs()).sum::<f64>() / mid.len() as f64
        };
        assert!(wobble(&out) < wobble(&input) * 0.2, "wobble {} vs {}", wobble(&out), wobble(&input));
        assert_eq!((out[0].x, out[0].y), (input[0].x, input[0].y), "starts where the pen touched down");
        let (a, b) = (out.last().unwrap(), input.last().unwrap());
        assert_eq!((a.x, a.y), (b.x, b.y), "ends where the pen lifted");
        assert!(out.windows(2).all(|w| w[1].t >= w[0].t), "time order");
    }

    #[test]
    fn the_modeler_works_at_any_zoom() {
        // The same hand movement drawn zoomed in (world units half the
        // input pixels) is the same line, half the size.
        let at = |scale: f64| {
            let pts: Vec<_> =
                tremor_line().iter().map(|p| InputPoint { x: p.x * scale, y: p.y * scale, ..*p }).collect();
            model_points(&pts, scale).unwrap()
        };
        let (one, half) = (at(1.0), at(0.5));
        assert_eq!(one.len(), half.len());
        for (a, b) in one.iter().zip(&half) {
            assert!((a.x * 0.5 - b.x).abs() < 1e-3 && (a.y * 0.5 - b.y).abs() < 1e-3);
        }
    }

    #[test]
    fn strokes_without_timing_skip_the_modeler() {
        // Imported strokes have no pen timing for the modeler to work from.
        let pts: Vec<_> = (0..20).map(|i| InputPoint::new(i as f64 * 3.0, (i % 2) as f64, 0.5)).collect();
        assert!(!has_timing(&pts));
        assert_eq!(filter_points(&pts, 1.0), one_euro_points(&pts, 1.0));
    }

    #[test]
    fn the_modeler_is_the_usual_smoother() {
        // Read only: tests run in parallel, so none changes the setting.
        assert_eq!(smoother(), Smoother::Modeler);
    }

    #[test]
    fn steady_hand_smoothing_adds_to_every_pen() {
        // (Pure function: tests run in parallel, so no global changes here.)
        assert_eq!(stabilizer_with(0.0, 0.0), 0.0);
        assert!((stabilizer_with(0.4, 0.0) - 0.4).abs() < 1e-6);
        assert!(stabilizer_with(0.0, 1.0) > 0.6);
        assert!(stabilizer_with(0.5, 1.0) > 0.5 && stabilizer_with(1.0, 1.0) == 1.0);
    }

    #[test]
    fn pressure_curve_is_monotone_hits_endpoints_and_defaults_to_linear() {
        for s in [-1.0, -0.4, 0.0, 0.5, 1.0] {
            let c = PressureCurve::from_softness(s);
            assert!(c.apply(0.0).abs() < 1e-4 && (c.apply(1.0) - 1.0).abs() < 1e-4, "{s}");
            let mut prev = -1.0;
            for i in 0..=100 {
                let y = c.apply(i as f32 / 100.0);
                assert!(y >= prev - 1e-5, "softness {s} not monotone at {i}");
                prev = y;
            }
        }
        for i in 0..=10 {
            let x = i as f32 / 10.0;
            assert_eq!(PressureCurve::from_softness(0.0).apply(x), x, "default leaves pressure unchanged");
        }
        assert!(PressureCurve::from_softness(1.0).apply(0.3) > 0.4, "soft: light touch goes further");
        assert!(PressureCurve::from_softness(-1.0).apply(0.3) < 0.2, "firm: needs more pressure");
    }

    #[test]
    fn missing_timestamps_are_detected() {
        let timed: Vec<_> = (0..10).map(|i| InputPoint::new(i as f64, 0.0, 0.5).at(i as f64 * 4.0)).collect();
        let untimed: Vec<_> = (0..10).map(|i| InputPoint::new(i as f64, 0.0, 0.5)).collect();
        assert!(has_timing(&timed));
        assert!(!has_timing(&untimed));
        assert!(!has_timing(&timed[..1]));
    }

    #[test]
    fn speed_survives_shared_timestamps() {
        // 1 unit/ms, but samples arrive in pairs with the same timestamp.
        let pts: Vec<_> =
            (0..100).map(|i| InputPoint::new(i as f64 * 2.0, 0.0, 0.5).at((i / 2) as f64 * 4.0)).collect();
        for v in &speeds(&pts)[20..80] {
            assert!((v - 1.0).abs() < 0.15, "speed {v}");
        }
    }

    #[test]
    fn speed_only_thins() {
        assert_eq!(speed_factor(0.3, 0.0), 1.0);
        assert!((speed_factor(0.3, 10.0) - 0.7).abs() < 1e-6);
        assert_eq!(speed_factor(0.0, 10.0), 1.0);
        for i in 0..100 {
            let f = speed_factor(0.3, i as f64 * 0.05);
            assert!((0.7..=1.0).contains(&f));
        }
    }

    #[test]
    fn pulled_string_is_rate_independent_and_ends_at_the_pen() {
        let line = |hz: f64| -> Vec<InputPoint> {
            let n = (hz * 0.5) as usize;
            (0..n).map(|i| InputPoint::new(i as f64 * 200.0 / n as f64, 0.0, 0.5).at(i as f64 * 1000.0 / hz)).collect()
        };
        for hz in [60.0, 240.0] {
            let p = line(hz);
            let s = pulled_string(&p, 5.0);
            assert_eq!(s.last().unwrap().pos(), p.last().unwrap().pos());
            // Lags the pen by the radius, whatever the input rate.
            let mid = s[s.len() / 2].x;
            assert!(s.iter().all(|q| q.x <= 200.0 + 1e-9));
            assert!(mid > 0.0);
        }
    }
}
