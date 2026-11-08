//! Signal processing for pen input, applied at render time to the raw
//! samples stored in the file (so every improvement here also improves old
//! notes, and the file never changes):
//!
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
use std::sync::atomic::{AtomicU32, Ordering};

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

/// The full input clean-up: unreliable start pressure, then 1€ filters on
/// position, pressure and tilt. The first point stays exact, and the line
/// still reaches the point where the pen lifted.
pub fn filter_points(points: &[InputPoint]) -> Vec<InputPoint> {
    let n = points.len();
    if n < 3 {
        return points.to_vec();
    }
    let t0 = points[0].t;
    let reliable = points.iter().find(|p| p.t - t0 >= UNRELIABLE_START_MS).map(|p| p.pressure);
    let duration = points[n - 1].t - t0;
    let mut pos = OneEuro2::new(POS_MIN_CUTOFF, POS_BETA, POS_D_CUTOFF);
    let mut pr = OneEuro::new(PRESSURE_CUTOFF, 0.0, 1.0);
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
            let [x, y] = pos.filter([q.x, q.y], q.t);
            q.x = x;
            q.y = y;
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

/// Speed in world units per millisecond at each point, smoothed in time
/// (about 30 ms) because raw speed at 240 Hz is very noisy.
pub fn speeds(points: &[InputPoint]) -> Vec<f64> {
    const TAU_MS: f64 = 30.0;
    let mut out = Vec::with_capacity(points.len());
    let mut v = 0.0;
    for (i, p) in points.iter().enumerate() {
        if i > 0 {
            let q = points[i - 1];
            // Resampled points can be well under 1 ms apart; the EMA weight
            // scales with dt, so a tiny dt can't make a spike.
            let dt = (p.t - q.t).max(1e-3);
            let raw = p.pos().distance(q.pos()) / dt;
            v = if i == 1 { raw } else { v + (raw - v) * (1.0 - (-dt / TAU_MS).exp()) };
        }
        out.push(v);
    }
    if out.len() > 1 {
        out[0] = out[1];
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
    const V_LO: f64 = 0.3;
    const V_HI: f64 = 3.0;
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

/// Stabiliser radius (world units) for a slider value 0..=1.
pub fn stabilizer_radius(amount: f32) -> f64 {
    (amount.clamp(0.0, 1.0) as f64).powf(1.5) * 12.0
}

/// A pressure response curve: the cubic Bézier from (0,0) to (1,1) with
/// control points `p1` and `p2` (x within 0..=1, so it is a function, and y
/// within 0..=1, so it is monotone).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PressureCurve {
    pub p1: (f32, f32),
    pub p2: (f32, f32),
}

impl PressureCurve {
    pub const LINEAR: PressureCurve = PressureCurve { p1: (1.0 / 3.0, 1.0 / 3.0), p2: (2.0 / 3.0, 2.0 / 3.0) };

    /// `softness` in -1 (firm: needs more pressure) ..= 1 (soft: light touch
    /// gives a full line). 0 is linear.
    pub fn from_softness(softness: f32) -> Self {
        let s = softness.clamp(-1.0, 1.0) * 0.25;
        PressureCurve { p1: (1.0 / 3.0 - s, 1.0 / 3.0 + s), p2: (2.0 / 3.0 - s, 2.0 / 3.0 + s) }
    }

    pub fn apply(&self, x: f32) -> f32 {
        let x = x.clamp(0.0, 1.0);
        if *self == Self::LINEAR {
            return x;
        }
        let bez = |a: f32, b: f32, t: f32| {
            let u = 1.0 - t;
            3.0 * u * u * t * a + 3.0 * u * t * t * b + t * t * t
        };
        // x(t) is increasing; find t by bisection.
        let (mut lo, mut hi) = (0.0f32, 1.0f32);
        for _ in 0..24 {
            let mid = 0.5 * (lo + hi);
            if bez(self.p1.0, self.p2.0, mid) < x {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        bez(self.p1.1, self.p2.1, 0.5 * (lo + hi)).clamp(0.0, 1.0)
    }
}

static SOFTNESS: AtomicU32 = AtomicU32::new(0); // f32 bits; 0.0

/// Set the device's pressure feel (-1 firm ..= 1 soft). Rendering only:
/// the file keeps raw pressure. Callers must re-tessellate afterwards.
pub fn set_pressure_softness(softness: f32) {
    let s = if softness.is_finite() { softness.clamp(-1.0, 1.0) } else { 0.0 };
    SOFTNESS.store(s.to_bits(), Ordering::Relaxed);
}

pub fn pressure_softness() -> f32 {
    f32::from_bits(SOFTNESS.load(Ordering::Relaxed))
}

pub fn pressure_curve() -> PressureCurve {
    PressureCurve::from_softness(pressure_softness())
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
