//! A stroke is one pen-down → pen-up gesture: a brush plus raw samples.

use crate::brush::Brush;
use crate::geom::{Rect, Vec2};
use crate::input::InputPoint;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

/// Stable, globally unique stroke identifier (64 random bits, written as 16
/// hex chars). Recognition results and future sync reference strokes by it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StrokeId(pub u64);

impl fmt::Display for StrokeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:016x}", self.0)
    }
}

impl StrokeId {
    pub fn parse(s: &str) -> Option<StrokeId> {
        if s.is_empty() || s.len() > 16 {
            return None;
        }
        u64::from_str_radix(s, 16).ok().map(StrokeId)
    }
}

impl Serialize for StrokeId {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for StrokeId {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        StrokeId::parse(&s).ok_or_else(|| serde::de::Error::custom(format!("invalid stroke id {s:?}")))
    }
}

/// Which kind of device drew the stroke. Recognisers may treat finger ink
/// differently and it helps debugging palm rejection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum InputDevice {
    #[default]
    Pen,
    Mouse,
    Touch,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Stroke {
    pub id: StrokeId,
    pub brush: Brush,
    /// Wall clock time of the first sample, Unix epoch milliseconds. Sample
    /// times are relative to this, so stroke order and pauses between strokes
    /// (important for handwriting recognition) are preserved exactly.
    pub start_time: f64,
    pub device: InputDevice,
    pub points: Vec<InputPoint>,
    /// Strokes this one was cut from (e.g. by the eraser). Lets a recogniser
    /// invalidate exactly the text that changed.
    pub derived_from: Vec<StrokeId>,
    /// World units per input pixel when it was drawn (1 / zoom). Input
    /// noise, such as whole-pixel positions from the browser, is about one
    /// input pixel in size, so the smoothing scales with this.
    pub input_scale: f64,
    bounds: Rect,
}

impl Stroke {
    pub fn new(id: StrokeId, brush: Brush, start_time: f64, device: InputDevice, points: Vec<InputPoint>) -> Self {
        let mut s = Stroke {
            id,
            brush,
            start_time,
            device,
            points,
            derived_from: Vec::new(),
            input_scale: 1.0,
            bounds: Rect::EMPTY,
        };
        s.recompute_bounds();
        s
    }

    pub fn push(&mut self, p: InputPoint) {
        self.points.push(p);
        let r = self.brush.max_width() as f64 / 2.0;
        self.bounds = self.bounds.union(&Rect::new(p.pos() - Vec2::new(r, r), p.pos() + Vec2::new(r, r)));
    }

    pub fn recompute_bounds(&mut self) {
        let mut b = Rect::EMPTY;
        for p in &self.points {
            b.include(p.pos());
        }
        self.bounds = b.inflate(self.brush.max_width() as f64 / 2.0);
    }

    /// Conservative bounds including the brush radius.
    pub fn bounds(&self) -> Rect {
        self.bounds
    }

    pub fn duration_ms(&self) -> f64 {
        self.points.last().map(|p| p.t).unwrap_or(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_roundtrip() {
        let id = StrokeId(0xdead_beef_0000_0001);
        assert_eq!(id.to_string(), "deadbeef00000001");
        assert_eq!(StrokeId::parse(&id.to_string()), Some(id));
        assert_eq!(StrokeId::parse(""), None);
        assert_eq!(StrokeId::parse("xyz"), None);
        assert_eq!(StrokeId::parse("00000000000000001"), None);
    }

    #[test]
    fn bounds_include_brush_radius() {
        let mut s = Stroke::new(StrokeId(1), Brush::default(), 0.0, InputDevice::Pen, vec![]);
        assert!(s.bounds().is_empty());
        s.push(InputPoint::new(10.0, 10.0, 1.0));
        s.push(InputPoint::new(20.0, 10.0, 1.0));
        let r = Brush::default().max_width() as f64 / 2.0;
        assert_eq!(s.bounds().min, Vec2::new(10.0 - r, 10.0 - r));
        assert_eq!(s.bounds().max, Vec2::new(20.0 + r, 10.0 + r));
        let mut copy = s.clone();
        copy.recompute_bounds();
        assert_eq!(copy.bounds(), s.bounds());
    }
}
