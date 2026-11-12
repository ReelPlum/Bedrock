//! Small 2D geometry helpers. World coordinates are `f64` so the canvas can be
//! effectively infinite without losing precision far from the origin.

use serde::{Deserialize, Serialize};
use std::ops::{Add, Mul, Sub};

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
    pub fn length(self) -> f64 {
        self.x.hypot(self.y)
    }
    pub fn distance(self, o: Vec2) -> f64 {
        (self - o).length()
    }
    pub fn dot(self, o: Vec2) -> f64 {
        self.x * o.x + self.y * o.y
    }
    pub fn normalized(self) -> Vec2 {
        let l = self.length();
        if l > 1e-12 {
            Vec2::new(self.x / l, self.y / l)
        } else {
            Vec2::ZERO
        }
    }
    /// Counter-clockwise perpendicular.
    pub fn perp(self) -> Vec2 {
        Vec2::new(-self.y, self.x)
    }
    pub fn lerp(self, o: Vec2, t: f64) -> Vec2 {
        self + (o - self) * t
    }
}

impl Add for Vec2 {
    type Output = Vec2;
    fn add(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x + o.x, self.y + o.y)
    }
}
impl Sub for Vec2 {
    type Output = Vec2;
    fn sub(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x - o.x, self.y - o.y)
    }
}
impl Mul<f64> for Vec2 {
    type Output = Vec2;
    fn mul(self, s: f64) -> Vec2 {
        Vec2::new(self.x * s, self.y * s)
    }
}

/// Axis aligned rectangle. An "empty" rect has `min > max`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub min: Vec2,
    pub max: Vec2,
}

impl Rect {
    pub const EMPTY: Rect = Rect {
        min: Vec2 { x: f64::INFINITY, y: f64::INFINITY },
        max: Vec2 { x: f64::NEG_INFINITY, y: f64::NEG_INFINITY },
    };

    pub fn new(min: Vec2, max: Vec2) -> Self {
        Self { min, max }
    }
    pub fn is_empty(&self) -> bool {
        self.min.x > self.max.x || self.min.y > self.max.y
    }
    pub fn width(&self) -> f64 {
        (self.max.x - self.min.x).max(0.0)
    }
    pub fn height(&self) -> f64 {
        (self.max.y - self.min.y).max(0.0)
    }
    pub fn include(&mut self, p: Vec2) {
        self.min.x = self.min.x.min(p.x);
        self.min.y = self.min.y.min(p.y);
        self.max.x = self.max.x.max(p.x);
        self.max.y = self.max.y.max(p.y);
    }
    pub fn union(&self, o: &Rect) -> Rect {
        let mut r = *self;
        if !o.is_empty() {
            r.include(o.min);
            r.include(o.max);
        }
        r
    }
    pub fn inflate(&self, d: f64) -> Rect {
        if self.is_empty() {
            return *self;
        }
        Rect::new(self.min - Vec2::new(d, d), self.max + Vec2::new(d, d))
    }
    pub fn intersects(&self, o: &Rect) -> bool {
        !(self.is_empty()
            || o.is_empty()
            || self.max.x < o.min.x
            || o.max.x < self.min.x
            || self.max.y < o.min.y
            || o.max.y < self.min.y)
    }
    pub fn contains(&self, p: Vec2) -> bool {
        p.x >= self.min.x && p.x <= self.max.x && p.y >= self.min.y && p.y <= self.max.y
    }
}

/// Distance from `p` to the segment `a`..`b`.
pub fn point_segment_distance(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let ab = b - a;
    let len2 = ab.dot(ab);
    if len2 < 1e-18 {
        return p.distance(a);
    }
    let t = ((p - a).dot(ab) / len2).clamp(0.0, 1.0);
    p.distance(a + ab * t)
}

/// Minimum distance between two segments (0 when they cross).
pub fn segment_segment_distance(a: Vec2, b: Vec2, c: Vec2, d: Vec2) -> f64 {
    if segments_intersect(a, b, c, d) {
        return 0.0;
    }
    point_segment_distance(a, c, d)
        .min(point_segment_distance(b, c, d))
        .min(point_segment_distance(c, a, b))
        .min(point_segment_distance(d, a, b))
}

fn orient(a: Vec2, b: Vec2, c: Vec2) -> f64 {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

fn segments_intersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2) -> bool {
    let o1 = orient(a, b, c);
    let o2 = orient(a, b, d);
    let o3 = orient(c, d, a);
    let o4 = orient(c, d, b);
    (o1 * o2 < 0.0) && (o3 * o4 < 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_union_and_intersection() {
        let mut r = Rect::EMPTY;
        assert!(r.is_empty());
        r.include(Vec2::new(1.0, 2.0));
        r.include(Vec2::new(-1.0, 5.0));
        assert_eq!(r.min, Vec2::new(-1.0, 2.0));
        assert_eq!(r.max, Vec2::new(1.0, 5.0));
        assert!(r.intersects(&Rect::new(Vec2::new(0.0, 0.0), Vec2::new(3.0, 3.0))));
        assert!(!r.intersects(&Rect::new(Vec2::new(2.0, 0.0), Vec2::new(3.0, 3.0))));
        assert!(!r.intersects(&Rect::EMPTY));
    }

    #[test]
    fn segment_distances() {
        let d = point_segment_distance(Vec2::new(0.0, 1.0), Vec2::new(-1.0, 0.0), Vec2::new(1.0, 0.0));
        assert!((d - 1.0).abs() < 1e-9);
        // Crossing segments.
        let d = segment_segment_distance(
            Vec2::new(-1.0, 0.0),
            Vec2::new(1.0, 0.0),
            Vec2::new(0.0, -1.0),
            Vec2::new(0.0, 1.0),
        );
        assert_eq!(d, 0.0);
        let d = segment_segment_distance(
            Vec2::new(0.0, 0.0),
            Vec2::new(1.0, 0.0),
            Vec2::new(0.0, 2.0),
            Vec2::new(1.0, 2.0),
        );
        assert!((d - 2.0).abs() < 1e-9);
    }
}
