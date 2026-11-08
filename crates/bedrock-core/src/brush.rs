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

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Brush {
    pub kind: BrushKind,
    pub color: Rgba,
    /// Nominal width in world units at full pressure.
    pub size: f32,
}

impl Default for Brush {
    fn default() -> Self {
        Brush { kind: BrushKind::Pen, color: Rgba::BLACK, size: 3.0 }
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
        Brush { kind, color, size }
    }

    /// Footprint for sample `p` moving in direction `dir_angle` (radians).
    pub fn footprint(&self, p: &InputPoint, dir_angle: f32) -> Footprint {
        let s = self.size.max(0.1);
        let pr = p.pressure.clamp(0.0, 1.0);
        let tilt = p.tilt_amount();
        match self.kind {
            BrushKind::Pen => Footprint { width: s * (0.3 + 0.7 * pr.powf(0.8)), opacity: 1.0 },
            BrushKind::Pencil => {
                // Tilting the pencil uses the side of the lead: wider and lighter.
                let width = s * (0.5 + 0.5 * pr) * (1.0 + 3.0 * tilt * tilt);
                let opacity = (0.25 + 0.75 * pr) * (1.0 - 0.55 * tilt);
                Footprint { width, opacity: opacity.clamp(0.05, 1.0) }
            }
            BrushKind::Fountain => {
                // A tilted pen defines the nib angle; upright falls back to 45°.
                let nib = if tilt > 0.15 { p.azimuth + PI / 2.0 } else { FRAC_PI_4 };
                let across = (dir_angle - nib).sin().abs();
                Footprint { width: s * (0.2 + 1.3 * across) * (0.55 + 0.45 * pr), opacity: 1.0 }
            }
            BrushKind::Marker => Footprint { width: s * (0.85 + 0.15 * pr), opacity: 1.0 },
            BrushKind::Highlighter => Footprint { width: s * 4.0, opacity: 1.0 },
        }
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
            BrushKind::Pen => s,
            BrushKind::Pencil => s * 4.0,
            BrushKind::Fountain => s * 1.5,
            BrushKind::Marker => s,
            BrushKind::Highlighter => s * 4.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
