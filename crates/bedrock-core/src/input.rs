//! Raw input samples exactly as the pen reported them (in world space).
//!
//! We keep *every* sample with its timestamp. That is what makes strokes
//! re-renderable with improved brushes later, and it is the input that online
//! handwriting recognisers (InkML, Google Ink, MyScript, Apple's own) expect.

use crate::geom::Vec2;
use std::f32::consts::FRAC_PI_2;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InputPoint {
    /// World X.
    pub x: f64,
    /// World Y (down is positive, like the screen and SVG).
    pub y: f64,
    /// Normalised pressure 0..=1. Mice report 0.5.
    pub pressure: f32,
    /// Pen altitude in radians: PI/2 = perpendicular to the screen, 0 = flat.
    pub altitude: f32,
    /// Pen azimuth in radians, clockwise from the positive X axis.
    pub azimuth: f32,
    /// Milliseconds since the stroke started.
    pub t: f64,
}

impl InputPoint {
    pub fn new(x: f64, y: f64, pressure: f32) -> Self {
        Self { x, y, pressure, altitude: FRAC_PI_2, azimuth: 0.0, t: 0.0 }
    }

    pub fn with_tilt(mut self, altitude: f32, azimuth: f32) -> Self {
        self.altitude = altitude;
        self.azimuth = azimuth;
        self
    }

    pub fn at(mut self, t: f64) -> Self {
        self.t = t;
        self
    }

    pub fn pos(&self) -> Vec2 {
        Vec2::new(self.x, self.y)
    }

    /// 0 when the pen is upright, 1 when it lies flat on the glass.
    pub fn tilt_amount(&self) -> f32 {
        (1.0 - self.altitude / FRAC_PI_2).clamp(0.0, 1.0)
    }

    /// Clamp any out-of-range values a browser might hand us.
    pub fn sanitized(mut self) -> Self {
        if !self.pressure.is_finite() {
            self.pressure = 0.5;
        }
        self.pressure = self.pressure.clamp(0.0, 1.0);
        if !self.altitude.is_finite() {
            self.altitude = FRAC_PI_2;
        }
        self.altitude = self.altitude.clamp(0.0, FRAC_PI_2);
        if !self.azimuth.is_finite() {
            self.azimuth = 0.0;
        }
        if !self.t.is_finite() {
            self.t = 0.0;
        }
        self
    }
}

/// Converts Pointer Events `tiltX`/`tiltY` (degrees, -90..90) into
/// (altitude, azimuth) radians, following the Pointer Events 3 spec.
pub fn tilt_to_altitude_azimuth(tilt_x_deg: f32, tilt_y_deg: f32) -> (f32, f32) {
    let tx = tilt_x_deg.to_radians();
    let ty = tilt_y_deg.to_radians();
    if tilt_x_deg == 0.0 && tilt_y_deg == 0.0 {
        return (FRAC_PI_2, 0.0);
    }
    let azimuth = {
        let a = ty.tan().atan2(tx.tan());
        if a < 0.0 {
            a + 2.0 * std::f32::consts::PI
        } else {
            a
        }
    };
    let altitude = if tilt_x_deg.abs() >= 90.0 || tilt_y_deg.abs() >= 90.0 {
        0.0
    } else {
        let tan_x = tx.tan();
        let tan_y = ty.tan();
        (1.0 / (tan_x * tan_x + tan_y * tan_y).sqrt()).atan()
    };
    (altitude, azimuth)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upright_pen_has_no_tilt() {
        let (alt, _) = tilt_to_altitude_azimuth(0.0, 0.0);
        assert!((alt - FRAC_PI_2).abs() < 1e-6);
        assert_eq!(InputPoint::new(0.0, 0.0, 1.0).tilt_amount(), 0.0);
    }

    #[test]
    fn tilt_x_maps_to_azimuth_zero() {
        let (alt, az) = tilt_to_altitude_azimuth(45.0, 0.0);
        assert!((alt - std::f32::consts::FRAC_PI_4).abs() < 1e-4, "alt {alt}");
        assert!(az.abs() < 1e-4);
        let (_, az) = tilt_to_altitude_azimuth(0.0, 45.0);
        assert!((az - FRAC_PI_2).abs() < 1e-4);
    }

    #[test]
    fn sanitize_clamps_garbage() {
        let p = InputPoint { x: 0.0, y: 0.0, pressure: f32::NAN, altitude: 9.0, azimuth: f32::INFINITY, t: f64::NAN }
            .sanitized();
        assert_eq!(p.pressure, 0.5);
        assert_eq!(p.altitude, FRAC_PI_2);
        assert_eq!(p.azimuth, 0.0);
        assert_eq!(p.t, 0.0);
    }
}
