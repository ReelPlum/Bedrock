//! Vector brushes. A brush turns a sample (pressure, tilt, direction) into a
//! width and an opacity. Strokes keep the raw samples, so brush improvements
//! re-render old notes too.

use crate::color::Rgba;
use crate::input::InputPoint;
use serde::{Deserialize, Serialize};
use std::f32::consts::{FRAC_PI_4, PI};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrushKind {
    /// Fineliner / ballpoint: crisp, gently pressure sensitive.
    Pen,
    /// Graphite: thin when upright, broad and light when tilted for shading.
    Pencil,
    /// Calligraphy nib: width depends on stroke direction vs. nib angle.
    Fountain,
    /// Felt marker: bold and nearly constant.
    Marker,
    /// Translucent, drawn underneath ink.
    Highlighter,
}

impl BrushKind {
    pub const ALL: [BrushKind; 5] =
        [BrushKind::Pen, BrushKind::Pencil, BrushKind::Fountain, BrushKind::Marker, BrushKind::Highlighter];

    pub fn name(&self) -> &'static str {
        match self {
            BrushKind::Pen => "pen",
            BrushKind::Pencil => "pencil",
            BrushKind::Fountain => "fountain",
            BrushKind::Marker => "marker",
            BrushKind::Highlighter => "highlighter",
        }
    }

    pub fn from_name(s: &str) -> Option<BrushKind> {
        BrushKind::ALL.into_iter().find(|k| k.name() == s)
    }
}

/// How the line is drawn along the stroke.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LineStyle {
    #[default]
    Solid,
    Dashed,
    Dotted,
}

impl LineStyle {
    pub fn from_name(s: &str) -> Option<LineStyle> {
        match s {
            "solid" => Some(LineStyle::Solid),
            "dashed" => Some(LineStyle::Dashed),
            "dotted" => Some(LineStyle::Dotted),
            _ => None,
        }
    }
    fn is_solid(&self) -> bool {
        *self == LineStyle::Solid
    }
}

/// The even press a brush with no pressure sensitivity draws with.
pub const FIXED_PRESSURE: f32 = 0.75;

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn is_zero(v: &f32) -> bool {
    *v == 0.0
}

/// Writes an f32 as the shortest decimal that reads back as the same f32
/// (0.4, not 0.4000000059604645), so files stay readable and stable.
fn short_f32<S: serde::Serializer>(v: &f32, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64(v.to_string().parse::<f64>().unwrap_or(*v as f64))
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Brush {
    pub kind: BrushKind,
    pub color: Rgba,
    /// Nominal width in world units at full pressure.
    #[serde(serialize_with = "short_f32")]
    pub size: f32,
    #[serde(default, skip_serializing_if = "LineStyle::is_solid")]
    pub style: LineStyle,
    /// Stabiliser strength 0..=1: how much the line lags behind the pen to
    /// smooth out shaky hands. Applied when rendering, so the raw samples
    /// in the file stay untouched and the setting can be changed later.
    #[serde(default, skip_serializing_if = "is_zero", serialize_with = "short_f32")]
    pub stabilizer: f32,
    /// How strongly the start thins, 0 (none) ..= 1. `None`: the kind's own
    /// default (see [`Brush::taper_start`]). The tuning fields below are
    /// all like this: absent in the file means "the pen's usual feel", so
    /// old notes keep their look and future defaults can improve.
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "short_opt")]
    pub taper_start: Option<f32>,
    /// How strongly the end thins, 0 ..= 1. Fast lifts thin more.
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "short_opt")]
    pub taper_end: Option<f32>,
    /// How much tapered ends also fade out, 0 ..= 1.
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "short_opt")]
    pub taper_fade: Option<f32>,
    /// How much pressure changes the line, 0 (not at all, like a ballpoint)
    /// ..= 1 (the kind's full response).
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "short_opt")]
    pub pressure: Option<f32>,
    /// How much faster movement thins the line, 0 ..= 1.
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "short_opt")]
    pub speed: Option<f32>,
}

fn short_opt<S: serde::Serializer>(v: &Option<f32>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(v) => short_f32(v, s),
        None => s.serialize_none(),
    }
}

/// A tuning value from the UI: finite values are clamped to 0..=1, anything
/// else (NaN, negative from "use the default") means `None`.
pub fn tuning(v: f32) -> Option<f32> {
    (v.is_finite() && v >= 0.0).then(|| v.min(1.0))
}

impl Default for Brush {
    fn default() -> Self {
        Brush {
            kind: BrushKind::Pen,
            color: Rgba::BLACK,
            size: 3.0,
            style: LineStyle::Solid,
            stabilizer: 0.0,
            taper_start: None,
            taper_end: None,
            taper_fade: None,
            pressure: None,
            speed: None,
        }
    }
}

/// What the brush wants at one sample.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Footprint {
    pub width: f32,
    /// Multiplier on the brush colour's alpha (0..=1).
    pub opacity: f32,
}

impl Brush {
    pub fn new(kind: BrushKind, color: Rgba, size: f32) -> Self {
        Brush { kind, color, size, ..Brush::default() }
    }

    pub fn with_style(mut self, style: LineStyle) -> Self {
        self.style = style;
        self
    }

    pub fn with_stabilizer(mut self, amount: f32) -> Self {
        self.stabilizer = if amount.is_finite() { amount.clamp(0.0, 1.0) } else { 0.0 };
        self
    }

    /// Footprint for sample `p` moving in direction `dir_angle` (radians).
    pub fn footprint(&self, p: &InputPoint, dir_angle: f32) -> Footprint {
        let s = self.size.max(0.1);
        // Pressure sensitivity: 0 holds every sample at a firm, even press.
        let sens = self.pressure.unwrap_or(1.0).clamp(0.0, 1.0);
        let pr = FIXED_PRESSURE + (p.pressure.clamp(0.0, 1.0) - FIXED_PRESSURE) * sens;
        let tilt = p.tilt_amount();
        match self.kind {
            BrushKind::Pen => {
                // A laid-down pen touches with more of its tip: up to 15% wider.
                let lean = 1.0 + 0.15 * smoothstep(0.3, 0.8, tilt);
                Footprint { width: s * (0.3 + 0.7 * pr.powf(0.8)) * lean, opacity: 1.0 }
            }
            BrushKind::Pencil => {
                // Tilting the pencil uses the side of the lead: wider and
                // lighter. A normal writing grip already holds the Pencil at
                // 45-65 degrees, so shading only starts once it is laid
                // flatter than that (as with a real pencil).
                let shade = smoothstep(0.45, 0.85, tilt);
                let width = s * (0.5 + 0.5 * pr) * (1.0 + 3.0 * shade * shade);
                let opacity = (0.25 + 0.75 * pr) * (1.0 - 0.55 * shade);
                Footprint { width, opacity: opacity.clamp(0.05, 1.0) }
            }
            BrushKind::Fountain => {
                // A tilted pen defines the nib angle; upright falls back to
                // 45°. The two are blended smoothly (in doubled-angle space,
                // since a nib at 0° and 180° is the same nib) so the width
                // can't jump while the pen passes through a near-upright grip.
                let k = smoothstep(0.08, 0.25, tilt);
                let held = p.azimuth + PI / 2.0;
                let (x, y) = (
                    (1.0 - k) * (2.0 * FRAC_PI_4).cos() + k * (2.0 * held).cos(),
                    (1.0 - k) * (2.0 * FRAC_PI_4).sin() + k * (2.0 * held).sin(),
                );
                let nib = if x.hypot(y) > 1e-4 {
                    0.5 * y.atan2(x)
                } else if k >= 0.5 {
                    held
                } else {
                    FRAC_PI_4
                };
                let across = (dir_angle - nib).sin().abs();
                Footprint { width: s * (0.2 + 1.3 * across) * (0.55 + 0.45 * pr), opacity: 1.0 }
            }
            BrushKind::Marker => Footprint { width: s * (0.85 + 0.15 * pr), opacity: 1.0 },
            BrushKind::Highlighter => Footprint { width: s * 4.0, opacity: 1.0 },
        }
    }

    /// How much faster strokes thin (0 = not at all, 0.2 = to 80% width).
    /// Kept well below the pressure range so pressure stays the main control.
    /// The `speed` setting 0..=1 maps to 0..=0.4 (the pen's default is 0.5).
    pub fn thinning(&self) -> f32 {
        if let Some(v) = self.speed {
            return v.clamp(0.0, 1.0) * 0.4;
        }
        match self.kind {
            BrushKind::Pen => 0.2,
            BrushKind::Fountain => 0.15,
            BrushKind::Pencil => 0.1,
            BrushKind::Marker | BrushKind::Highlighter => 0.0,
        }
    }

    /// The default taper for this kind: inked tips taper, felt tips and
    /// highlighters don't.
    fn default_taper(&self) -> f32 {
        match self.kind {
            BrushKind::Pen | BrushKind::Fountain | BrushKind::Pencil => 0.5,
            BrushKind::Marker | BrushKind::Highlighter => 0.0,
        }
    }

    /// Start taper amount 0..=1 (0.5: thins to 40% over one stroke width).
    pub fn taper_start(&self) -> f32 {
        self.taper_start.unwrap_or_else(|| self.default_taper()).clamp(0.0, 1.0)
    }

    /// End taper amount 0..=1 (0.5: thins to 65% over one stroke width).
    pub fn taper_end(&self) -> f32 {
        self.taper_end.unwrap_or_else(|| self.default_taper()).clamp(0.0, 1.0)
    }

    /// How much the tapered ends fade out too, 0..=1.
    pub fn taper_fade(&self) -> f32 {
        self.taper_fade.unwrap_or(0.0).clamp(0.0, 1.0)
    }

    /// Whether stroke ends are tapered at all.
    pub fn tapers(&self) -> bool {
        self.taper_start() > 0.0 || self.taper_end() > 0.0
    }

    /// Effective colour alpha for the whole stroke.
    pub fn stroke_alpha(&self) -> f32 {
        let a = self.color.alpha_f32();
        match self.kind {
            BrushKind::Highlighter => a * 0.35,
            _ => a,
        }
    }

    /// Largest width this brush can produce: used for bounds.
    pub fn max_width(&self) -> f32 {
        let s = self.size.max(0.1);
        match self.kind {
            BrushKind::Pen => s * 1.15,
            BrushKind::Pencil => s * 4.0,
            BrushKind::Fountain => s * 1.5,
            BrushKind::Marker => s,
            BrushKind::Highlighter => s * 4.0,
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn fractional_settings_are_written_as_short_decimals() {
        // Bug: a stabiliser of 0.4 was saved as 0.4000000059604645.
        let b = Brush::new(BrushKind::Pen, Rgba::BLACK, 2.3).with_stabilizer(0.4).with_style(LineStyle::Dotted);
        let json = serde_json::to_string(&b).unwrap();
        assert!(json.contains("\"size\":2.3,") && json.contains("\"stabilizer\":0.4"), "{json}");
        assert!(json.contains("\"style\":\"dotted\""), "{json}");
        let back: Brush = serde_json::from_str(&json).unwrap();
        assert_eq!(back, b);
    }

    use super::*;

    #[test]
    fn tuning_is_optional_in_the_file_and_overrides_the_kind() {
        let b = Brush::new(BrushKind::Marker, Rgba::BLACK, 2.0);
        let json = serde_json::to_string(&b).unwrap();
        assert!(!json.contains("taper") && !json.contains("pressure") && !json.contains("speed"), "{json}");
        assert!(!b.tapers());
        let t = Brush {
            taper_start: Some(0.3),
            taper_end: Some(0.9),
            taper_fade: Some(0.5),
            pressure: Some(0.0),
            speed: Some(1.0),
            ..b
        };
        let json = serde_json::to_string(&t).unwrap();
        assert!(json.contains("\"taper_start\":0.3") && json.contains("\"pressure\":0"), "{json}");
        let back: Brush = serde_json::from_str(&json).unwrap();
        assert_eq!(back, t);
        assert!(back.tapers());
        assert!((back.thinning() - 0.4).abs() < 1e-6);
        assert_eq!(tuning(f32::NAN), None);
        assert_eq!(tuning(-1.0), None);
        assert_eq!(tuning(3.0), Some(1.0));
    }

    #[test]
    fn no_pressure_sensitivity_means_even_width() {
        let b = Brush { pressure: Some(0.0), ..Brush::new(BrushKind::Pen, Rgba::BLACK, 4.0) };
        assert_eq!(b.footprint(&pt(0.1), 0.0).width, b.footprint(&pt(1.0), 0.0).width);
        let half = Brush { pressure: Some(0.5), ..b };
        let full = Brush { pressure: None, ..b };
        let spread = |b: &Brush| b.footprint(&pt(1.0), 0.0).width - b.footprint(&pt(0.1), 0.0).width;
        assert!(spread(&half) > 0.0 && spread(&half) < spread(&full));
    }

    fn pt(p: f32) -> InputPoint {
        InputPoint::new(0.0, 0.0, p)
    }

    #[test]
    fn every_brush_grows_or_holds_with_pressure() {
        for kind in BrushKind::ALL {
            let b = Brush::new(kind, Rgba::BLACK, 4.0);
            let mut last = 0.0;
            for i in 0..=10 {
                let w = b.footprint(&pt(i as f32 / 10.0), 0.0).width;
                assert!(w >= last - 1e-6, "{kind:?} width shrank with pressure");
                assert!(w <= b.max_width() + 1e-4, "{kind:?} exceeded max width");
                assert!(w > 0.0);
                last = w;
            }
        }
    }

    #[test]
    fn tilted_pencil_is_wider_and_lighter() {
        let b = Brush::new(BrushKind::Pencil, Rgba::BLACK, 2.0);
        let upright = b.footprint(&pt(0.5), 0.0);
        let tilted = b.footprint(&pt(0.5).with_tilt(0.3, 0.0), 0.0);
        assert!(tilted.width > upright.width * 1.5);
        assert!(tilted.opacity < upright.opacity);
    }

    #[test]
    fn fountain_pen_depends_on_direction() {
        let b = Brush::new(BrushKind::Fountain, Rgba::BLACK, 4.0);
        let along = b.footprint(&pt(1.0), FRAC_PI_4).width;
        let across = b.footprint(&pt(1.0), FRAC_PI_4 + PI / 2.0).width;
        assert!(across > along * 3.0, "across {across} along {along}");
    }

    #[test]
    fn names_roundtrip() {
        for k in BrushKind::ALL {
            assert_eq!(BrushKind::from_name(k.name()), Some(k));
        }
        assert_eq!(BrushKind::from_name("crayon"), None);
    }

    #[test]
    fn highlighter_is_translucent() {
        assert!(Brush::new(BrushKind::Highlighter, Rgba::rgb(255, 230, 0), 6.0).stroke_alpha() < 0.5);
    }
}
